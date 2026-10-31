import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, todayIST, type DateString } from "@/lib/domain/fy";
import type { ClientStatus, ComplianceStatus, ComplianceType } from "@/lib/domain/enums";
import { clientChannels, clientRemindersPaused, documentDateToFlag, DOCUMENT_EXPIRY_LEAD_DAYS, isComplianceReminderDue } from "@/lib/domain/reminders";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { nextReminderOn } from "@/lib/schemas/document-requests";
import { notify } from "@/server/notify";

/**
 * Reminders, 09:00 IST daily (§8). The app sends no email: what the client should hear is put in
 * front of a person in-app, linked to where the WhatsApp message is ready.
 *   1. Compliance deadlines entering their `reminder_days` window (§7.7): the person on it (the
 *      linked task's assignee, else the client's owner; covers forwarded by notify, §4.7) gets an
 *      in-app reminder; for a statutory deadline of a client that takes WhatsApp reminders (its
 *      notify channels, else the firm's defaults) and isn't On hold or Inactive, it also says to
 *      remind the client on WhatsApp (the deadline's task has Ask on WhatsApp). Each deadline is
 *      reminded once per due date (`reminder_sent_at`, cleared when the date moves).
 *   2. Open document requests whose "Reminder every N days" has come round (§7.14) with something
 *      still pending or rejected: the request's creator is asked to send reminder N on WhatsApp
 *      from the request, where the message lists what is outstanding with the portal link. The
 *      cadence restarts.
 *   3. Documents whose expiry or renewal date is within 30 days (§7.14): one in-app notice to the
 *      client's owner per date.
 * The rest of §8's 09:00 reminders run as their own jobs right after this one, each with its own
 * job_runs row: register-expiries (DSC, registration and engagement-letter expiries, UDIN 60-day
 * warnings), notice-reminders (reply, hearing and appeal dates) and practice-reminders (peer
 * review, SA 230 assembly, KYC, DPDP requests and breaches, restore drills).
 *
 * Idempotent: every notice carries a dedupe key naming the record and its date or reminder number,
 * and the markers above are written after each record. A record that fails is logged with its Ref
 * and the run carries on (§8).
 */

const PAGE = 500;

type Counts = {
  compliance_checked: number;
  compliance_reminded: number;
  client_reminders_to_send: number;
  request_handoffs: number;
  documents_flagged: number;
  failed: number;
};

type ClientRow = {
  id: string;
  display_name: string;
  status: ClientStatus;
  deleted_at: string | null;
  owner_employee_id: string | null;
  notify_channels: string[];
};

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts: Counts = {
    compliance_checked: 0,
    compliance_reminded: 0,
    client_reminders_to_send: 0,
    request_handoffs: 0,
    documents_flagged: 0,
    failed: 0,
  };
  const today = todayIST(now);
  const { data: settings, error: settingsError } = await admin.from("firm_settings").select("client_notify_channels").eq("id", 1).maybeSingle();
  if (settingsError) throw settingsError;
  const firmChannels = settings?.client_notify_channels ?? ["whatsapp"];
  const ctx: JobContext = { admin, today, now, firmChannels, clients: new Map(), counts };

  await complianceReminders(ctx);
  await documentRequestReminders(ctx);
  await documentExpiries(ctx);
  return { counts };
}

interface JobContext {
  admin: AdminSupabase;
  today: DateString;
  now: Date;
  firmChannels: readonly string[];
  clients: Map<string, ClientRow | null>;
  counts: Counts;
}

async function loadClients(ctx: JobContext, ids: readonly (string | null)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id && !ctx.clients.has(id)))];
  if (!wanted.length) return;
  const { data, error } = await ctx.admin.from("clients").select("id, display_name, status, deleted_at, owner_employee_id, notify_channels").in("id", wanted);
  if (error) throw error;
  for (const id of wanted) ctx.clients.set(id, null);
  for (const c of (data ?? []) as ClientRow[]) ctx.clients.set(c.id, c);
}

// -------------------------------------------------------------------------------------------------
// 1. Compliance deadlines
// -------------------------------------------------------------------------------------------------

type EventRow = {
  id: string;
  client_id: string | null;
  type: ComplianceType;
  form_code: string | null;
  title: string;
  description: string | null;
  filing_period: string | null;
  financial_year: string | null;
  due_date: DateString;
  status: ComplianceStatus;
  is_statutory: boolean;
  reminder_days: number;
  reminder_sent_at: string | null;
  task_id: string | null;
};

async function complianceReminders(ctx: JobContext): Promise<void> {
  // Reminder windows are at most 90 days (due_date_rules / Settings → Reminders), so anything due
  // within that horizon is a candidate; isComplianceReminderDue decides.
  const horizon = addDays(ctx.today, 90);
  // Keyset pages by (due_date, id): marking rows reminded mid-run doesn't shift the next page.
  let after: { due: string; id: string } | null = null;
  for (;;) {
    let q = ctx.admin
      .from("compliance_events")
      .select("id, client_id, type, form_code, title, description, filing_period, financial_year, due_date, status, is_statutory, reminder_days, reminder_sent_at, task_id")
      .eq("status", "pending")
      .is("reminder_sent_at", null)
      .gte("due_date", ctx.today)
      .lte("due_date", horizon);
    if (after) q = q.or(`due_date.gt.${after.due},and(due_date.eq.${after.due},id.gt.${after.id})`);
    const { data, error } = await q.order("due_date").order("id").limit(PAGE);
    if (error) throw error;
    const all = (data ?? []) as EventRow[];
    if (all.length) after = { due: all[all.length - 1].due_date, id: all[all.length - 1].id };
    const page = all.filter((e) => isComplianceReminderDue({ status: e.status, dueDate: e.due_date, reminderDays: e.reminder_days, reminderSentAt: e.reminder_sent_at }, ctx.today));
    await loadClients(ctx, page.map((e) => e.client_id));
    const taskIds = page.map((e) => e.task_id).filter((t): t is string => !!t);
    const { data: tasks, error: tasksError } = taskIds.length
      ? await ctx.admin.from("tasks").select("id, assigned_employee_id, deleted_at").in("id", taskIds)
      : { data: [] as Array<{ id: string; assigned_employee_id: string | null; deleted_at: string | null }>, error: null };
    if (tasksError) throw tasksError;
    const assignee = new Map((tasks ?? []).filter((t) => !t.deleted_at).map((t) => [t.id, t.assigned_employee_id]));

    for (const e of page) {
      ctx.counts.compliance_checked++;
      try {
        const client = e.client_id ? (ctx.clients.get(e.client_id) ?? null) : null;
        if (e.client_id && (!client || client.deleted_at)) {
          await markReminded(ctx, e.id);
          continue;
        }
        const label = e.form_code ?? e.title;
        const period = e.filing_period ?? (e.financial_year ? `FY ${e.financial_year}` : "");
        const who = (e.task_id ? assignee.get(e.task_id) : null) ?? client?.owner_employee_id ?? null;
        // The client hears about it on WhatsApp, from a person (§7.13.2): this notice says so.
        const remindClient =
          Boolean(client) && e.is_statutory && !clientRemindersPaused({ status: client!.status, deletedAt: client!.deleted_at }) && clientChannels(client!.notify_channels, ctx.firmChannels).includes("whatsapp");
        await notify({
          to: who ? { employeeIds: [who] } : { roles: ["partner"] },
          type: "compliance_due",
          title: `${label}${period ? ` for ${period}` : ""} is due ${formatDate(e.due_date)}`,
          body: client
            ? `${client.display_name}: ${e.title}.${remindClient ? ` Remind them on WhatsApp if you still need anything${e.task_id ? ": Ask on WhatsApp on the deadline's task has the message ready." : ", from their page."}` : ""}`
            : `Firm deadline: ${e.title}.`,
          linkUrl: remindClient && !e.task_id && client ? `/clients/${client.id}` : `/calendar?event=${e.id}`,
          entity: { type: "compliance_event", id: e.id },
          clientId: e.client_id,
          dedupeKey: `compliance_due:${e.id}:${e.due_date}`,
        });
        if (remindClient) ctx.counts.client_reminders_to_send++;
        await markReminded(ctx, e.id);
        ctx.counts.compliance_reminded++;
      } catch (err) {
        ctx.counts.failed++;
        logUnexpected(err, { source: "job:reminders:compliance", eventId: e.id, clientId: e.client_id });
      }
    }
    if (all.length < PAGE) break;
  }
}

async function markReminded(ctx: JobContext, eventId: string): Promise<void> {
  const { error } = await ctx.admin.from("compliance_events").update({ reminder_sent_at: ctx.now.toISOString() }).eq("id", eventId).is("reminder_sent_at", null);
  if (error) throw error;
}

// -------------------------------------------------------------------------------------------------
// 2. Document request cadence
// -------------------------------------------------------------------------------------------------

type RequestRow = {
  id: string;
  client_id: string;
  title: string;
  status: "open" | "completed" | "cancelled";
  created_at: string;
  created_by: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  reminder_every_days: number;
  document_request_items: Array<{ status: string }> | null;
};

async function documentRequestReminders(ctx: JobContext): Promise<void> {
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await ctx.admin
      .from("document_requests")
      .select("id, client_id, title, status, created_at, created_by, last_reminded_at, reminder_count, reminder_every_days, document_request_items(status)")
      .eq("status", "open")
      .order("created_at")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as RequestRow[];
    await loadClients(ctx, rows.map((r) => r.client_id));
    for (const r of rows) {
      try {
        const items = r.document_request_items ?? [];
        const outstanding = items.filter((i) => i.status === "pending" || i.status === "rejected");
        const due = nextReminderOn({ status: r.status, lastRemindedAt: r.last_reminded_at, createdAt: r.created_at, everyDays: r.reminder_every_days, outstanding: outstanding.length });
        if (!due || due > ctx.today) continue;
        const client = ctx.clients.get(r.client_id) ?? null;
        if (!client || clientRemindersPaused({ status: client.status, deletedAt: client.deleted_at })) continue;

        // Ask the person who made the request to send it on WhatsApp.
        const n = r.reminder_count + 1;
        const { data: maker } = r.created_by ? await ctx.admin.from("profiles").select("id, role, is_active").eq("id", r.created_by).maybeSingle() : { data: null };
        const to = maker && maker.is_active && maker.role !== "client" ? { userIds: [maker.id] } : client.owner_employee_id ? { employeeIds: [client.owner_employee_id] } : { roles: ["manager" as const] };
        await notify({
          to,
          type: "info",
          title: `Remind ${client.display_name} about "${r.title}" on WhatsApp`,
          body: `${outstanding.length} ${outstanding.length === 1 ? "item is" : "items are"} still outstanding. Send reminder ${n} on WhatsApp from the request: the message lists what's missing, with the upload link.`,
          linkUrl: `/clients/${client.id}?tab=documents&docs=requests&request=${r.id}`,
          entity: { type: "document_request", id: r.id },
          clientId: client.id,
          dedupeKey: `document_request:${r.id}:reminder:${n}`,
        });
        ctx.counts.request_handoffs++;
        const { error: updateError } = await ctx.admin
          .from("document_requests")
          .update({ last_reminded_at: ctx.now.toISOString(), reminder_count: n })
          .eq("id", r.id)
          .eq("reminder_count", r.reminder_count);
        if (updateError) throw updateError;
      } catch (err) {
        ctx.counts.failed++;
        logUnexpected(err, { source: "job:reminders:document_request", requestId: r.id, clientId: r.client_id });
      }
    }
    if (rows.length < PAGE) break;
  }
}

// -------------------------------------------------------------------------------------------------
// 3. Document expiry and renewal dates
// -------------------------------------------------------------------------------------------------

async function documentExpiries(ctx: JobContext): Promise<void> {
  const horizon = addDays(ctx.today, DOCUMENT_EXPIRY_LEAD_DAYS);
  const { data, error } = await ctx.admin
    .from("documents")
    .select("id, client_id, title, expiry_date, renewal_date")
    .is("deleted_at", null)
    .or(`and(expiry_date.gte.${ctx.today},expiry_date.lte.${horizon}),and(renewal_date.gte.${ctx.today},renewal_date.lte.${horizon})`)
    .limit(2000);
  if (error) throw error;
  const rows = data ?? [];
  await loadClients(ctx, rows.map((d) => d.client_id));
  for (const d of rows) {
    try {
      const flag = documentDateToFlag({ expiryDate: d.expiry_date, renewalDate: d.renewal_date }, ctx.today);
      const client = ctx.clients.get(d.client_id) ?? null;
      if (!flag || !client || client.deleted_at) continue;
      await notify({
        to: client.owner_employee_id ? { employeeIds: [client.owner_employee_id] } : { roles: ["manager"] },
        type: "expiry_alert",
        title: `${d.title} ${flag.kind === "expiry" ? "expires" : "is due for renewal"} on ${formatDate(flag.date)}`,
        body: `${client.display_name}: arrange the ${flag.kind === "expiry" ? "replacement" : "renewal"} and upload the new copy to the vault.`,
        linkUrl: `/clients/${client.id}?tab=documents&doc=${d.id}`,
        entity: { type: "document", id: d.id },
        clientId: client.id,
        dedupeKey: `document_${flag.kind}:${d.id}:${flag.date}`,
      });
      ctx.counts.documents_flagged++;
    } catch (err) {
      ctx.counts.failed++;
      logUnexpected(err, { source: "job:reminders:document_expiry", documentId: d.id });
    }
  }
}

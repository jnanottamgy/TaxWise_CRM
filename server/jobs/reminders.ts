import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { env } from "@/lib/env";
import { addDays, todayIST, type DateString } from "@/lib/domain/fy";
import type { ClientStatus, ComplianceStatus, ComplianceType } from "@/lib/domain/enums";
import { pickContactForService } from "@/lib/domain/messaging";
import { clientChannels, clientRemindersPaused, complianceServiceType, documentDateToFlag, DOCUMENT_EXPIRY_LEAD_DAYS, isComplianceReminderDue } from "@/lib/domain/reminders";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { nextReminderOn, requestPortalPath } from "@/lib/schemas/document-requests";
import { notify } from "@/server/notify";
import { sendEmail } from "@/server/email/send";
import { emailFirm, type EmailFirm } from "@/server/email/templates/layout";
import { complianceReminderEmail, documentRequestEmail } from "@/server/email/templates";
import { getFirmProfile } from "@/server/firm";

/**
 * Reminders, 09:00 IST daily (§8):
 *   1. Compliance deadlines entering their `reminder_days` window (§7.7): the person on it (the
 *      linked task's assignee, else the client's owner; covers forwarded by notify, §4.7) gets an
 *      in-app reminder, and the client gets the compliance reminder email (§10.12) at the contact
 *      who handles that service, when "email" is one of its notify channels (its own, or the firm's
 *      defaults) and it isn't On hold or Inactive. Each deadline is reminded once per due date
 *      (`reminder_sent_at`, cleared when the date moves).
 *   2. Open document requests whose "Reminder every N days" has come round (§7.14) with something
 *      still pending or rejected: the reminder email lists what is outstanding with the portal link;
 *      when email can't go (domain not verified, no address) the request's creator is asked to send
 *      it by WhatsApp or Gmail instead. Either way the cadence restarts.
 *   3. Documents whose expiry or renewal date is within 30 days (§7.14): one in-app notice to the
 *      client's owner per date.
 * DSC, registration, engagement-letter, peer-review, notice and UDIN reminders join this job with
 * their modules (§7.15).
 *
 * Idempotent: every notice carries a dedupe key and every email an idempotency key naming the
 * record and its date or reminder number, and the markers above are written after each record. A
 * record that fails is logged with its Ref and the run carries on (§8).
 */

const PAGE = 500;

type Counts = {
  compliance_checked: number;
  compliance_reminded: number;
  client_emails: number;
  client_emails_not_configured: number;
  request_reminders: number;
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
  portal_user_id: string | null;
  email: string | null;
};

type ContactRow = { id: string; client_id: string; name: string; email: string | null; email_bounced: boolean; handles: string[] | null; is_primary: boolean };

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts: Counts = {
    compliance_checked: 0,
    compliance_reminded: 0,
    client_emails: 0,
    client_emails_not_configured: 0,
    request_reminders: 0,
    request_handoffs: 0,
    documents_flagged: 0,
    failed: 0,
  };
  const today = todayIST(now);
  const { data: settings, error: settingsError } = await admin.from("firm_settings").select("client_notify_channels").eq("id", 1).maybeSingle();
  if (settingsError) throw settingsError;
  const firmChannels = settings?.client_notify_channels ?? ["email", "whatsapp"];
  const firm = emailFirm(await getFirmProfile(admin));
  const ctx: JobContext = { admin, today, now, firm, firmChannels, base: env.appUrl().replace(/\/+$/, ""), clients: new Map(), contacts: new Map(), names: new Map(), counts };

  await complianceReminders(ctx);
  await documentRequestReminders(ctx);
  await documentExpiries(ctx);
  return { counts };
}

interface JobContext {
  admin: AdminSupabase;
  today: DateString;
  now: Date;
  firm: EmailFirm;
  firmChannels: readonly string[];
  base: string;
  clients: Map<string, ClientRow | null>;
  contacts: Map<string, ContactRow[]>;
  names: Map<string, string>;
  counts: Counts;
}

async function loadClients(ctx: JobContext, ids: readonly (string | null)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id && !ctx.clients.has(id)))];
  if (!wanted.length) return;
  const { data, error } = await ctx.admin
    .from("clients")
    .select("id, display_name, status, deleted_at, owner_employee_id, notify_channels, portal_user_id, email")
    .in("id", wanted);
  if (error) throw error;
  for (const id of wanted) ctx.clients.set(id, null);
  for (const c of (data ?? []) as ClientRow[]) ctx.clients.set(c.id, c);
}

async function contactsOf(ctx: JobContext, clientId: string): Promise<ContactRow[]> {
  const cached = ctx.contacts.get(clientId);
  if (cached) return cached;
  const { data, error } = await ctx.admin
    .from("client_contacts")
    .select("id, client_id, name, email, email_bounced, handles, is_primary")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  const rows = (data ?? []) as ContactRow[];
  ctx.contacts.set(clientId, rows);
  return rows;
}

async function employeeName(ctx: JobContext, employeeId: string | null): Promise<string | null> {
  if (!employeeId) return null;
  if (ctx.names.has(employeeId)) return ctx.names.get(employeeId) ?? null;
  const { data, error } = await ctx.admin.from("employees").select("full_name").eq("id", employeeId).maybeSingle();
  if (error) throw error;
  ctx.names.set(employeeId, data?.full_name ?? "");
  return data?.full_name ?? null;
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
        await notify({
          to: who ? { employeeIds: [who] } : { roles: ["partner"] },
          type: "compliance_due",
          title: `${label}${period ? ` for ${period}` : ""} is due ${formatDate(e.due_date)}`,
          body: client ? `${client.display_name}: ${e.title}.` : `Firm deadline: ${e.title}.`,
          linkUrl: `/calendar?event=${e.id}`,
          entity: { type: "compliance_event", id: e.id },
          clientId: e.client_id,
          dedupeKey: `compliance_due:${e.id}:${e.due_date}`,
        });

        if (client && e.is_statutory && !clientRemindersPaused({ status: client.status, deletedAt: client.deleted_at }) && clientChannels(client.notify_channels, ctx.firmChannels).includes("email")) {
          await emailComplianceReminder(ctx, e, client, label, period);
        }
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

async function emailComplianceReminder(ctx: JobContext, e: EventRow, client: ClientRow, label: string, period: string): Promise<void> {
  const contacts = (await contactsOf(ctx, client.id)).filter((c) => c.email && !c.email_bounced);
  const contact = pickContactForService(
    contacts.map((c) => ({ ...c, isPrimary: c.is_primary })),
    complianceServiceType(e.type),
  );
  const to = contact?.email ?? client.email;
  if (!to) return;
  const [ownerName, outstanding] = await Promise.all([employeeName(ctx, client.owner_employee_id), outstandingItems(ctx, client.id)]);
  const mail = complianceReminderEmail(
    {
      contactName: contact?.name ?? client.display_name,
      clientName: client.display_name,
      complianceLabel: label,
      period,
      explanation: e.form_code && e.title !== e.form_code ? e.title : null,
      dueDate: e.due_date,
      today: ctx.today,
      whatWeNeed: outstanding,
      portalUrl: client.portal_user_id ? `${ctx.base}/portal/documents` : null,
      ownerName: ownerName || ctx.firm.firmName,
    },
    ctx.firm,
  );
  const r = await sendEmail({
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    kind: "compliance_reminder",
    clientId: client.id,
    contactId: contact?.id ?? null,
    related: { type: "compliance_event", id: e.id },
    idempotencyKey: `compliance_reminder:${e.id}:${e.due_date}`,
  });
  if (r.status === "sent") ctx.counts.client_emails++;
  else if (r.status === "not_configured") ctx.counts.client_emails_not_configured++;
  else throw new Error(r.error ?? "compliance reminder email failed");
}

/** What the client still owes across its open document requests (pending or sent back), for "What we need from you". */
async function outstandingItems(ctx: JobContext, clientId: string): Promise<string[]> {
  const { data, error } = await ctx.admin
    .from("document_requests")
    .select("id, document_request_items(title, status, is_required)")
    .eq("client_id", clientId)
    .eq("status", "open")
    .limit(20);
  if (error) throw error;
  const out: string[] = [];
  for (const r of data ?? []) {
    for (const i of (r.document_request_items as Array<{ title: string; status: string; is_required: boolean }> | null) ?? []) {
      if ((i.status === "pending" || i.status === "rejected") && !out.includes(i.title)) out.push(i.title);
    }
  }
  return out.slice(0, 10);
}

// -------------------------------------------------------------------------------------------------
// 2. Document request cadence
// -------------------------------------------------------------------------------------------------

type RequestRow = {
  id: string;
  client_id: string;
  contact_id: string | null;
  title: string;
  notes: string | null;
  due_date: string | null;
  status: "open" | "completed" | "cancelled";
  created_at: string;
  created_by: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  reminder_every_days: number;
  document_request_items: Array<{ title: string; help_text: string | null; status: string; rejection_reason: string | null; is_required: boolean }> | null;
};

async function documentRequestReminders(ctx: JobContext): Promise<void> {
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await ctx.admin
      .from("document_requests")
      .select("id, client_id, contact_id, title, notes, due_date, status, created_at, created_by, last_reminded_at, reminder_count, reminder_every_days, document_request_items(title, help_text, status, rejection_reason, is_required)")
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

        const n = r.reminder_count + 1;
        const sent = await emailRequestReminder(ctx, r, client, outstanding, n);
        if (sent === "failed") {
          ctx.counts.failed++;
          continue; // tried again tomorrow; the idempotency key stops a double send
        }
        if (sent === "sent") ctx.counts.request_reminders++;
        else {
          // No email could go: ask the person who made the request to send it by hand.
          const { data: maker } = r.created_by ? await ctx.admin.from("profiles").select("id, role, is_active").eq("id", r.created_by).maybeSingle() : { data: null };
          const to = maker && maker.is_active && maker.role !== "client" ? { userIds: [maker.id] } : client.owner_employee_id ? { employeeIds: [client.owner_employee_id] } : { roles: ["manager" as const] };
          await notify({
            to,
            type: "info",
            title: `Remind ${client.display_name} about "${r.title}"`,
            body: `${outstanding.length} ${outstanding.length === 1 ? "item is" : "items are"} still outstanding. Email can't go automatically${sent === "no_recipient" ? " (no email address for this client)" : " (the email domain isn't verified yet)"}: send reminder ${n} by WhatsApp or Gmail from the request.`,
            linkUrl: `/clients/${client.id}?tab=documents&docs=requests&request=${r.id}`,
            entity: { type: "document_request", id: r.id },
            clientId: client.id,
            dedupeKey: `document_request:${r.id}:reminder:${n}`,
          });
          ctx.counts.request_handoffs++;
        }
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

async function emailRequestReminder(ctx: JobContext, r: RequestRow, client: ClientRow, outstanding: NonNullable<RequestRow["document_request_items"]>, n: number): Promise<"sent" | "not_configured" | "no_recipient" | "failed"> {
  const contacts = (await contactsOf(ctx, client.id)).filter((c) => c.email && !c.email_bounced);
  const chosen = (r.contact_id ? contacts.find((c) => c.id === r.contact_id) : null) ?? contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
  const to = chosen?.email ?? client.email;
  if (!to) return "no_recipient";
  const { data: maker } = r.created_by ? await ctx.admin.from("profiles").select("full_name").eq("id", r.created_by).maybeSingle() : { data: null };
  const mail = documentRequestEmail(
    {
      recipientName: chosen?.name ?? client.display_name,
      clientName: client.display_name,
      title: r.title,
      items: outstanding.map((i) => ({ title: i.title, helpText: i.help_text, status: i.status as "pending" | "rejected", rejectionReason: i.rejection_reason, required: i.is_required })),
      dueDate: r.due_date,
      uploadUrl: `${ctx.base}${requestPortalPath(r.id)}`,
      notes: r.notes,
      senderName: maker?.full_name ?? ctx.firm.firmName,
      reminderNumber: n,
    },
    ctx.firm,
  );
  const res = await sendEmail({
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    kind: "document_request_reminder",
    clientId: client.id,
    contactId: chosen?.id ?? null,
    related: { type: "document_request", id: r.id },
    idempotencyKey: `document_request:${r.id}:reminder:${n}`,
  });
  if (res.status === "failed") logUnexpected(new Error(res.error ?? "document request reminder failed"), { source: "job:reminders:document_request:email", requestId: r.id });
  return res.status;
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

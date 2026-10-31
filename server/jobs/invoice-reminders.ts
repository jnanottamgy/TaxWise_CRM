import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { istDayBounds, todayIST, type DateString } from "@/lib/domain/fy";
import { formatINR, toPaise } from "@/lib/domain/money";
import type { ClientStatus, InvoiceStatus } from "@/lib/domain/enums";
import { NO_WHATSAPP_NUMBER_MESSAGE, normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import { decideInvoiceReminder, reminderDueDateWindow, reminderSettingsFrom, reminderSlotLabel, type ReminderSettings } from "@/lib/domain/collections";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { notify } from "@/server/notify";

/**
 * Invoice reminders, 10:00 IST daily (§7.9.5, §8):
 *
 * 1. Payment reminders: 3 days before the due date (gentle), then 1, 7 and 15 days after it
 *    (firmer), per Settings → Reminders. Never for Draft, Awaiting approval, Disputed, Waived,
 *    Paid or cancelled invoices, nothing outstanding, or clients On hold or Inactive
 *    (lib/domain/collections.ts decideInvoiceReminder). A slot missed by a skipped run still goes
 *    within 3 days; older ones wait for the next slot, so a client never gets two at once.
 *    The app sends no email: each reminder that falls due becomes a WhatsApp task ("To send") for
 *    the client's owner when a Partner or Manager, else the invoice's raiser (never an Employee,
 *    §4.1), with an in-app notice deep-linked to the invoice's Collections panel, where Send on
 *    WhatsApp has the reminder filled in and the invoice PDF ready. One row per slot in
 *    invoice_reminders (unique per invoice and slot) records it.
 * 2. Follow-ups due today (the "next follow-up" on the follow-up log): the person who logged it is
 *    reminded, while the invoice still has a balance.
 *
 * Idempotent; a record that fails is logged with its Ref and counted, and the run carries on.
 */

const PAGE = 500;

type InvoiceRow = {
  id: string;
  invoice_number: string | null;
  client_id: string;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  outstanding_amount: number;
  service_type: string | null;
  created_by: string;
  cancelled_at: string | null;
  clients: { display_name: string; status: ClientStatus; deleted_at: string | null; phone: string | null; whatsapp: string | null; owner_employee_id: string | null } | null;
};

type ContactRow = { id: string; client_id: string; phone: string | null; whatsapp: string | null; is_primary: boolean };

type Counts = Record<string, number> & { checked: number; handoffs: number; not_due: number; already_done: number; failed: number; follow_ups_due: number };

interface Ctx {
  admin: AdminSupabase;
  today: DateString;
  settings: ReminderSettings;
  contacts: Map<string, ContactRow[]>;
  moneyPeople: Map<string, string | null>;
  counts: Counts;
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts: Counts = { checked: 0, handoffs: 0, not_due: 0, already_done: 0, failed: 0, follow_ups_due: 0 };
  const today = todayIST(now);
  const { data: fs, error: fsError } = await admin.from("firm_settings").select("invoice_reminder_before_days, invoice_reminder_after_days").eq("id", 1).maybeSingle();
  if (fsError) throw fsError;
  const settings = reminderSettingsFrom(fs);
  const ctx: Ctx = {
    admin,
    today,
    settings,
    contacts: new Map(),
    moneyPeople: new Map(),
    counts,
  };

  await paymentReminders(ctx);
  await followUpsDue(ctx);
  return { counts };
}

/** The profile id of a Partner or Manager behind an employee row (owners), or null. */
async function moneyPersonForEmployee(ctx: Ctx, employeeId: string | null): Promise<string | null> {
  if (!employeeId) return null;
  const key = `e:${employeeId}`;
  if (ctx.moneyPeople.has(key)) return ctx.moneyPeople.get(key) ?? null;
  const { data, error } = await ctx.admin.from("employees").select("is_active, profile_id, profiles(role, is_active)").eq("id", employeeId).maybeSingle();
  if (error) throw error;
  const e = data as unknown as { is_active: boolean; profile_id: string | null; profiles: { role: string; is_active: boolean } | null } | null;
  const ok = e && e.is_active && e.profile_id && e.profiles?.is_active && (e.profiles.role === "partner" || e.profiles.role === "manager");
  ctx.moneyPeople.set(key, ok ? e!.profile_id : null);
  return ok ? e!.profile_id : null;
}

/** A profile id if it is an active Partner or Manager, else null. */
async function moneyPersonForProfile(ctx: Ctx, profileId: string | null): Promise<string | null> {
  if (!profileId) return null;
  const key = `p:${profileId}`;
  if (ctx.moneyPeople.has(key)) return ctx.moneyPeople.get(key) ?? null;
  const { data, error } = await ctx.admin.from("profiles").select("role, is_active").eq("id", profileId).maybeSingle();
  if (error) throw error;
  const ok = data && data.is_active && (data.role === "partner" || data.role === "manager");
  ctx.moneyPeople.set(key, ok ? profileId : null);
  return ok ? profileId : null;
}

async function contactsOf(ctx: Ctx, clientId: string): Promise<ContactRow[]> {
  const cached = ctx.contacts.get(clientId);
  if (cached) return cached;
  const { data, error } = await ctx.admin
    .from("client_contacts")
    .select("id, client_id, phone, whatsapp, is_primary")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  const rows = (data ?? []) as ContactRow[];
  ctx.contacts.set(clientId, rows);
  return rows;
}

async function paymentReminders(ctx: Ctx): Promise<void> {
  const window = reminderDueDateWindow(ctx.today, ctx.settings);
  let after: { due: string; id: string } | null = null;
  for (;;) {
    let q = ctx.admin
      .from("invoices")
      .select("id, invoice_number, client_id, issue_date, due_date, status, outstanding_amount, service_type, created_by, cancelled_at, clients!inner(display_name, status, deleted_at, phone, whatsapp, owner_employee_id)")
      .is("deleted_at", null)
      .not("invoice_number", "is", null)
      .not("status", "in", "(draft,awaiting_approval)")
      .gte("due_date", window.from)
      .lte("due_date", window.to);
    if (after) q = q.or(`due_date.gt.${after.due},and(due_date.eq.${after.due},id.gt.${after.id})`);
    const { data, error } = await q.order("due_date").order("id").limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []) as unknown as InvoiceRow[];
    if (!rows.length) break;
    after = { due: rows[rows.length - 1].due_date, id: rows[rows.length - 1].id };

    const { data: existing, error: exError } = await ctx.admin.from("invoice_reminders").select("invoice_id, reminder_key").in("invoice_id", rows.map((r) => r.id)).not("reminder_key", "is", null);
    if (exError) throw exError;
    const done = new Map<string, string[]>();
    for (const e of existing ?? []) done.set(e.invoice_id, [...(done.get(e.invoice_id) ?? []), e.reminder_key as string]);

    for (const inv of rows) {
      ctx.counts.checked++;
      try {
        await remindOne(ctx, inv, done.get(inv.id) ?? []);
      } catch (err) {
        ctx.counts.failed++;
        logUnexpected(err, { source: "job:invoice-reminders", invoiceId: inv.id });
      }
    }
    if (rows.length < PAGE) break;
  }
}

async function remindOne(ctx: Ctx, inv: InvoiceRow, doneKeys: string[]): Promise<void> {
  const client = inv.clients;
  if (!client || client.deleted_at) return;
  const outstandingPaise = toPaise(inv.outstanding_amount);
  const decision = decideInvoiceReminder({
    status: inv.status,
    outstandingPaise,
    clientStatus: client.status,
    cancelled: Boolean(inv.cancelled_at),
    dueDate: inv.due_date,
    today: ctx.today,
    doneKeys,
    settings: ctx.settings,
  });
  if (decision.action === "skip") {
    const k = `skipped_${decision.reason}`;
    ctx.counts[k] = (ctx.counts[k] ?? 0) + 1;
    return;
  }
  if (decision.action === "wait") {
    ctx.counts.not_due++;
    return;
  }

  const { slot, stage, days } = decision;
  const contacts = await contactsOf(ctx, inv.client_id);
  const scheduledFor = `${slot.date}T10:00:00+05:30`;

  // A WhatsApp task for a Partner or Manager: the app sends nothing itself.
  const owner = (await moneyPersonForEmployee(ctx, client.owner_employee_id)) ?? (await moneyPersonForProfile(ctx, inv.created_by));
  const number = contacts.map((c) => normalizeWhatsAppNumber(c.whatsapp ?? c.phone)).find(Boolean) ?? normalizeWhatsAppNumber(client.whatsapp ?? client.phone);
  const { error } = await ctx.admin.from("invoice_reminders").insert({
    invoice_id: inv.id,
    kind: slot.kind,
    reminder_key: slot.key,
    offset_days: slot.offsetDays,
    due_date: inv.due_date,
    scheduled_for: scheduledFor,
    channel: "whatsapp_handoff",
    status: "handoff_pending",
    owner_user_id: owner,
    error: number ? null : NO_WHATSAPP_NUMBER_MESSAGE,
  });
  if (error?.code === "23505") {
    ctx.counts.already_done++;
    return;
  }
  if (error) throw error;
  ctx.counts.handoffs++;

  const when = stage === "before" ? `due ${formatDate(inv.due_date)}` : `${days} ${days === 1 ? "day" : "days"} overdue`;
  await notify({
    to: owner ? { userIds: [owner] } : { roles: ["partner"] },
    type: "info",
    title: `Send a payment reminder on WhatsApp for invoice ${inv.invoice_number}`,
    body: `${client.display_name}: ${formatINR(outstandingPaise)}, ${when} (${reminderSlotLabel(slot.key).toLowerCase()}). ${
      number ? "The message and the invoice PDF are ready on the invoice." : `${NO_WHATSAPP_NUMBER_MESSAGE} Then the message and the invoice PDF are ready on the invoice.`
    }`,
    linkUrl: `/invoices/${inv.id}#collections`,
    entity: { type: "invoice", id: inv.id },
    clientId: inv.client_id,
    dedupeKey: `invoice_reminder:${inv.id}:${slot.key}`,
  });
}

async function followUpsDue(ctx: Ctx): Promise<void> {
  const { start, end } = istDayBounds(ctx.today);
  const { data, error } = await ctx.admin
    .from("invoice_follow_ups")
    .select("id, invoice_id, by_user, notes, invoices!inner(invoice_number, status, outstanding_amount, deleted_at, cancelled_at, client_id, clients(display_name))")
    .gte("next_follow_up_at", start.toISOString())
    .lt("next_follow_up_at", end.toISOString())
    .limit(1000);
  if (error) throw error;
  for (const f of (data ?? []) as unknown as Array<{
    id: string;
    invoice_id: string;
    by_user: string;
    notes: string;
    invoices: { invoice_number: string | null; status: InvoiceStatus; outstanding_amount: number; deleted_at: string | null; cancelled_at: string | null; client_id: string; clients: { display_name: string } | null };
  }>) {
    try {
      const inv = f.invoices;
      if (inv.deleted_at || inv.cancelled_at || !["sent", "partially_paid", "disputed"].includes(inv.status) || toPaise(inv.outstanding_amount) <= 0) continue;
      const person = await moneyPersonForProfile(ctx, f.by_user);
      await notify({
        to: person ? { userIds: [person] } : { roles: ["partner"] },
        type: "info",
        title: `Follow up on invoice ${inv.invoice_number} today`,
        body: `${inv.clients?.display_name ?? "The client"}: ${formatINR(toPaise(inv.outstanding_amount))} outstanding. Last note: ${f.notes.slice(0, 160)}`,
        linkUrl: `/invoices/${f.invoice_id}#collections`,
        entity: { type: "invoice", id: f.invoice_id },
        clientId: inv.client_id,
        dedupeKey: `invoice_follow_up:${f.id}:${ctx.today}`,
      });
      ctx.counts.follow_ups_due++;
    } catch (err) {
      ctx.counts.failed++;
      logUnexpected(err, { source: "job:invoice-reminders:follow-ups", followUpId: f.id });
    }
  }
}

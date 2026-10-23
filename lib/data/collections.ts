import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { fetchAll } from "@/server/compliance/engine";
import { istDateOf, type DateString } from "@/lib/domain/fy";
import { toPaise, type Paise } from "@/lib/domain/money";
import { PAYMENT_METHOD_LABELS, isEnumValue, type ClientStatus, type InvoiceStatus, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums";
import { statementEvents, type StatementEvent } from "@/lib/domain/collections";
import type { FollowUpChannel, RetainerQueueState } from "@/lib/schemas/collections";

/**
 * Reads for collections (§7.9.5, §7.9.6, §11), under the caller's session: RLS gives Partners and
 * Managers the money tables and nobody else (§4.1), so an Employee or a portal user gets nothing.
 *
 *   getInvoiceCollections   the follow-up log, reminders and promise of one invoice (the panel the
 *                           invoice page embeds)
 *   listRetainerQueue       the retainer job's drafts, filtered, sorted and paged in SQL
 *   listRetainerRuns        the latest runs with their counts and cap reports
 *   getStatementData        every movement of one or more clients up to a date (statement of account)
 */

// =================================================================================================
// One invoice's collections (§7.9.5)
// =================================================================================================

export type FollowUpRow = {
  id: string;
  channel: FollowUpChannel;
  notes: string;
  promisedPaymentDate: DateString | null;
  nextFollowUpAt: string | null;
  byName: string | null;
  createdAt: string;
};

export type ReminderRow = {
  id: string;
  kind: string;
  reminderKey: string | null;
  dueDate: DateString | null;
  channel: string;
  status: string;
  sentAt: string | null;
  recipient: string | null;
  error: string | null;
  ownerName: string | null;
  ownerUserId: string | null;
  handedOffAt: string | null;
  dismissedAt: string | null;
  dismissReason: string | null;
  createdAt: string;
};

export type CollectionsContact = { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null; primary: boolean; bounced: boolean };

export type InvoiceCollections = {
  invoice: {
    id: string;
    number: string | null;
    status: InvoiceStatus;
    cancelled: boolean;
    issueDate: DateString;
    dueDate: DateString;
    totalPaise: Paise;
    outstandingPaise: Paise;
    clientId: string;
    clientName: string;
    clientStatus: ClientStatus;
    clientEmail: string | null;
    clientPhone: string | null;
    clientWhatsapp: string | null;
  };
  followUps: FollowUpRow[];
  reminders: ReminderRow[];
  promise: { date: DateString; promisedPaise: Paise; status: "kept" | "missed" | "open"; settledSincePaise: Paise } | null;
  contacts: CollectionsContact[];
};

async function namesOf(supabase: ServerSupabase, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", wanted);
  if (error) throw error;
  for (const p of data ?? []) out.set(p.id, p.full_name);
  return out;
}

/** The invoice's follow-up log, reminders and latest promise; null when the caller can't see the invoice. */
export async function getInvoiceCollections(supabase: ServerSupabase, invoiceId: string): Promise<InvoiceCollections | null> {
  const { data: inv, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, cancelled_at, issue_date, due_date, total_amount, outstanding_amount, client_id, clients!inner(display_name, status, email, phone, whatsapp)")
    .eq("id", invoiceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!inv) return null;
  const client = (inv as unknown as { clients: { display_name: string; status: ClientStatus; email: string | null; phone: string | null; whatsapp: string | null } }).clients;

  const [followUps, reminders, promise, contacts] = await Promise.all([
    supabase.from("invoice_follow_ups").select("id, channel, notes, promised_payment_date, next_follow_up_at, by_user, created_at").eq("invoice_id", invoiceId).order("created_at", { ascending: false }).limit(100),
    supabase
      .from("invoice_reminders")
      .select("id, kind, reminder_key, due_date, channel, status, sent_at, recipient, error, owner_user_id, handed_off_at, dismissed_at, dismiss_reason, created_at")
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("collection_forecast").select("promised_payment_date, promised_amount, promise_status, settled_since_promise").eq("invoice_id", invoiceId).maybeSingle(),
    supabase.from("client_contacts").select("id, name, email, phone, whatsapp, is_primary, email_bounced").eq("client_id", inv.client_id).order("is_primary", { ascending: false }).order("created_at", { ascending: true }).limit(50),
  ]);
  if (followUps.error) throw followUps.error;
  if (reminders.error) throw reminders.error;
  if (promise.error) throw promise.error;
  if (contacts.error) throw contacts.error;

  const names = await namesOf(supabase, [...(followUps.data ?? []).map((f) => f.by_user), ...(reminders.data ?? []).map((r) => r.owner_user_id)]);
  const p = promise.data;
  return {
    invoice: {
      id: inv.id,
      number: inv.invoice_number,
      status: inv.status,
      cancelled: Boolean(inv.cancelled_at),
      issueDate: inv.issue_date,
      dueDate: inv.due_date,
      totalPaise: toPaise(inv.total_amount),
      outstandingPaise: toPaise(inv.outstanding_amount),
      clientId: inv.client_id,
      clientName: client.display_name,
      clientStatus: client.status,
      clientEmail: client.email,
      clientPhone: client.phone,
      clientWhatsapp: client.whatsapp,
    },
    followUps: (followUps.data ?? []).map((f) => ({
      id: f.id,
      channel: f.channel as FollowUpChannel,
      notes: f.notes,
      promisedPaymentDate: f.promised_payment_date,
      nextFollowUpAt: f.next_follow_up_at,
      byName: names.get(f.by_user) ?? null,
      createdAt: f.created_at,
    })),
    reminders: (reminders.data ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      reminderKey: r.reminder_key,
      dueDate: r.due_date,
      channel: r.channel,
      status: r.status,
      sentAt: r.sent_at,
      recipient: r.recipient,
      error: r.error,
      ownerUserId: r.owner_user_id,
      ownerName: r.owner_user_id ? (names.get(r.owner_user_id) ?? null) : null,
      handedOffAt: r.handed_off_at,
      dismissedAt: r.dismissed_at,
      dismissReason: r.dismiss_reason,
      createdAt: r.created_at,
    })),
    promise:
      p && p.promised_payment_date
        ? {
            date: p.promised_payment_date,
            promisedPaise: toPaise(p.promised_amount ?? 0),
            status: (p.promise_status ?? "open") as "kept" | "missed" | "open",
            settledSincePaise: toPaise(p.settled_since_promise ?? 0),
          }
        : null,
    contacts: (contacts.data ?? []).map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, whatsapp: c.whatsapp, primary: c.is_primary, bounced: Boolean(c.email_bounced) })),
  };
}

// =================================================================================================
// Retainer drafts queue (§7.9.6)
// =================================================================================================

export type RetainerQueueRow = {
  id: string;
  run_id: string;
  run_date: DateString;
  invoice_id: string;
  invoice_number: string | null;
  client_service_id: string | null;
  billing_date: DateString;
  period_label: string;
  status: InvoiceStatus;
  issue_date: DateString;
  due_date: DateString;
  taxable_amount: number;
  gst_amount: number;
  total_amount: number;
  requires_approval: boolean;
  approved_at: string | null;
  submitted_at: string | null;
  invoice_updated_at: string;
  client_id: string;
  client_name: string;
  client_code: string;
  client_status: ClientStatus;
  client_email: string | null;
  service_type: ServiceType | null;
  custom_name: string | null;
  frequency: ServiceFrequency | null;
  billing_frequency: ServiceFrequency | null;
};

const QUEUE_COLUMNS =
  "id, run_id, run_date, invoice_id, invoice_number, client_service_id, billing_date, period_label, status, issue_date, due_date, taxable_amount, gst_amount, total_amount, requires_approval, approved_at, submitted_at, invoice_updated_at, client_id, client_name, client_code, client_status, client_email, service_type, custom_name, frequency, billing_frequency";

const QUEUE_SORT: Record<string, string> = {
  client_name: "client_name",
  period: "billing_date",
  billing_date: "billing_date",
  total_amount: "total_amount",
  run_date: "run_date",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST builder generics differ per view; the filters are the same.
function applyQueueState(q: any, state: RetainerQueueState): any {
  q = q.is("deleted_at", null).is("cancelled_at", null);
  switch (state) {
    case "waiting":
      return q.eq("status", "draft").or("requires_approval.eq.false,approved_at.not.is.null");
    case "held":
      return q.in("status", ["draft", "awaiting_approval"]).eq("requires_approval", true).is("approved_at", null);
    case "issued":
      return q.not("status", "in", "(draft,awaiting_approval)");
    case "all":
      return q;
  }
}

export async function listRetainerQueue(
  supabase: ServerSupabase,
  t: TableParams,
  opts: { state: RetainerQueueState; runId?: string | null },
): Promise<{ rows: RetainerQueueRow[]; total: number; totalPaise: Paise }> {
  let q = supabase.from("retainer_draft_queue").select(QUEUE_COLUMNS, { count: "exact" });
  q = applyQueueState(q, opts.state);
  if (opts.runId) q = q.eq("run_id", opts.runId);
  if (t.q) {
    const p = `%${escapeLike(t.q)}%`;
    q = q.or(`client_name.ilike.${p},client_code.ilike.${p},period_label.ilike.${p}`);
  }
  const sort = QUEUE_SORT[t.sort ?? ""] ?? "billing_date";
  q = q.order(sort, { ascending: t.dir === "asc" }).order("client_name", { ascending: true }).order("id", { ascending: true }).range(t.from, t.to);
  const { data, error, count } = await q;
  if (error) throw error;

  // The total of the whole filtered set, summed in paise.
  let tq = supabase.from("retainer_draft_queue").select("total_amount");
  tq = applyQueueState(tq, opts.state);
  if (opts.runId) tq = tq.eq("run_id", opts.runId);
  if (t.q) {
    const p = `%${escapeLike(t.q)}%`;
    tq = tq.or(`client_name.ilike.${p},client_code.ilike.${p},period_label.ilike.${p}`);
  }
  const amounts = await fetchAll<{ total_amount: number | null }>((a, b) => tq.order("id").range(a, b), 5000);
  return {
    rows: (data ?? []) as unknown as RetainerQueueRow[],
    total: count ?? 0,
    totalPaise: amounts.reduce((s, r) => s + toPaise(r.total_amount ?? 0), 0),
  };
}

/** How many drafts wait in each state (for the queue's tabs). */
export async function getRetainerQueueCounts(supabase: ServerSupabase): Promise<Record<"waiting" | "held", number>> {
  const count = async (state: RetainerQueueState) => {
    let q = supabase.from("retainer_draft_queue").select("id", { count: "exact", head: true });
    q = applyQueueState(q, state);
    const { count: n, error } = await q;
    if (error) throw error;
    return n ?? 0;
  };
  const [waiting, held] = await Promise.all([count("waiting"), count("held")]);
  return { waiting, held };
}

export type RetainerRun = {
  id: string;
  runDate: DateString;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
  capped: Array<{ client_service_id: string; client_id: string; client_name: string; service: string; next_billing_date: string; periods_left: number }>;
  errors: Array<{ client_service_id: string; client_id: string; client_name: string; error: string }>;
  draftsCreated: number;
  draftsTotalPaise: Paise;
};

export async function listRetainerRuns(supabase: ServerSupabase, limit = 12): Promise<RetainerRun[]> {
  const { data, error } = await supabase
    .from("retainer_runs")
    .select("id, run_date, started_at, finished_at, counts, capped, errors, drafts_created, drafts_total")
    .order("run_date", { ascending: false })
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    runDate: r.run_date,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    counts: (r.counts ?? {}) as Record<string, number>,
    capped: (Array.isArray(r.capped) ? r.capped : []) as RetainerRun["capped"],
    errors: (Array.isArray(r.errors) ? r.errors : []) as RetainerRun["errors"],
    draftsCreated: r.drafts_created,
    draftsTotalPaise: toPaise(r.drafts_total),
  }));
}

/**
 * The invoice ids of the drafts waiting to issue, oldest billing date first, for "Issue all": for a
 * Partner every draft (issuing a held one approves it, §7.9.2), for a Manager the ones not held.
 */
export async function listWaitingDraftIds(supabase: ServerSupabase, runId: string | null, limit = 200, opts: { includeHeld?: boolean } = {}): Promise<string[]> {
  let q = supabase.from("retainer_draft_queue").select("invoice_id");
  q = opts.includeHeld ? q.is("deleted_at", null).is("cancelled_at", null).eq("status", "draft") : applyQueueState(q, "waiting");
  if (runId) q = q.eq("run_id", runId);
  const { data, error } = await q.order("billing_date").order("client_name").limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => r.invoice_id).filter((v): v is string => !!v);
}

/** The issue-time facts of retainer drafts, for "Issue selected": who each goes to by email. */
export type IssueTarget = {
  invoiceId: string;
  updatedAt: string;
  clientId: string;
  clientName: string;
  periodLabel: string;
  totalPaise: Paise;
  held: boolean;
  email: { to: string; contactId: string | null; name: string } | null;
};

export async function getIssueTargets(supabase: ServerSupabase, invoiceIds: readonly string[]): Promise<IssueTarget[]> {
  if (!invoiceIds.length) return [];
  const { data, error } = await supabase
    .from("retainer_draft_queue")
    .select("invoice_id, invoice_updated_at, client_id, client_name, client_email, period_label, total_amount, requires_approval, approved_at, status")
    .in("invoice_id", invoiceIds as string[])
    .is("deleted_at", null);
  if (error) throw error;
  const rows = data ?? [];
  const clientIds = [...new Set(rows.map((r) => r.client_id).filter((v): v is string => !!v))];
  const { data: contacts, error: cErr } = clientIds.length
    ? await supabase.from("client_contacts").select("id, client_id, name, email, email_bounced, is_primary, created_at").in("client_id", clientIds).not("email", "is", null).order("is_primary", { ascending: false }).order("created_at", { ascending: true })
    : { data: [], error: null };
  if (cErr) throw cErr;
  const byClient = new Map<string, { id: string; name: string; email: string }>();
  for (const c of contacts ?? []) {
    if (c.email && !c.email_bounced && !byClient.has(c.client_id)) byClient.set(c.client_id, { id: c.id, name: c.name, email: c.email });
  }
  return rows
    .filter((r) => r.invoice_id && r.client_id)
    .map((r) => {
      const contact = byClient.get(r.client_id!);
      const email = contact ? { to: contact.email, contactId: contact.id, name: contact.name } : r.client_email ? { to: r.client_email, contactId: null, name: r.client_name ?? "" } : null;
      return {
        invoiceId: r.invoice_id!,
        updatedAt: r.invoice_updated_at ?? "",
        clientId: r.client_id!,
        clientName: r.client_name ?? "",
        periodLabel: r.period_label ?? "",
        totalPaise: toPaise(r.total_amount ?? 0),
        held: Boolean(r.requires_approval && !r.approved_at),
        email,
      };
    });
}

// =================================================================================================
// Statement of account (§7.3.3, §7.4, §11)
// =================================================================================================

export type StatementClient = {
  id: string;
  clientCode: string;
  displayName: string;
  legalName: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  gstin: string | null;
  pan: string | null;
};

export type StatementData = { clients: StatementClient[]; events: StatementEvent[] };

/**
 * Everything on the clients' accounts up to `to` (earlier movements make the opening balance):
 * issued invoices and debit notes (not drafts, not deleted), their receipts (reversals on the day
 * they were reversed), credit notes, write-offs and cancellations. Null when none of the clients is
 * visible to the caller.
 */
export async function getStatementData(supabase: ServerSupabase, clientIds: readonly string[], to: DateString): Promise<StatementData | null> {
  if (!clientIds.length) return null;
  const ids = [...new Set(clientIds)] as string[];
  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, client_code, display_name, legal_name, address, city, pincode, gstin, pan")
    .in("id", ids)
    .is("deleted_at", null)
    .order("display_name");
  if (error) throw error;
  if (!clients?.length) return null;
  const visible = clients.map((c) => c.id);

  const [invoices, receipts, creditNotes] = await Promise.all([
    fetchAll<{ id: string; client_id: string; invoice_number: string | null; invoice_kind: string; issue_date: string; total_amount: number; billing_period_label: string | null; cancelled_at: string | null; waived_at: string | null; waived_amount: number | null }>((a, b) =>
      supabase
        .from("invoices")
        .select("id, client_id, invoice_number, invoice_kind, issue_date, total_amount, billing_period_label, cancelled_at, waived_at, waived_amount")
        .in("client_id", visible)
        .is("deleted_at", null)
        .not("invoice_number", "is", null)
        .not("status", "in", "(draft,awaiting_approval)")
        .lte("issue_date", to)
        .order("id")
        .range(a, b),
    ),
    fetchAll<{ id: string; receipt_number: string; payment_date: string; amount_received: number; tds_amount: number; tds_section: string | null; method: string; reference: string | null; reversed_at: string | null; invoices: { invoice_number: string | null; client_id: string } }>((a, b) =>
      supabase
        .from("payment_receipts")
        .select("id, receipt_number, payment_date, amount_received, tds_amount, tds_section, method, reference, reversed_at, invoices!inner(invoice_number, client_id, deleted_at)")
        .in("invoices.client_id", visible)
        .is("invoices.deleted_at", null)
        .lte("payment_date", to)
        .order("id")
        .range(a, b) as never,
    ),
    fetchAll<{ id: string; credit_note_number: string; issue_date: string; total_amount: number; client_id: string; invoices: { invoice_number: string | null } | null }>((a, b) =>
      supabase.from("credit_notes").select("id, credit_note_number, issue_date, total_amount, client_id, invoices(invoice_number)").in("client_id", visible).lte("issue_date", to).order("id").range(a, b) as never,
    ),
  ]);

  const events = statementEvents({
    invoices: invoices.map((i) => ({
      id: i.id,
      clientId: i.client_id,
      number: i.invoice_number ?? "",
      kind: i.invoice_kind === "debit_note" ? "debit_note" : "tax_invoice",
      issueDate: i.issue_date,
      totalPaise: toPaise(i.total_amount),
      periodLabel: i.billing_period_label,
      cancelledOn: i.cancelled_at ? istDateOf(i.cancelled_at) : null,
      waivedOn: i.waived_at ? istDateOf(i.waived_at) : null,
      waivedPaise: i.waived_amount === null ? null : toPaise(i.waived_amount),
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      clientId: r.invoices.client_id,
      number: r.receipt_number,
      invoiceNumber: r.invoices.invoice_number ?? "",
      paymentDate: r.payment_date,
      receivedPaise: toPaise(r.amount_received),
      tdsPaise: toPaise(r.tds_amount),
      tdsSection: r.tds_section,
      methodLabel: isEnumValue("payment_method", r.method) ? PAYMENT_METHOD_LABELS[r.method] : r.method,
      reference: r.reference,
      reversedOn: r.reversed_at ? istDateOf(r.reversed_at) : null,
    })),
    creditNotes: creditNotes.map((n) => ({
      id: n.id,
      clientId: n.client_id,
      number: n.credit_note_number,
      invoiceNumber: n.invoices?.invoice_number ?? "",
      issueDate: n.issue_date,
      totalPaise: toPaise(n.total_amount),
    })),
  });

  return {
    clients: clients.map((c) => ({
      id: c.id,
      clientCode: String(c.client_code),
      displayName: c.display_name,
      legalName: c.legal_name,
      address: c.address,
      city: c.city,
      pincode: c.pincode,
      gstin: c.gstin ? String(c.gstin) : null,
      pan: c.pan ? String(c.pan) : null,
    })),
    events,
  };
}

/** The group and its live members, or null when it doesn't exist (or the caller can't see it). */
export async function getGroupForStatement(supabase: ServerSupabase, groupId: string): Promise<{ id: string; name: string; clientIds: string[] } | null> {
  const { data: group, error } = await supabase.from("client_groups").select("id, name").eq("id", groupId).maybeSingle();
  if (error) throw error;
  if (!group) return null;
  const { data: members, error: mErr } = await supabase.from("clients").select("id").eq("group_id", groupId).is("deleted_at", null).limit(500);
  if (mErr) throw mErr;
  return { id: group.id, name: String(group.name), clientIds: (members ?? []).map((m) => m.id) };
}

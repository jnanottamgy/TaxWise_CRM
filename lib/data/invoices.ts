import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Json, Tables } from "@/lib/database.types";
import type { TableParams } from "@/components/app/data-table/params";
import type { ComboOption } from "@/components/app/form/combobox";
import { escapeLike } from "@/components/app/data-table/params";
import { stateName } from "@/lib/domain/india-validators";
import { resolveGstParams, type GstParams, type StatutoryParameterRow } from "@/lib/domain/gst";
import { financialYearOf, todayIST, type DateString } from "@/lib/domain/fy";
import { toPaise, sumPaise, type Paise } from "@/lib/domain/money";
import type { GstRegistration, InvoiceStatus, ServiceFrequency, ServiceType } from "@/lib/domain/enums";
import {
  INVOICE_DATE_PRESETS,
  INVOICE_LIST_SORTABLE,
  datePresetRange,
  type InvoiceDatePreset,
  type BilledPeriod,
  type CompletedTaskOption,
  type EngagementOption,
  type InvoiceKind,
  type InvoiceListSort,
  type UnbilledEntry,
} from "@/lib/schemas/invoices";

/**
 * Reads for invoices (§7.9.1–§7.9.3), under the caller's session: RLS gives Partners and Managers
 * every invoice and nobody else any (§4.1), so an Employee or a portal user reaching these gets
 * nothing. The list is one call to invoice_list (0154: search, filters, sort, page and the totals of
 * the filtered set in SQL, §2.3).
 */

// =================================================================================================
// The list (§7.9.1)
// =================================================================================================

export type InvoiceListRow = {
  id: string;
  invoice_number: string | null;
  invoice_kind: InvoiceKind;
  client_id: string;
  client_name: string;
  client_code: string;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  display_status: string;
  is_overdue: boolean;
  days_overdue: number;
  billing_period_label: string | null;
  taxable_amount: number;
  gst_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  reimbursement_amount: number;
  round_off: number;
  total_amount: number;
  amount_received: number;
  tds_credited: number;
  credit_noted: number;
  outstanding_amount: number;
  sent_channels: string[] | null;
  sent_at: string | null;
  requires_approval: boolean;
  approved_at: string | null;
  cancelled_at: string | null;
  revised_from_id: string | null;
  original_invoice_id: string | null;
  created_by: string;
  created_by_name: string | null;
  updated_at: string;
};

export type InvoiceListTotals = {
  taxable: number;
  gst: number;
  reimbursement: number;
  total: number;
  received: number;
  tds: number;
  credited: number;
  outstanding: number;
  cancelled: number;
  drafts: number;
};

export type InvoiceListFilter = "status" | "client" | "from" | "to" | "period" | "fy" | "created_by" | "kind";

const EMPTY_TOTALS: InvoiceListTotals = { taxable: 0, gst: 0, reimbursement: 0, total: 0, received: 0, tds: 0, credited: 0, outstanding: 0, cancelled: 0, drafts: 0 };

export async function listInvoices(
  supabase: ServerSupabase,
  t: TableParams<InvoiceListSort, InvoiceListFilter>,
  opts: { fy: string | null; clientId?: string | null; limit?: number; offset?: number; today?: DateString },
): Promise<{ rows: InvoiceListRow[]; total: number; totals: InvoiceListTotals }> {
  const one = (k: InvoiceListFilter) => t.filters[k]?.[0] ?? null;
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const preset = one("period") as InvoiceDatePreset | null;
  const range = preset && (INVOICE_DATE_PRESETS as readonly string[]).includes(preset) ? datePresetRange(preset, opts.today ?? todayIST()) : null;
  const params = {
    q: t.q || null,
    status: t.filters.status ?? [],
    client_id: opts.clientId ?? one("client"),
    from: date(one("from")) ?? range?.from ?? null,
    to: date(one("to")) ?? range?.to ?? null,
    fy: opts.fy,
    created_by: one("created_by"),
    kind: one("kind"),
    sort: t.sort && (INVOICE_LIST_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "issue_date",
    dir: t.dir,
    offset: opts.offset ?? t.from,
    limit: opts.limit ?? t.pageSize,
  };
  const { data, error } = await supabase.rpc("invoice_list", { p_params: params as unknown as Json });
  if (error) throw error;
  const r = (data ?? {}) as { total?: number; rows?: InvoiceListRow[]; totals?: InvoiceListTotals };
  return { rows: r.rows ?? [], total: Number(r.total ?? 0), totals: { ...EMPTY_TOTALS, ...(r.totals ?? {}) } };
}

/**
 * The count and totals of every invoice with these statuses, all years (the list's KPIs, counted as
 * the dashboards count them).
 */
export async function getInvoiceStatusTotals(supabase: ServerSupabase, status: readonly string[]): Promise<{ count: number; totals: InvoiceListTotals }> {
  const { data, error } = await supabase.rpc("invoice_list", { p_params: { status: [...status], limit: 1 } as unknown as Json });
  if (error) throw error;
  const r = (data ?? {}) as { total?: number; totals?: InvoiceListTotals };
  return { count: Number(r.total ?? 0), totals: { ...EMPTY_TOTALS, ...(r.totals ?? {}) } };
}

/** The people who raise invoices, for the "Created by" filter (Partners and Managers). */
export async function listInvoiceRaisers(supabase: ServerSupabase): Promise<Array<{ value: string; label: string }>> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("role", ["partner", "manager"])
    .order("full_name", { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((p) => ({ value: p.id, label: p.full_name }));
}

/** The client a `?client=` filter names, for its chip label. */
export async function getClientLabel(supabase: ServerSupabase, clientId: string): Promise<string | null> {
  const { data, error } = await supabase.from("clients").select("display_name, client_code").eq("id", clientId).maybeSingle();
  if (error) throw error;
  return data ? `${data.client_code} · ${data.display_name}` : null;
}

// =================================================================================================
// Firm billing settings and GST parameters (§5.2, §5.12, §6.4)
// =================================================================================================

export type BillingSettings = {
  firmName: string;
  firmStateCode: string;
  firmGstin: string | null;
  defaultTaxRate: number;
  defaultSac: string;
  sacByService: Record<string, string>;
  paymentTermsDays: number;
  invoiceTerms: string | null;
  invoiceApprovalLimitPaise: Paise | null;
  roundOffEnabled: boolean;
  eInvoicingApplies: boolean;
  lastGstr1ReportedMonth: string | null;
  upiId: string | null;
  upiPayeeName: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
};

function asStringMap(v: Json | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, s] of Object.entries(v)) if (typeof s === "string") out[k] = s;
  }
  return out;
}

export async function getBillingSettings(supabase: ServerSupabase): Promise<BillingSettings> {
  const { data, error } = await supabase
    .from("firm_settings")
    .select(
      "firm_name, state_code, gstin, default_tax_rate, default_sac, sac_by_service, payment_terms_days, invoice_terms, invoice_approval_limit, round_off_enabled, e_invoicing_applies, last_gstr1_reported_month, upi_id, upi_payee_name, bank_name, bank_account_number",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  const s = data;
  return {
    firmName: s?.firm_name ?? "TaxWise Consultants",
    firmStateCode: s?.state_code ?? "29",
    firmGstin: s?.gstin ?? null,
    defaultTaxRate: Number(s?.default_tax_rate ?? 18),
    defaultSac: s?.default_sac ?? "9982",
    sacByService: asStringMap(s?.sac_by_service),
    paymentTermsDays: s?.payment_terms_days ?? 15,
    invoiceTerms: s?.invoice_terms ?? null,
    invoiceApprovalLimitPaise: s?.invoice_approval_limit === null || s?.invoice_approval_limit === undefined ? null : toPaise(s.invoice_approval_limit),
    roundOffEnabled: Boolean(s?.round_off_enabled),
    eInvoicingApplies: Boolean(s?.e_invoicing_applies),
    lastGstr1ReportedMonth: s?.last_gstr1_reported_month ?? null,
    upiId: s?.upi_id ?? null,
    upiPayeeName: s?.upi_payee_name ?? null,
    bankName: s?.bank_name ?? null,
    bankAccountNumber: s?.bank_account_number ?? null,
  };
}

/** The GST parameters in force on a date (§5.12), with §6.4's values where a row is missing. */
export async function getGstParams(supabase: ServerSupabase, on: DateString = todayIST()): Promise<GstParams> {
  const { data, error } = await supabase
    .from("statutory_parameters")
    .select("key, value, effective_from, effective_to, verified")
    .like("key", "gst.%")
    .lte("effective_from", on)
    .limit(200);
  if (error) throw error;
  const rows: StatutoryParameterRow[] = (data ?? []).map((r) => ({
    key: r.key,
    value: r.value,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    verified: r.verified,
  }));
  return resolveGstParams(rows, on).params;
}

// =================================================================================================
// A client, for the editor (§7.9.2 "Client* (shows GST status, state, outstanding, engagements)")
// =================================================================================================

export type BillingContact = { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null; is_primary: boolean; handles: string[]; email_bounced: boolean };

export type ClientBillingFacts = {
  id: string;
  client_code: string;
  display_name: string;
  legal_name: string | null;
  status: string;
  gst_registration: GstRegistration;
  gstin: string | null;
  state_code: string | null;
  state_name: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  tan: string | null;
  entity_type: string | null;
  outstandingPaise: Paise;
  overduePaise: Paise;
  openInvoices: number;
  engagements: EngagementOption[];
  billedPeriods: BilledPeriod[];
  unbilled: UnbilledEntry[];
  completedTasks: CompletedTaskOption[];
  contacts: BillingContact[];
};

export async function getClientBillingFacts(supabase: ServerSupabase, clientId: string, opts: { invoiceId?: string | null } = {}): Promise<ClientBillingFacts | null> {
  const { data: c, error } = await supabase
    .from("clients")
    .select("id, client_code, display_name, legal_name, status, gst_registration, gstin, state_code, address, city, pincode, email, phone, whatsapp, tan, entity_type")
    .eq("id", clientId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!c) return null;

  const [open, services, billedHeader, billedLines, unbilled, tasks, contacts] = await Promise.all([
    supabase
      .from("invoices_view")
      .select("outstanding_amount, is_overdue")
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .is("cancelled_at", null)
      .in("status", ["sent", "partially_paid", "disputed"])
      .limit(1000),
    supabase
      .from("client_services")
      .select("id, service_type, custom_name, frequency, billing_frequency, agreed_fee, sac_code, is_active")
      .eq("client_id", clientId)
      .order("is_active", { ascending: false })
      .order("service_type")
      .limit(50),
    supabase
      .from("invoices")
      .select("id, invoice_number, client_service_id, billing_period_label")
      .eq("client_id", clientId)
      .eq("invoice_kind", "tax_invoice")
      .is("deleted_at", null)
      .is("cancelled_at", null)
      .not("client_service_id", "is", null)
      .not("billing_period_label", "is", null)
      .order("issue_date", { ascending: false })
      .limit(500),
    supabase
      .from("invoice_items")
      .select("client_service_id, invoices!inner(id, invoice_number, billing_period_label, client_id, deleted_at, cancelled_at, invoice_kind)")
      .eq("invoices.client_id", clientId)
      .is("invoices.deleted_at", null)
      .is("invoices.cancelled_at", null)
      .eq("invoices.invoice_kind", "tax_invoice")
      .not("client_service_id", "is", null)
      .limit(1000),
    supabase
      .from("unbilled_time_entries")
      .select("id, task_id, task_number, task_title, employee_name, started_at, minutes, billing_rate_per_hour, amount")
      .eq("client_id", clientId)
      .order("started_at", { ascending: false })
      .limit(300),
    supabase
      .from("tasks")
      .select("id, task_number, title, service_type, period_label, completion_date")
      .eq("client_id", clientId)
      .eq("status", "filed_done")
      .is("deleted_at", null)
      .order("completion_date", { ascending: false })
      .limit(40),
    supabase
      .from("client_contacts")
      .select("id, name, email, phone, whatsapp, is_primary, handles, email_bounced")
      .eq("client_id", clientId)
      .order("is_primary", { ascending: false })
      .order("name")
      .limit(50),
  ]);
  for (const r of [open, services, billedHeader, billedLines, unbilled, tasks, contacts]) if (r.error) throw r.error;

  const openRows = open.data ?? [];
  const billed: BilledPeriod[] = [];
  for (const b of billedHeader.data ?? []) {
    if (b.client_service_id && b.billing_period_label) billed.push({ client_service_id: b.client_service_id, billing_period_label: b.billing_period_label, invoice_id: b.id, invoice_number: b.invoice_number });
  }
  for (const l of (billedLines.data ?? []) as unknown as Array<{ client_service_id: string | null; invoices: { id: string; invoice_number: string | null; billing_period_label: string | null } | null }>) {
    if (l.client_service_id && l.invoices?.billing_period_label) {
      billed.push({ client_service_id: l.client_service_id, billing_period_label: l.invoices.billing_period_label, invoice_id: l.invoices.id, invoice_number: l.invoices.invoice_number });
    }
  }

  // Time already on another live invoice's lines can't be picked again.
  const unbilledRows = (unbilled.data ?? []) as Array<UnbilledEntry & { id: string }>;
  let taken = new Set<string>();
  if (unbilledRows.length) {
    const { data: onLines, error: linesError } = await supabase
      .from("invoice_items")
      .select("time_entry_ids, invoices!inner(id, deleted_at, cancelled_at)")
      .overlaps("time_entry_ids", unbilledRows.map((u) => u.id))
      .is("invoices.deleted_at", null)
      .is("invoices.cancelled_at", null)
      .limit(500);
    if (linesError) throw linesError;
    taken = new Set(
      ((onLines ?? []) as unknown as Array<{ time_entry_ids: string[]; invoices: { id: string } | null }>)
        .filter((l) => l.invoices && l.invoices.id !== opts.invoiceId)
        .flatMap((l) => l.time_entry_ids),
    );
  }

  return {
    id: c.id,
    client_code: c.client_code,
    display_name: c.display_name,
    legal_name: c.legal_name,
    status: c.status,
    gst_registration: c.gst_registration,
    gstin: c.gstin,
    state_code: c.state_code,
    state_name: c.state_code ? stateName(c.state_code) : null,
    address: c.address,
    city: c.city,
    pincode: c.pincode,
    email: c.email,
    phone: c.phone,
    whatsapp: c.whatsapp,
    tan: c.tan,
    entity_type: c.entity_type,
    outstandingPaise: sumPaise(openRows.map((r) => toPaise(r.outstanding_amount ?? 0))),
    overduePaise: sumPaise(openRows.filter((r) => r.is_overdue).map((r) => toPaise(r.outstanding_amount ?? 0))),
    openInvoices: openRows.length,
    engagements: (services.data ?? []).map((s) => ({
      id: s.id,
      service_type: s.service_type as ServiceType,
      custom_name: s.custom_name,
      frequency: s.frequency as ServiceFrequency,
      billing_frequency: (s.billing_frequency as ServiceFrequency | null) ?? null,
      agreed_fee: s.agreed_fee,
      sac_code: s.sac_code,
      is_active: s.is_active,
    })),
    billedPeriods: billed,
    unbilled: unbilledRows.filter((u) => !taken.has(u.id)),
    completedTasks: (tasks.data ?? []).map((t) => ({
      id: t.id,
      task_number: t.task_number,
      title: t.title,
      service_type: (t.service_type as ServiceType | null) ?? null,
      period_label: t.period_label,
      completion_date: t.completion_date,
    })),
    contacts: (contacts.data ?? []).map((x) => ({ ...x, handles: (x.handles ?? []) as string[] })),
  };
}

/** Clients to invoice, searched by name or code (active and pending first; inactive can't be billed). */
export async function searchBillableClients(supabase: ServerSupabase, q: string): Promise<ComboOption[]> {
  let query = supabase
    .from("clients")
    .select("id, client_code, display_name, status, gstin")
    .is("deleted_at", null)
    .neq("status", "inactive")
    .order("display_name", { ascending: true })
    .limit(20);
  const text = q.trim();
  if (text) {
    const like = `%${escapeLike(text)}%`;
    query = query.or(`display_name.ilike.${like},client_code.ilike.${like},legal_name.ilike.${like}`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((c) => ({
    value: c.id,
    label: `${c.client_code} · ${c.display_name}`,
    description: c.gstin ? `GSTIN ${c.gstin}` : c.status === "on_hold" ? "On hold" : undefined,
  }));
}

// =================================================================================================
// One invoice (§7.9.3)
// =================================================================================================

export type InvoiceRow = Tables<"invoices">;
export type InvoiceItemRow = Tables<"invoice_items">;

export type InvoiceReceiptRow = {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount_received: number;
  tds_amount: number;
  tds_section: string | null;
  tds_status: string;
  tds_quarter: string | null;
  method: string;
  reference: string | null;
  deposited_to: string | null;
  notes: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  created_at: string;
};

export type InvoiceCreditNoteRow = {
  id: string;
  credit_note_number: string;
  issue_date: string;
  reason_code: string;
  reason: string;
  reduces_gst: boolean;
  taxable_amount: number;
  tax_rate: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  total_amount: number;
  s34_deadline: string | null;
  issued_by_name: string | null;
};

export type RelatedInvoice = { id: string; invoice_number: string | null; invoice_kind: string; status: string; cancelled_at: string | null; total_amount: number; issue_date: string };

export type InvoiceMessageRow = { id: string; channel: string; status: string; recipient: string | null; subject: string | null; sent_at: string | null; created_at: string; error: string | null; sent_by_name: string | null };

export type InvoiceActivityRow = { id: string; action: string; description: string; user_name: string | null; at: string };

export type PaymentClaimRow = { id: string; reference: string | null; paid_on: string | null; note: string | null; created_at: string; updated_at: string; status: string; screenshot_document_id: string | null };

export type InvoiceDetail = {
  invoice: InvoiceRow;
  isOverdue: boolean;
  daysOverdue: number;
  items: InvoiceItemRow[];
  client: ClientBillingFacts | null;
  receipts: InvoiceReceiptRow[];
  creditNotes: InvoiceCreditNoteRow[];
  revisedFrom: RelatedInvoice | null;
  reissuedAs: RelatedInvoice | null;
  original: RelatedInvoice | null;
  debitNotes: RelatedInvoice[];
  messages: InvoiceMessageRow[];
  activity: InvoiceActivityRow[];
  claims: PaymentClaimRow[];
  names: Record<string, string>;
  taskCompletionDates: string[];
};

const RELATED = "id, invoice_number, invoice_kind, status, cancelled_at, total_amount, issue_date";

export async function getInvoiceDetail(supabase: ServerSupabase, id: string): Promise<InvoiceDetail | null> {
  const { data: inv, error } = await supabase.from("invoices").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!inv) return null;

  const [view, items, receipts, creditNotes, revisedFrom, reissuedAs, original, debitNotes, messages, activity, claims] = await Promise.all([
    supabase.from("invoices_view").select("is_overdue, days_overdue").eq("id", id).maybeSingle(),
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
    supabase
      .from("payment_receipts")
      .select("id, receipt_number, payment_date, amount_received, tds_amount, tds_section, tds_status, tds_quarter, method, reference, deposited_to, notes, recorded_by, reversed_at, reversal_reason, created_at")
      .eq("invoice_id", id)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("credit_notes")
      .select("id, credit_note_number, issue_date, reason_code, reason, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, s34_deadline, issued_by")
      .eq("invoice_id", id)
      .order("issue_date", { ascending: false }),
    inv.revised_from_id ? supabase.from("invoices").select(RELATED).eq("id", inv.revised_from_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from("invoices").select(RELATED).eq("revised_from_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    inv.original_invoice_id ? supabase.from("invoices").select(RELATED).eq("id", inv.original_invoice_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from("invoices").select(RELATED).eq("original_invoice_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(20),
    supabase
      .from("messages")
      .select("id, channel, status, recipient, subject, sent_at, created_at, error, sent_by")
      .eq("related_entity_type", "invoice")
      .eq("related_entity_id", id)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.from("activity_logs").select("id, action, description, user_name, at").eq("entity_type", "invoice").eq("entity_id", id).order("at", { ascending: false }).limit(40),
    supabase.from("portal_payment_claims").select("id, reference, paid_on, note, created_at, updated_at, status, screenshot_document_id").eq("invoice_id", id).eq("status", "pending").order("created_at", { ascending: false }).limit(10),
  ]);
  for (const r of [view, items, receipts, creditNotes, revisedFrom, reissuedAs, original, debitNotes, messages, activity, claims]) if (r.error) throw r.error;

  const itemRows = (items.data ?? []) as InvoiceItemRow[];
  const taskIds = [...new Set([inv.source_task_id, ...itemRows.map((i) => i.source_task_id)].filter((v): v is string => Boolean(v)))];
  const [client, taskRows] = await Promise.all([
    getClientBillingFacts(supabase, inv.client_id, { invoiceId: id }),
    taskIds.length ? supabase.from("tasks").select("id, completion_date").in("id", taskIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (taskRows.error) throw taskRows.error;

  const people = [
    inv.created_by,
    inv.approved_by,
    inv.returned_by,
    inv.issued_by,
    inv.cancelled_by,
    inv.waived_by,
    inv.disputed_by,
    inv.updated_by,
    ...(receipts.data ?? []).map((r) => r.recorded_by),
    ...(creditNotes.data ?? []).map((c) => c.issued_by),
    ...(messages.data ?? []).map((m) => m.sent_by),
  ].filter((v): v is string => Boolean(v));
  const names: Record<string, string> = {};
  const unique = [...new Set(people)];
  if (unique.length) {
    const { data: ps, error: pErr } = await supabase.from("profiles").select("id, full_name").in("id", unique);
    if (pErr) throw pErr;
    for (const p of ps ?? []) names[p.id] = p.full_name;
  }

  return {
    invoice: inv,
    isOverdue: Boolean(view.data?.is_overdue),
    daysOverdue: Number(view.data?.days_overdue ?? 0),
    items: itemRows,
    client,
    receipts: (receipts.data ?? []).map((r) => ({ ...r, recorded_by_name: names[r.recorded_by] ?? null })) as InvoiceReceiptRow[],
    creditNotes: (creditNotes.data ?? []).map((c) => ({ ...c, issued_by_name: names[c.issued_by] ?? null })) as InvoiceCreditNoteRow[],
    revisedFrom: (revisedFrom.data as RelatedInvoice | null) ?? null,
    reissuedAs: (reissuedAs.data as RelatedInvoice | null) ?? null,
    original: (original.data as RelatedInvoice | null) ?? null,
    debitNotes: (debitNotes.data ?? []) as RelatedInvoice[],
    messages: (messages.data ?? []).map((m) => ({ ...m, sent_by_name: m.sent_by ? (names[m.sent_by] ?? null) : null })) as InvoiceMessageRow[],
    activity: (activity.data ?? []) as InvoiceActivityRow[],
    claims: (claims.data ?? []) as PaymentClaimRow[],
    names,
    taskCompletionDates: ((taskRows.data ?? []) as Array<{ completion_date: string | null }>).map((t) => t.completion_date).filter((d): d is string => Boolean(d)),
  };
}

/** The TDS already recorded on an invoice's live receipts, for the expected-TDS suggestion. */
export function tdsAlreadyRecorded(receipts: readonly InvoiceReceiptRow[]): Paise {
  return sumPaise(receipts.filter((r) => !r.reversed_at).map((r) => toPaise(r.tds_amount)));
}

/** The annual return recorded for an FY (s.34 deadline), or null. */
export async function getAnnualReturn(supabase: ServerSupabase, fy: string): Promise<{ filed_on: string; arn: string | null } | null> {
  const { data, error } = await supabase.from("gst_annual_returns").select("filed_on, arn").eq("financial_year", fy).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** The FY an invoice's supply belongs to (by its invoice date). */
export function invoiceFy(issueDate: DateString): string {
  return financialYearOf(issueDate);
}

// =================================================================================================
// The invoice as a document (§6.4 Rule 46, §11): for the PDF and the email attachment
// =================================================================================================

export type InvoiceDocumentItem = {
  description: string;
  sac_code: string;
  quantity: number;
  rate: number;
  amount: number;
  tax_rate: number;
  is_reimbursement: boolean;
};

export type InvoiceDocument = {
  id: string;
  client_id: string;
  invoice_number: string | null;
  invoice_kind: string;
  status: string;
  is_overdue: boolean;
  cancelled_at: string | null;
  issue_date: string;
  due_date: string;
  billing_period_label: string | null;
  notes: string | null;
  terms: string | null;
  recipient: { name: string; address: string | null; gstin: string | null; state_code: string | null; registered: boolean };
  place_of_supply_code: string;
  firm_gstin: string | null;
  reverse_charge: boolean;
  items: InvoiceDocumentItem[];
  totals: {
    taxable_amount: number;
    cgst_amount: number;
    sgst_amount: number;
    igst_amount: number;
    reimbursement_amount: number;
    round_off: number;
    total_amount: number;
    amount_received: number;
    tds_credited: number;
    credit_noted: number;
    outstanding_amount: number;
  };
  signatory_id: string | null;
  signatory_name: string | null;
  original: { invoice_number: string | null; issue_date: string } | null;
  e_invoice: { irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr: string | null };
};

function addressOf(c: { address: string | null; city: string | null; state_code: string | null; pincode: string | null }): string | null {
  const statePin = [c.state_code ? stateName(c.state_code) : null, c.pincode].filter(Boolean).join(" ");
  const parts = [c.address, c.city, statePin].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Everything a tax invoice (or debit note) PDF prints (§6.4 Rule 46): the snapshots once issued,
 * the client as it is now while it is a draft. Staff read it under RLS; a portal user reads only
 * their own issued invoices through portal_invoices / portal_invoice_items (§7.22). Null when the
 * caller can't see it.
 */
export async function getInvoiceDocument(supabase: ServerSupabase, id: string, audience: "staff" | "client"): Promise<InvoiceDocument | null> {
  if (audience === "client") {
    const [{ data: inv, error }, { data: lines, error: linesError }] = await Promise.all([
      supabase.from("portal_invoices").select("*").eq("id", id).maybeSingle(),
      supabase.from("portal_invoice_items").select("description, sac_code, quantity, rate, amount, tax_rate, is_reimbursement, sort_order").eq("invoice_id", id).order("sort_order"),
    ]);
    if (error) throw error;
    if (linesError) throw linesError;
    if (!inv || !inv.id) return null;
    return {
      id: inv.id,
      client_id: inv.client_id ?? "",
      invoice_number: inv.invoice_number,
      invoice_kind: inv.invoice_kind ?? "tax_invoice",
      status: inv.status ?? "sent",
      is_overdue: Boolean(inv.is_overdue),
      cancelled_at: inv.cancelled_at,
      issue_date: inv.issue_date ?? "",
      due_date: inv.due_date ?? "",
      billing_period_label: inv.billing_period_label,
      notes: inv.notes,
      terms: inv.terms,
      recipient: {
        name: inv.client_name_snapshot ?? "",
        address: inv.client_address_snapshot,
        gstin: inv.client_gstin_snapshot,
        state_code: inv.client_gstin_snapshot ? inv.client_gstin_snapshot.slice(0, 2) : null,
        registered: Boolean(inv.client_gstin_snapshot),
      },
      place_of_supply_code: inv.place_of_supply_code ?? "29",
      firm_gstin: inv.firm_gstin_snapshot,
      reverse_charge: Boolean(inv.reverse_charge),
      items: (lines ?? []).map((l) => ({
        description: l.description ?? "",
        sac_code: l.sac_code ?? "",
        quantity: Number(l.quantity ?? 1),
        rate: Number(l.rate ?? 0),
        amount: Number(l.amount ?? 0),
        tax_rate: Number(l.tax_rate ?? 0),
        is_reimbursement: Boolean(l.is_reimbursement),
      })),
      totals: {
        taxable_amount: Number(inv.taxable_amount ?? 0),
        cgst_amount: Number(inv.cgst_amount ?? 0),
        sgst_amount: Number(inv.sgst_amount ?? 0),
        igst_amount: Number(inv.igst_amount ?? 0),
        reimbursement_amount: Number(inv.reimbursement_amount ?? 0),
        round_off: Number(inv.round_off ?? 0),
        total_amount: Number(inv.total_amount ?? 0),
        amount_received: Number(inv.amount_received ?? 0),
        tds_credited: Number(inv.tds_credited ?? 0),
        credit_noted: Number(inv.credit_noted ?? 0),
        outstanding_amount: Number(inv.outstanding_amount ?? 0),
      },
      signatory_id: null,
      signatory_name: null,
      original: null,
      e_invoice: { irn: inv.irn, ack_no: inv.irn_ack_no, ack_date: inv.irn_ack_date, signed_qr: inv.signed_qr },
    };
  }

  const { data: inv, error } = await supabase.from("invoices").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!inv) return null;
  const [lines, client, view, original] = await Promise.all([
    supabase.from("invoice_items").select("description, sac_code, quantity, rate, amount, tax_rate, is_reimbursement").eq("invoice_id", id).order("sort_order"),
    supabase.from("clients").select("display_name, legal_name, gst_registration, gstin, state_code, address, city, pincode").eq("id", inv.client_id).maybeSingle(),
    supabase.from("invoices_view").select("is_overdue").eq("id", id).maybeSingle(),
    inv.original_invoice_id ? supabase.from("invoices").select("invoice_number, issue_date").eq("id", inv.original_invoice_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [lines, client, view, original]) if (r.error) throw r.error;
  const c = client.data;
  const issued = inv.status !== "draft" && inv.status !== "awaiting_approval";
  const recipient = issued
    ? {
        name: inv.client_name_snapshot ?? c?.legal_name ?? c?.display_name ?? "",
        address: inv.client_address_snapshot,
        gstin: inv.client_gstin_snapshot,
        state_code: inv.client_state_snapshot ?? (inv.client_gstin_snapshot ? inv.client_gstin_snapshot.slice(0, 2) : null),
        registered: Boolean(inv.client_gstin_snapshot),
      }
    : {
        name: c?.legal_name?.trim() || c?.display_name || "",
        address: c ? addressOf(c) : null,
        gstin: c?.gstin ?? null,
        state_code: c?.state_code ?? (c?.gstin ? c.gstin.slice(0, 2) : null),
        registered: c?.gst_registration === "registered",
      };
  const settings = issued ? null : await getBillingSettings(supabase);
  return {
    id: inv.id,
    client_id: inv.client_id,
    invoice_number: inv.invoice_number,
    invoice_kind: inv.invoice_kind,
    status: inv.status,
    is_overdue: Boolean(view.data?.is_overdue),
    cancelled_at: inv.cancelled_at,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    billing_period_label: inv.billing_period_label,
    notes: inv.notes,
    terms: inv.terms,
    recipient,
    place_of_supply_code: inv.place_of_supply_code,
    firm_gstin: issued ? inv.firm_gstin_snapshot : (settings?.firmGstin ?? null),
    reverse_charge: inv.reverse_charge,
    items: (lines.data ?? []).map((l) => ({ ...l, quantity: Number(l.quantity), rate: Number(l.rate), amount: Number(l.amount), tax_rate: Number(l.tax_rate) })),
    totals: {
      taxable_amount: Number(inv.taxable_amount),
      cgst_amount: Number(inv.cgst_amount),
      sgst_amount: Number(inv.sgst_amount),
      igst_amount: Number(inv.igst_amount),
      reimbursement_amount: Number(inv.reimbursement_amount),
      round_off: Number(inv.round_off),
      total_amount: Number(inv.total_amount),
      amount_received: Number(inv.amount_received),
      tds_credited: Number(inv.tds_credited),
      credit_noted: Number(inv.credit_noted),
      outstanding_amount: Number(inv.outstanding_amount),
    },
    signatory_id: inv.signatory_id,
    signatory_name: inv.signatory_name,
    original: original.data ? { invoice_number: original.data.invoice_number, issue_date: original.data.issue_date } : null,
    e_invoice: { irn: inv.irn, ack_no: inv.irn_ack_no, ack_date: inv.irn_ack_date, signed_qr: inv.signed_qr },
  };
}

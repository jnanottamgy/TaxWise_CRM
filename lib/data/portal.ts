import "server-only";

import type { CurrentUser } from "@/lib/auth/current-user";
import type { ServerSupabase } from "@/lib/supabase/server";
import { fyEnd, fyStart, todayIST, type DateString } from "@/lib/domain/fy";
import { toPaise, type Paise } from "@/lib/domain/money";
import { upiPayUrl } from "@/lib/domain/messaging";
import { isDeadlineProgress, isPayable, paymentNote, type DeadlineProgress } from "@/lib/domain/portal-copy";
import { logUnexpected } from "@/lib/log";
import { escapeLike } from "@/components/app/data-table/params";
import {
  COMPLIANCE_GROUP_TYPES,
  type ComplianceGroup,
  type DeadlineView,
  type InvoiceShow,
  type InvoiceSort,
} from "@/lib/schemas/portal";
import { FIRM_DEFAULTS } from "@/lib/auth/firm-defaults";
import { getFirmProfile, type FirmProfile } from "@/server/firm";
import { qrPng } from "@/server/pdf/qr";

/**
 * Reads for the client portal (§7.22), always under the portal user's own session. RLS and the
 * portal views (0034, 0154, 0175) decide what exists: the signed-in client's own rows, portal-safe
 * columns only. Nothing here uses the service role, and nothing selects staff notes, workflow
 * internals, task ids or a claim's review note.
 *
 *   loadPortalFrame       the layout: firm name and logo, the client's name, the welcome gate
 *   getNoticeState        the privacy notice to acknowledge and whether this login has (§6.10)
 *   getPortalClient       the client and its owner's contact card
 *   deadlines / filings   portal_compliance_events, portal_filing_records
 *   requests / documents  document_requests (+ items), documents shared with the client
 *   invoices / receipts   portal_invoices, portal_payment_receipts, portal_credit_notes, claims
 *   messages              portal_messages and their attachments
 */

// =================================================================================================
// The client and the privacy notice
// =================================================================================================

export interface PortalOwner {
  name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
}

export interface PortalClient {
  id: string;
  clientCode: string | null;
  displayName: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  owner: PortalOwner | null;
}

/** The signed-in portal user's client (portal_my_client), or null when the login isn't linked to one. */
export async function getPortalClient(supabase: ServerSupabase): Promise<PortalClient | null> {
  const { data, error } = await supabase
    .from("portal_my_client")
    .select("id, client_code, display_name, legal_name, gstin, pan, owner_name, owner_designation, owner_email, owner_phone")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;
  return {
    id: data.id,
    clientCode: data.client_code,
    displayName: data.display_name?.trim() || data.legal_name?.trim() || "Your account",
    legalName: data.legal_name,
    gstin: data.gstin,
    pan: data.pan,
    owner: data.owner_name?.trim()
      ? { name: data.owner_name.trim(), designation: data.owner_designation, email: data.owner_email, phone: data.owner_phone }
      : null,
  };
}

export interface PrivacyNotice {
  version: string;
  /** Markdown (§5.12). */
  body: string;
  publishedAt: string | null;
}

export interface NoticeState {
  /** The notice to acknowledge: the current one if published, else the latest published one. Null when none is published. */
  notice: PrivacyNotice | null;
  /** When this login acknowledged that version, if it has. */
  acknowledgedAt: string | null;
  /** The latest acknowledgement of any version. */
  lastAcknowledged: { version: string | null; at: string } | null;
  /** True when there is a published notice this login hasn't acknowledged (§6.10, §7.22 first sign-in). */
  required: boolean;
}

/**
 * The privacy notice gate (§6.10, §7.22 "acknowledge the privacy notice before anything else").
 * Portal users read published notices only (RLS, 0039). A new version needs a new acknowledgement
 * ("If this notice changes, we will show you the new version and ask you to acknowledge it").
 */
export async function getNoticeState(supabase: ServerSupabase, userId: string): Promise<NoticeState> {
  const [notices, consents] = await Promise.all([
    supabase
      .from("privacy_notices")
      .select("version, body, published_at, is_current")
      .not("published_at", "is", null)
      .order("is_current", { ascending: false })
      .order("published_at", { ascending: false })
      .limit(1),
    supabase
      .from("consent_records")
      .select("notice_version, given_at")
      .eq("subject_type", "portal_user")
      .eq("subject_id", userId)
      .is("withdrawn_at", null)
      .order("given_at", { ascending: false })
      .limit(50),
  ]);
  if (notices.error) throw notices.error;
  if (consents.error) throw consents.error;
  const n = notices.data?.[0] ?? null;
  const notice: PrivacyNotice | null = n ? { version: n.version, body: n.body, publishedAt: n.published_at } : null;
  const rows = consents.data ?? [];
  const forVersion = notice ? rows.find((r) => r.notice_version === notice.version) : undefined;
  const last = rows[0] ?? null;
  return {
    notice,
    acknowledgedAt: forVersion?.given_at ?? null,
    lastAcknowledged: last ? { version: last.notice_version, at: last.given_at } : null,
    required: notice !== null && !forVersion,
  };
}

export interface PortalFrame {
  firm: { name: string; logoUrl: string | null };
  clientName: string | null;
  needsWelcome: boolean;
}

/**
 * What the portal layout shows and decides (§7.22, §0.1 rule 3): the firm's name and logo (through
 * public_firm_profile, which a portal user may call), the client's name (portal_my_client) and the
 * privacy-notice gate. Never throws: each part falls back, and a failed gate check never blocks the
 * client (§6.10).
 */
export async function loadPortalFrame(supabase: ServerSupabase, user: CurrentUser): Promise<PortalFrame> {
  const failed: string[] = [];
  let firstError: unknown = null;
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      failed.push(what);
      firstError ??= err;
      return null;
    }
  };
  const [firm, client, notice] = await Promise.all([
    attempt("firm profile", () => getFirmProfile(supabase)),
    attempt("client", () => getPortalClient(supabase)),
    attempt("privacy notice", () => getNoticeState(supabase, user.id)),
  ]);
  if (failed.length > 0) {
    logUnexpected(firstError, { source: "layout:(portal):frame", userId: user.id, role: user.role, failed });
  }
  return {
    firm: { name: firm?.firmName ?? FIRM_DEFAULTS.firmName, logoUrl: firm?.logoUrl ?? null },
    clientName: client?.displayName ?? null,
    needsWelcome: notice?.required ?? false,
  };
}

/** The firm as the portal's contact card and Help page show it (public_firm_profile). */
export async function getFirmContact(supabase: ServerSupabase): Promise<FirmProfile> {
  return getFirmProfile(supabase);
}

// =================================================================================================
// Deadlines and filings (portal_compliance_events, portal_filing_records; 0175)
// =================================================================================================

export interface PortalDeadline {
  id: string;
  type: string | null;
  formCode: string | null;
  title: string;
  description: string | null;
  financialYear: string | null;
  filingPeriod: string | null;
  dueDate: DateString;
  originalDueDate: DateString | null;
  isExtended: boolean;
  extensionRef: string | null;
  isProvisional: boolean;
  status: "pending" | "completed" | "cancelled";
  progress: DeadlineProgress;
  isOverdue: boolean;
  daysOverdue: number;
  daysUntilDue: number;
  filedOn: DateString | null;
  acknowledgementNo: string | null;
  acknowledgementDocumentId: string | null;
}

const DEADLINE_COLUMNS =
  "id, type, form_code, title, description, financial_year, filing_period, due_date, original_due_date, is_extended, extension_ref, is_provisional, status, progress, is_overdue, days_overdue, days_until_due, filed_on, acknowledgement_no, acknowledgement_document_id";

type DeadlineRow = {
  id: string | null;
  type: string | null;
  form_code: string | null;
  title: string | null;
  description: string | null;
  financial_year: string | null;
  filing_period: string | null;
  due_date: string | null;
  original_due_date: string | null;
  is_extended: boolean | null;
  extension_ref: string | null;
  is_provisional: boolean | null;
  status: string | null;
  progress: string | null;
  is_overdue: boolean | null;
  days_overdue: number | null;
  days_until_due: number | null;
  filed_on: string | null;
  acknowledgement_no: string | null;
  acknowledgement_document_id: string | null;
};

function toDeadline(r: DeadlineRow): PortalDeadline {
  return {
    id: r.id ?? "",
    type: r.type,
    formCode: r.form_code,
    title: r.title ?? "",
    description: r.description,
    financialYear: r.financial_year,
    filingPeriod: r.filing_period,
    dueDate: r.due_date ?? "",
    originalDueDate: r.original_due_date,
    isExtended: Boolean(r.is_extended),
    extensionRef: r.extension_ref,
    isProvisional: Boolean(r.is_provisional),
    status: r.status === "completed" || r.status === "cancelled" ? r.status : "pending",
    progress: isDeadlineProgress(r.progress) ? r.progress : "not_started",
    isOverdue: Boolean(r.is_overdue),
    daysOverdue: Number(r.days_overdue ?? 0),
    daysUntilDue: Number(r.days_until_due ?? 0),
    filedOn: r.filed_on,
    acknowledgementNo: r.acknowledgement_no,
    acknowledgementDocumentId: r.acknowledgement_document_id,
  };
}

export interface Page<T> {
  rows: T[];
  total: number;
}

/**
 * Deadlines still to file (§7.22 Deadlines), soonest first: `open` (overdue and upcoming), `overdue`
 * (pending past the due date) or `upcoming` (due today or later). Paged in SQL.
 */
export async function listDeadlines(supabase: ServerSupabase, p: { view: DeadlineView; from: number; to: number; today?: DateString }): Promise<Page<PortalDeadline>> {
  const today = p.today ?? todayIST();
  let q = supabase.from("portal_compliance_events").select(DEADLINE_COLUMNS, { count: "exact" }).eq("status", "pending");
  if (p.view === "overdue") q = q.lt("due_date", today);
  if (p.view === "upcoming") q = q.gte("due_date", today);
  const { data, error, count } = await q.order("due_date", { ascending: true }).order("id", { ascending: true }).range(p.from, p.to);
  if (error) throw error;
  return { rows: ((data ?? []) as DeadlineRow[]).map(toDeadline), total: count ?? 0 };
}

/** How many deadlines are overdue and upcoming, for the Deadlines tabs and Home. */
export async function getDeadlineCounts(supabase: ServerSupabase, today: DateString = todayIST()): Promise<{ overdue: number; upcoming: number; waitingOnYou: number }> {
  const head = { count: "exact" as const, head: true };
  const [overdue, upcoming, waiting] = await Promise.all([
    supabase.from("portal_compliance_events").select("id", head).eq("status", "pending").lt("due_date", today),
    supabase.from("portal_compliance_events").select("id", head).eq("status", "pending").gte("due_date", today),
    supabase.from("portal_compliance_events").select("id", head).eq("status", "pending").eq("progress", "waiting_on_you"),
  ]);
  for (const r of [overdue, upcoming, waiting]) if (r.error) throw r.error;
  return { overdue: overdue.count ?? 0, upcoming: upcoming.count ?? 0, waitingOnYou: waiting.count ?? 0 };
}

/** The next deadlines for Home: overdue ones first (they are the earliest), then the soonest. */
export async function getNextDeadlines(supabase: ServerSupabase, limit: number): Promise<PortalDeadline[]> {
  const { data, error } = await supabase
    .from("portal_compliance_events")
    .select(DEADLINE_COLUMNS)
    .eq("status", "pending")
    .order("due_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as DeadlineRow[]).map(toDeadline);
}

export interface FilingParams {
  fy: string;
  group: ComplianceGroup | null;
  progress: string | null;
  sort: "due_date" | "form_code" | "filed_on";
  dir: "asc" | "desc";
  from: number;
  to: number;
}

/** Filing status by period for one FY (§7.22 Compliance), with acknowledgement numbers. Paged and sorted in SQL. */
export async function listFilings(supabase: ServerSupabase, p: FilingParams): Promise<Page<PortalDeadline>> {
  let q = supabase.from("portal_compliance_events").select(DEADLINE_COLUMNS, { count: "exact" }).eq("financial_year", p.fy);
  if (p.group) q = q.in("type", COMPLIANCE_GROUP_TYPES[p.group] as never);
  if (p.progress === "overdue") q = q.eq("is_overdue", true);
  else if (p.progress && isDeadlineProgress(p.progress)) q = q.eq("progress", p.progress);
  const { data, error, count } = await q
    .order(p.sort, { ascending: p.dir === "asc", nullsFirst: false })
    .order("due_date", { ascending: true })
    .order("id", { ascending: true })
    .range(p.from, p.to);
  if (error) throw error;
  return { rows: ((data ?? []) as DeadlineRow[]).map(toDeadline), total: count ?? 0 };
}

export interface FilingSummary {
  total: number;
  filed: number;
  pending: number;
  overdue: number;
}

/** The FY's totals for the Compliance page's summary line. */
export async function getFilingSummary(supabase: ServerSupabase, fy: string): Promise<FilingSummary> {
  const head = { count: "exact" as const, head: true };
  const [total, filed, pending, overdue] = await Promise.all([
    supabase.from("portal_compliance_events").select("id", head).eq("financial_year", fy).neq("status", "cancelled"),
    supabase.from("portal_compliance_events").select("id", head).eq("financial_year", fy).eq("progress", "filed"),
    supabase.from("portal_compliance_events").select("id", head).eq("financial_year", fy).eq("status", "pending"),
    supabase.from("portal_compliance_events").select("id", head).eq("financial_year", fy).eq("is_overdue", true),
  ]);
  for (const r of [total, filed, pending, overdue]) if (r.error) throw r.error;
  return { total: total.count ?? 0, filed: filed.count ?? 0, pending: pending.count ?? 0, overdue: overdue.count ?? 0 };
}

export interface FilingRecordRow {
  id: string;
  financialYear: string;
  filingType: string;
  period: string | null;
  filedOn: DateString | null;
  acknowledgementNo: string | null;
  isExternal: boolean;
  filedByExternal: string | null;
  acknowledgementDocumentId: string | null;
}

/**
 * Filings on record that no deadline covers (§7.15.2: inherited from a previous CA, or recorded
 * without a deadline), for one FY. Filings that close a deadline show on that deadline's row.
 */
export async function listOtherFilings(supabase: ServerSupabase, p: { fy: string; from: number; to: number }): Promise<Page<FilingRecordRow>> {
  const { data, error, count } = await supabase
    .from("portal_filing_records")
    .select("id, financial_year, filing_type, period, filed_on, acknowledgement_no, is_external, filed_by_external, acknowledgement_document_id", { count: "exact" })
    .eq("financial_year", p.fy)
    .is("compliance_event_id", null)
    .order("filed_on", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .range(p.from, p.to);
  if (error) throw error;
  return {
    rows: (data ?? []).map((r) => ({
      id: r.id ?? "",
      financialYear: r.financial_year ?? p.fy,
      filingType: r.filing_type ?? "",
      period: r.period,
      filedOn: r.filed_on,
      acknowledgementNo: r.acknowledgement_no,
      isExternal: Boolean(r.is_external),
      filedByExternal: r.filed_by_external,
      acknowledgementDocumentId: r.acknowledgement_document_id,
    })),
    total: count ?? 0,
  };
}

/** The financial years the client has deadlines or filings in, newest first. */
export async function listComplianceYears(supabase: ServerSupabase): Promise<string[]> {
  const [events, filings] = await Promise.all([
    supabase.from("portal_compliance_events").select("financial_year").not("financial_year", "is", null).order("financial_year", { ascending: false }).limit(1000),
    supabase.from("portal_filing_records").select("financial_year").order("financial_year", { ascending: false }).limit(1000),
  ]);
  if (events.error) throw events.error;
  if (filings.error) throw filings.error;
  const years = new Set<string>();
  for (const r of [...(events.data ?? []), ...(filings.data ?? [])]) if (r.financial_year) years.add(r.financial_year);
  return [...years].sort().reverse();
}

// =================================================================================================
// Document requests and shared documents
// =================================================================================================

export interface PortalRequestItem {
  id: string;
  title: string;
  helpText: string | null;
  isRequired: boolean;
  status: "pending" | "uploaded" | "accepted" | "rejected";
  rejectionReason: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  /** The file the client uploaded for it, when they can still see it. */
  document: { id: string; title: string; fileName: string } | null;
}

export interface PortalRequest {
  id: string;
  title: string;
  status: "open" | "completed" | "cancelled";
  dueDate: DateString | null;
  /** "Notes for the client" (§7.14). */
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  items: PortalRequestItem[];
}

type RequestQueryRow = {
  id: string;
  title: string;
  status: "open" | "completed" | "cancelled";
  due_date: string | null;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  document_request_items: Array<{
    id: string;
    title: string;
    help_text: string | null;
    is_required: boolean;
    status: PortalRequestItem["status"];
    rejection_reason: string | null;
    uploaded_at: string | null;
    reviewed_at: string | null;
    sort_order: number;
    documents: { id: string; title: string; file_name: string } | null;
  }> | null;
};

/**
 * The client's document requests (§7.14, §7.22 Documents): open ones first (due soonest), then the
 * most recently completed (up to `completedLimit`). Cancelled requests aren't shown. Only the columns
 * meant for the client: the title, due date, the notes written for them, and each item's status and
 * rejection reason.
 */
export async function listRequests(supabase: ServerSupabase, opts: { completedLimit?: number } = {}): Promise<{ open: PortalRequest[]; completed: PortalRequest[] }> {
  const select =
    "id, title, status, due_date, notes, created_at, completed_at, document_request_items(id, title, help_text, is_required, status, rejection_reason, uploaded_at, reviewed_at, sort_order, documents(id, title, file_name))";
  const [open, done] = await Promise.all([
    supabase.from("document_requests").select(select).eq("status", "open").order("due_date", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).limit(100),
    supabase.from("document_requests").select(select).eq("status", "completed").order("completed_at", { ascending: false, nullsFirst: false }).limit(opts.completedLimit ?? 5),
  ]);
  if (open.error) throw open.error;
  if (done.error) throw done.error;
  const shape = (r: RequestQueryRow): PortalRequest => ({
    id: r.id,
    title: r.title,
    status: r.status,
    dueDate: r.due_date,
    notes: r.notes,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    items: [...(r.document_request_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
      .map((i) => ({
        id: i.id,
        title: i.title,
        helpText: i.help_text,
        isRequired: i.is_required,
        status: i.status,
        rejectionReason: i.status === "rejected" ? i.rejection_reason : null,
        uploadedAt: i.uploaded_at,
        reviewedAt: i.reviewed_at,
        document: i.documents ? { id: i.documents.id, title: i.documents.title, fileName: i.documents.file_name } : null,
      })),
  });
  return {
    open: ((open.data ?? []) as unknown as RequestQueryRow[]).map(shape),
    completed: ((done.data ?? []) as unknown as RequestQueryRow[]).map(shape),
  };
}

/** The titles of items still to upload on open requests (pending or rejected), for "what we need from you". */
export async function listOutstandingItemTitles(supabase: ServerSupabase): Promise<string[]> {
  const { open } = await listRequests(supabase, { completedLimit: 0 });
  const out: string[] = [];
  for (const r of open) for (const i of r.items) if ((i.status === "pending" || i.status === "rejected") && !out.includes(i.title)) out.push(i.title);
  return out;
}

export interface SharedDocument {
  id: string;
  title: string;
  category: string;
  financialYear: string | null;
  period: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sharedAt: string;
}

export interface SharedParams {
  q: string;
  category: string | null;
  fy: string | null;
  sort: "created_at" | "title";
  dir: "asc" | "desc";
  from: number;
  to: number;
}

/** Documents the firm shared with the client (§7.22 "returns, computations, financial statements, engagement letter"). Paged in SQL. */
export async function listSharedDocuments(supabase: ServerSupabase, p: SharedParams): Promise<Page<SharedDocument>> {
  let q = supabase
    .from("documents")
    .select("id, title, category, financial_year, period, file_name, mime_type, file_size, created_at", { count: "exact" })
    .eq("shareable_with_client", true)
    .is("deleted_at", null);
  if (p.q) q = q.ilike("title", `%${escapeLike(p.q)}%`);
  if (p.category) q = q.eq("category", p.category as never);
  if (p.fy) q = q.eq("financial_year", p.fy);
  const { data, error, count } = await q.order(p.sort, { ascending: p.dir === "asc" }).order("id", { ascending: true }).range(p.from, p.to);
  if (error) throw error;
  return {
    rows: (data ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      financialYear: d.financial_year,
      period: d.period,
      fileName: d.file_name,
      mimeType: d.mime_type,
      fileSize: d.file_size,
      sharedAt: d.created_at,
    })),
    total: count ?? 0,
  };
}

/** Whether the firm has shared anything at all (to tell "nothing shared yet" from "no match"). */
export async function hasSharedDocuments(supabase: ServerSupabase): Promise<boolean> {
  const { count, error } = await supabase.from("documents").select("id", { count: "exact", head: true }).eq("shareable_with_client", true).is("deleted_at", null);
  if (error) throw error;
  return (count ?? 0) > 0;
}

// =================================================================================================
// Invoices, receipts, credit notes and "I've paid" claims
// =================================================================================================

export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  kind: string;
  issueDate: DateString;
  dueDate: DateString;
  status: string;
  displayStatus: string;
  isOverdue: boolean;
  periodLabel: string | null;
  totalAmount: number;
  received: number;
  tdsCredited: number;
  creditNoted: number;
  outstanding: number;
  cancelledAt: string | null;
  payable: boolean;
  /** The latest "I've paid" still waiting for the firm, if any. */
  pendingClaim: { reference: string | null; paidOn: DateString | null; reportedAt: string } | null;
}

const INVOICE_COLUMNS =
  "id, invoice_number, invoice_kind, issue_date, due_date, status, display_status, is_overdue, billing_period_label, total_amount, amount_received, tds_credited, credit_noted, outstanding_amount, cancelled_at";

type InvoiceRow = {
  id: string | null;
  invoice_number: string | null;
  invoice_kind: string | null;
  issue_date: string | null;
  due_date: string | null;
  status: string | null;
  display_status: string | null;
  is_overdue: boolean | null;
  billing_period_label: string | null;
  total_amount: number | null;
  amount_received: number | null;
  tds_credited: number | null;
  credit_noted: number | null;
  outstanding_amount: number | null;
  cancelled_at: string | null;
};

function toInvoice(r: InvoiceRow, claims: Map<string, PortalInvoice["pendingClaim"]>): PortalInvoice {
  const outstanding = Number(r.outstanding_amount ?? 0);
  const id = r.id ?? "";
  return {
    id,
    invoiceNumber: r.invoice_number ?? "",
    kind: r.invoice_kind ?? "tax_invoice",
    issueDate: r.issue_date ?? "",
    dueDate: r.due_date ?? "",
    status: r.status ?? "sent",
    displayStatus: r.display_status ?? r.status ?? "sent",
    isOverdue: Boolean(r.is_overdue),
    periodLabel: r.billing_period_label,
    totalAmount: Number(r.total_amount ?? 0),
    received: Number(r.amount_received ?? 0),
    tdsCredited: Number(r.tds_credited ?? 0),
    creditNoted: Number(r.credit_noted ?? 0),
    outstanding,
    cancelledAt: r.cancelled_at,
    payable: isPayable({ status: r.status, cancelledAt: r.cancelled_at, outstandingPaise: toPaise(outstanding) }),
    pendingClaim: claims.get(id) ?? null,
  };
}

/** The latest pending "I've paid" per invoice (the client's own claims; never the firm's review note). */
async function pendingClaims(supabase: ServerSupabase, invoiceIds: string[]): Promise<Map<string, PortalInvoice["pendingClaim"]>> {
  const out = new Map<string, PortalInvoice["pendingClaim"]>();
  if (invoiceIds.length === 0) return out;
  const { data, error } = await supabase
    .from("portal_payment_claims")
    .select("invoice_id, reference, paid_on, created_at")
    .in("invoice_id", invoiceIds)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  for (const c of data ?? []) {
    if (!out.has(c.invoice_id)) out.set(c.invoice_id, { reference: c.reference, paidOn: c.paid_on, reportedAt: c.created_at });
  }
  return out;
}

export interface InvoiceListParams {
  show: InvoiceShow;
  fy: string | null;
  sort: InvoiceSort;
  dir: "asc" | "desc";
  from: number;
  to: number;
}

/** The client's issued invoices (portal_invoices), paged, sorted and filtered in SQL. */
export async function listInvoices(supabase: ServerSupabase, p: InvoiceListParams): Promise<Page<PortalInvoice>> {
  let q = supabase.from("portal_invoices").select(INVOICE_COLUMNS, { count: "exact" });
  if (p.show === "due") q = q.in("status", ["sent", "partially_paid", "disputed"]).gt("outstanding_amount", 0).is("cancelled_at", null);
  if (p.show === "paid") q = q.eq("status", "paid");
  if (p.fy) q = q.gte("issue_date", fyStart(p.fy)).lte("issue_date", fyEnd(p.fy));
  const { data, error, count } = await q.order(p.sort, { ascending: p.dir === "asc" }).order("id", { ascending: true }).range(p.from, p.to);
  if (error) throw error;
  const rows = (data ?? []) as InvoiceRow[];
  const claims = await pendingClaims(supabase, rows.map((r) => r.id).filter((v): v is string => !!v));
  return { rows: rows.map((r) => toInvoice(r, claims)), total: count ?? 0 };
}

export interface InvoiceSummary {
  /** Everything still due, in paise. */
  outstandingPaise: Paise;
  dueCount: number;
  overdueCount: number;
  overduePaise: Paise;
  /** The earliest due date among invoices still due. */
  nextDue: DateString | null;
  /** The invoices still due, soonest first (at most `limit`). */
  due: PortalInvoice[];
}

/** What the client owes (§7.22 Home "outstanding invoices with Pay"). */
export async function getInvoiceSummary(supabase: ServerSupabase, limit = 5): Promise<InvoiceSummary> {
  const { data, error } = await supabase
    .from("portal_invoices")
    .select(INVOICE_COLUMNS)
    .in("status", ["sent", "partially_paid", "disputed"])
    .gt("outstanding_amount", 0)
    .is("cancelled_at", null)
    .order("due_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as InvoiceRow[];
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  for (const r of rows) {
    const p = toPaise(Number(r.outstanding_amount ?? 0));
    outstanding += p;
    if (r.is_overdue) {
      overdue += p;
      overdueCount += 1;
    }
  }
  const shown = rows.slice(0, limit);
  const claims = await pendingClaims(supabase, shown.map((r) => r.id).filter((v): v is string => !!v));
  return {
    outstandingPaise: outstanding,
    dueCount: rows.length,
    overdueCount,
    overduePaise: overdue,
    nextDue: rows[0]?.due_date ?? null,
    due: shown.map((r) => toInvoice(r, claims)),
  };
}

export interface PortalReceipt {
  id: string;
  receiptNumber: string;
  invoiceId: string;
  invoiceNumber: string | null;
  paymentDate: DateString;
  amountReceived: number;
  tdsAmount: number;
  method: string;
  reference: string | null;
  reversed: boolean;
}

/** The client's payment receipts (portal_payment_receipts), newest first, paged in SQL. */
export async function listReceipts(supabase: ServerSupabase, p: { from: number; to: number }): Promise<Page<PortalReceipt>> {
  const { data, error, count } = await supabase
    .from("portal_payment_receipts")
    .select("id, receipt_number, invoice_id, invoice_number, payment_date, amount_received, tds_amount, method, reference, reversed_at", { count: "exact" })
    .order("payment_date", { ascending: false })
    .order("id", { ascending: true })
    .range(p.from, p.to);
  if (error) throw error;
  return {
    rows: (data ?? []).map((r) => ({
      id: r.id ?? "",
      receiptNumber: r.receipt_number ?? "",
      invoiceId: r.invoice_id ?? "",
      invoiceNumber: r.invoice_number,
      paymentDate: r.payment_date ?? "",
      amountReceived: Number(r.amount_received ?? 0),
      tdsAmount: Number(r.tds_amount ?? 0),
      method: r.method ?? "other",
      reference: r.reference,
      reversed: Boolean(r.reversed_at),
    })),
    total: count ?? 0,
  };
}

export interface PortalCreditNote {
  id: string;
  number: string;
  invoiceNumber: string | null;
  issueDate: DateString;
  reason: string | null;
  total: number;
}

/** Credit notes on the client's invoices (portal_credit_notes), newest first. */
export async function listCreditNotes(supabase: ServerSupabase, limit = 20): Promise<PortalCreditNote[]> {
  const { data, error } = await supabase
    .from("portal_credit_notes")
    .select("id, credit_note_number, invoice_number, issue_date, reason, total_amount")
    .order("issue_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((c) => ({
    id: c.id ?? "",
    number: c.credit_note_number ?? "",
    invoiceNumber: c.invoice_number,
    issueDate: c.issue_date ?? "",
    reason: c.reason,
    total: Number(c.total_amount ?? 0),
  }));
}

export interface PortalInvoiceLine {
  id: string;
  description: string;
  sacCode: string | null;
  quantity: number;
  rate: number;
  amount: number;
  taxRate: number;
  isReimbursement: boolean;
}

export interface PortalInvoiceDetail {
  invoice: PortalInvoice;
  billedTo: { name: string | null; address: string | null; gstin: string | null };
  placeOfSupplyCode: string | null;
  firmGstin: string | null;
  reverseCharge: boolean;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  reimbursement: number;
  roundOff: number;
  notes: string | null;
  terms: string | null;
  irn: string | null;
  lines: PortalInvoiceLine[];
  /** Receipts the firm recorded against this invoice, newest first (reversed ones included, marked). */
  receipts: PortalReceipt[];
  creditNotes: PortalCreditNote[];
}

const INVOICE_DETAIL_COLUMNS = `${INVOICE_COLUMNS}, client_name_snapshot, client_address_snapshot, client_gstin_snapshot, place_of_supply_code, firm_gstin_snapshot, reverse_charge, taxable_amount, cgst_amount, sgst_amount, igst_amount, reimbursement_amount, round_off, notes, terms, irn`;

/**
 * One of the client's issued invoices for /portal/invoices/<id> ("View & pay", the link in the
 * invoice email, reminders and hand-offs): the invoice as billed, its lines, receipts and credit
 * notes, and any "I've paid" still waiting. Null when it isn't the client's (portal_invoices shows
 * only their own issued invoices: drafts, held invoices and other clients' are simply absent).
 */
export async function getPortalInvoiceDetail(supabase: ServerSupabase, id: string): Promise<PortalInvoiceDetail | null> {
  const { data, error } = await supabase.from("portal_invoices").select(INVOICE_DETAIL_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as InvoiceRow & {
    client_name_snapshot: string | null;
    client_address_snapshot: string | null;
    client_gstin_snapshot: string | null;
    place_of_supply_code: string | null;
    firm_gstin_snapshot: string | null;
    reverse_charge: boolean | null;
    taxable_amount: number | null;
    cgst_amount: number | null;
    sgst_amount: number | null;
    igst_amount: number | null;
    reimbursement_amount: number | null;
    round_off: number | null;
    notes: string | null;
    terms: string | null;
    irn: string | null;
  };
  const [items, receipts, credits, claims] = await Promise.all([
    supabase.from("portal_invoice_items").select("id, description, sac_code, quantity, rate, amount, tax_rate, is_reimbursement, sort_order").eq("invoice_id", id).order("sort_order", { ascending: true }).order("id", { ascending: true }).limit(200),
    supabase
      .from("portal_payment_receipts")
      .select("id, receipt_number, invoice_id, invoice_number, payment_date, amount_received, tds_amount, method, reference, reversed_at")
      .eq("invoice_id", id)
      .order("payment_date", { ascending: false })
      .order("id", { ascending: true })
      .limit(100),
    supabase.from("portal_credit_notes").select("id, credit_note_number, invoice_number, issue_date, reason, total_amount").eq("invoice_id", id).order("issue_date", { ascending: false }).limit(50),
    pendingClaims(supabase, [id]),
  ]);
  for (const r of [items, receipts, credits]) if (r.error) throw r.error;
  return {
    invoice: toInvoice(row, claims),
    billedTo: { name: row.client_name_snapshot, address: row.client_address_snapshot, gstin: row.client_gstin_snapshot },
    placeOfSupplyCode: row.place_of_supply_code,
    firmGstin: row.firm_gstin_snapshot,
    reverseCharge: Boolean(row.reverse_charge),
    taxable: Number(row.taxable_amount ?? 0),
    cgst: Number(row.cgst_amount ?? 0),
    sgst: Number(row.sgst_amount ?? 0),
    igst: Number(row.igst_amount ?? 0),
    reimbursement: Number(row.reimbursement_amount ?? 0),
    roundOff: Number(row.round_off ?? 0),
    notes: row.notes,
    terms: row.terms,
    irn: row.irn,
    lines: (items.data ?? []).map((i) => ({
      id: i.id ?? "",
      description: i.description ?? "",
      sacCode: i.sac_code,
      quantity: Number(i.quantity ?? 1),
      rate: Number(i.rate ?? 0),
      amount: Number(i.amount ?? 0),
      taxRate: Number(i.tax_rate ?? 0),
      isReimbursement: Boolean(i.is_reimbursement),
    })),
    receipts: (receipts.data ?? []).map((r) => ({
      id: r.id ?? "",
      receiptNumber: r.receipt_number ?? "",
      invoiceId: r.invoice_id ?? "",
      invoiceNumber: r.invoice_number,
      paymentDate: r.payment_date ?? "",
      amountReceived: Number(r.amount_received ?? 0),
      tdsAmount: Number(r.tds_amount ?? 0),
      method: r.method ?? "other",
      reference: r.reference,
      reversed: Boolean(r.reversed_at),
    })),
    creditNotes: (credits.data ?? []).map((c) => ({
      id: c.id ?? "",
      number: c.credit_note_number ?? "",
      invoiceNumber: c.invoice_number,
      issueDate: c.issue_date ?? "",
      reason: c.reason,
      total: Number(c.total_amount ?? 0),
    })),
  };
}

export interface PayDetails {
  payee: string;
  bank: { name: string | null; accountName: string | null; accountNumber: string | null; ifsc: string | null; branch: string | null } | null;
  /** Null when the firm has no usable UPI ID. */
  upi: { id: string; payeeName: string } | null;
}

/** The firm's bank and UPI details for the Pay dialog (public_firm_profile, §4.6). */
export function payDetailsOf(firm: FirmProfile): PayDetails {
  return { payee: firm.legalName ?? firm.firmName, bank: firm.bank, upi: firm.upi };
}

export interface UpiForInvoice {
  /** upi://pay?pa=…&pn=…&am=…&tn=<invoice no>&cu=INR (§7.22). */
  url: string;
  /** The same link as a QR code, a PNG data URL. */
  qrDataUrl: string | null;
}

/**
 * The UPI link and QR for paying what is still due on an invoice (§7.22). Null when the firm has no
 * valid UPI ID or nothing is due. The QR never fails the page: without it, the link and the UPI ID
 * still show.
 */
export async function upiForInvoice(details: PayDetails, inv: Pick<PortalInvoice, "invoiceNumber" | "outstanding" | "payable">): Promise<UpiForInvoice | null> {
  if (!details.upi || !inv.payable) return null;
  const amountPaise = toPaise(inv.outstanding);
  let url: string;
  try {
    url = upiPayUrl({ upiId: details.upi.id, payee: details.upi.payeeName, amountPaise, note: paymentNote(inv.invoiceNumber) });
  } catch {
    return null;
  }
  try {
    const png = await qrPng(url, { size: 264 });
    return { url, qrDataUrl: `data:image/png;base64,${png.toString("base64")}` };
  } catch {
    return { url, qrDataUrl: null };
  }
}

// =================================================================================================
// Messages (portal_messages, 0175)
// =================================================================================================

export interface PortalAttachment {
  documentId: string;
  title: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface PortalMessage {
  id: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  senderName: string | null;
  createdAt: string;
  sentAt: string | null;
  readAt: string | null;
  attachments: PortalAttachment[];
}

type MessageRow = {
  id: string | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
  sender_name: string | null;
  created_at: string | null;
  sent_at: string | null;
  read_at: string | null;
  attachment_count: number | null;
};

async function attachmentsOf(supabase: ServerSupabase, messageIds: string[]): Promise<Map<string, PortalAttachment[]>> {
  const out = new Map<string, PortalAttachment[]>();
  if (messageIds.length === 0) return out;
  const { data, error } = await supabase
    .from("message_attachments")
    .select("message_id, documents(id, title, file_name, mime_type, file_size, deleted_at)")
    .in("message_id", messageIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  for (const a of (data ?? []) as unknown as Array<{ message_id: string; documents: { id: string; title: string; file_name: string; mime_type: string; file_size: number; deleted_at: string | null } | null }>) {
    const d = a.documents;
    if (!d || d.deleted_at) continue;
    const list = out.get(a.message_id) ?? [];
    list.push({ documentId: d.id, title: d.title, fileName: d.file_name, mimeType: d.mime_type, fileSize: d.file_size });
    out.set(a.message_id, list);
  }
  return out;
}

function toMessage(r: MessageRow, attachments: Map<string, PortalAttachment[]>): PortalMessage {
  const id = r.id ?? "";
  return {
    id,
    direction: r.direction === "inbound" ? "inbound" : "outbound",
    subject: r.subject,
    body: r.body ?? "",
    senderName: r.sender_name,
    createdAt: r.created_at ?? "",
    sentAt: r.sent_at,
    readAt: r.read_at,
    attachments: attachments.get(id) ?? [],
  };
}

/**
 * The thread with the firm, oldest first: the latest `limit` messages, or the `limit` before
 * `before` (an ISO timestamp) for "Show earlier messages".
 */
export async function listThread(supabase: ServerSupabase, p: { limit: number; before?: string | null }): Promise<{ messages: PortalMessage[]; hasEarlier: boolean }> {
  let q = supabase
    .from("portal_messages")
    .select("id, direction, subject, body, sender_name, created_at, sent_at, read_at, attachment_count")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(p.limit + 1);
  if (p.before) q = q.lt("created_at", p.before);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as MessageRow[];
  const hasEarlier = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  const withFiles = page.filter((r) => (r.attachment_count ?? 0) > 0).map((r) => r.id).filter((v): v is string => !!v);
  const attachments = await attachmentsOf(supabase, withFiles);
  return { messages: page.map((r) => toMessage(r, attachments)).reverse(), hasEarlier };
}

/** The firm's latest messages for Home, newest first, and how many are unread. */
export async function getLatestFromFirm(supabase: ServerSupabase, limit: number): Promise<{ messages: PortalMessage[]; unread: number }> {
  const [latest, unread] = await Promise.all([
    supabase
      .from("portal_messages")
      .select("id, direction, subject, body, sender_name, created_at, sent_at, read_at, attachment_count")
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase.from("portal_messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").is("read_at", null),
  ]);
  if (latest.error) throw latest.error;
  if (unread.error) throw unread.error;
  const none = new Map<string, PortalAttachment[]>();
  return { messages: ((latest.data ?? []) as MessageRow[]).map((r) => toMessage(r, none)), unread: unread.count ?? 0 };
}

/** Invoices with their UPI link and QR (§7.22 Pay dialog), for the lists that offer Pay. */
export async function withUpi<T extends Pick<PortalInvoice, "invoiceNumber" | "outstanding" | "payable">>(details: PayDetails, invoices: T[]): Promise<Array<T & { upi: UpiForInvoice | null }>> {
  return Promise.all(invoices.map(async (inv) => ({ ...inv, upi: await upiForInvoice(details, inv) })));
}

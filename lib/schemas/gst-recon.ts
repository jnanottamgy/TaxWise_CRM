import { z } from "zod";
import { financialYearOf, isDateString, toDateString, type DateString, type FinancialYear } from "@/lib/domain/fy";
import {
  AMOUNT_FIELDS,
  GSTR2B_SECTIONS,
  GST_DOC_TYPES,
  GST_DOC_TYPE_LABELS,
  REGISTER_FIELDS,
  gstDocRow,
  isCreditDoc,
  periodLabelOf,
  totalTax,
  type DocAmounts,
  type GstDocRow,
  type GstDocType,
  type RegisterField,
} from "@/lib/domain/gstr2b";
import {
  IMS_ACTIONS,
  IMS_ACTION_LABELS,
  MATCH_TIER_LABELS,
  RECON_BUCKETS,
  RECON_BUCKET_LABELS,
  RECON_RESOLUTIONS,
  formatDocDate,
  type ImsAction,
  type MatchTier,
  type OpenBucket,
  type OpenItem,
  type ReconBucket,
  type ReconEntry,
  type ReconResolution,
} from "@/lib/domain/recon";
import { formatINR, type Paise } from "@/lib/domain/money";
import type { StatusTone } from "@/lib/status";

/**
 * GST reconciliation workpapers (§6.12, §7.8.1): the shared zod schemas for the forms and the
 * server actions, the month (MMYYYY) helpers, the words and tones of buckets, resolutions and IMS
 * actions, the table state of the lists, and the compact form a reconciliation line is stored in
 * (gst_recon_entries.data, amounts in integer paise). Client-safe and pure.
 */

// =================================================================================================
// Periods (MMYYYY, as gst_recon_runs.period stores it)
// =================================================================================================

export const PERIOD_PATTERN = /^(0[1-9]|1[0-2])(\d{4})$/;

export function isPeriod(value: unknown): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

/** `"092026"` → `"Sep 2026"`; the input when it isn't MMYYYY. */
export function periodLabel(period: string | null | undefined): string {
  return periodLabelOf(period) ?? (period ?? "");
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `"092026"` → `"September 2026"`. */
export function periodLongLabel(period: string): string {
  const m = PERIOD_PATTERN.exec(period);
  return m ? `${MONTH_NAMES[Number(m[1]) - 1]} ${m[2]}` : period;
}

/** The first day of the month: `"092026"` → `"2026-09-01"`. */
export function periodStart(period: string): DateString {
  const m = PERIOD_PATTERN.exec(period);
  if (!m) throw new Error(`not a period: ${period}`);
  return toDateString(Number(m[2]), Number(m[1]), 1);
}

/** The month a date falls in: `"2026-09-18"` → `"092026"`. */
export function periodOf(date: DateString): string {
  return `${date.slice(5, 7)}${date.slice(0, 4)}`;
}

/** The period `months` later (negative: earlier). */
export function shiftPeriod(period: string, months: number): string {
  const m = PERIOD_PATTERN.exec(period);
  if (!m) throw new Error(`not a period: ${period}`);
  const index = Number(m[2]) * 12 + (Number(m[1]) - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(month).padStart(2, "0")}${year}`;
}

/** The financial year a month belongs to (§0.1 rule 13: 1 April – 31 March). */
export function periodFinancialYear(period: string): FinancialYear {
  return financialYearOf(periodStart(period));
}

/** Sortable form, `YYYYMM`, so months compare as text. */
export function periodSortKey(period: string): string {
  return `${period.slice(2)}${period.slice(0, 2)}`;
}

/**
 * The month reconciled by default: last month. GSTR-2B for a month is generated on the 14th of the
 * next month and is reconciled before that month's GSTR-3B.
 */
export function defaultPeriod(today: DateString): string {
  return shiftPeriod(periodOf(today), -1);
}

/** The months the picker offers: this month back two years, newest first. */
export function periodChoices(today: DateString, count = 25): Array<{ value: string; label: string }> {
  const current = periodOf(today);
  return Array.from({ length: count }, (_, i) => {
    const value = shiftPeriod(current, -i);
    return { value, label: periodLongLabel(value) };
  });
}

// =================================================================================================
// Vocabulary
// =================================================================================================

export type ChipMeta = { label: string; tone: StatusTone; meaning: string };

export const BUCKET_META: Record<ReconBucket, ChipMeta> = {
  matched: { label: RECON_BUCKET_LABELS.matched, tone: "success", meaning: "Matched: in GSTR-2B and in the books, within ₹1 on every tax head. Claim the ITC." },
  mismatch: {
    label: RECON_BUCKET_LABELS.mismatch,
    tone: "danger",
    meaning: "Mismatch: the same document is in GSTR-2B and the books, but a tax head differs by more than ₹1. Confirm the right figures with the supplier.",
  },
  missing_in_books: {
    label: RECON_BUCKET_LABELS.missing_in_books,
    tone: "warning",
    meaning: "In 2B, not in books: the supplier reported it but the client hasn't booked it (unclaimed ITC). Book it, or reject it on the IMS if it isn't the client's purchase.",
  },
  missing_in_2b: {
    label: RECON_BUCKET_LABELS.missing_in_2b,
    tone: "danger",
    meaning: "In books, not in 2B: booked by the client but not yet reported by the supplier (ITC at risk). Follow up with the supplier.",
  },
};

/** The tab names (and the bucket order) of a run's results. */
export const BUCKET_SHORT_LABELS: Record<ReconBucket, string> = {
  matched: "Matched",
  mismatch: "Mismatch",
  missing_in_books: "Not in books",
  missing_in_2b: "Not in 2B",
};

export const RESOLUTION_META: Record<ReconResolution, ChipMeta> = {
  open: { label: "Open", tone: "warning", meaning: "Open: nobody has settled this line yet. It carries into next month's reconciliation." },
  follow_up_supplier: {
    label: "Following up",
    tone: "info",
    meaning: "Following up: the supplier has been asked to file or correct their GSTR-1. It stays open and carries into next month until the supplier acts.",
  },
  accepted: { label: "Settled", tone: "success", meaning: "Settled: the difference is explained and dealt with (booked, claimed or accepted as it is). It doesn't carry forward." },
  ignore: { label: "Ignored", tone: "muted", meaning: "Ignored, with the reason in the note: the line needs no action. It doesn't carry forward." },
};

export const RESOLUTION_ACTION_LABELS: Record<ReconResolution, string> = {
  open: "Reopen",
  follow_up_supplier: "Following up supplier",
  accepted: "Settled",
  ignore: "Ignore",
};

export const IMS_META: Record<ImsAction, ChipMeta> = {
  accept: { label: IMS_ACTION_LABELS.accept, tone: "success", meaning: "Accept on the IMS: the document is the client's and agrees with the books, so its ITC flows into GSTR-3B." },
  reject: { label: IMS_ACTION_LABELS.reject, tone: "danger", meaning: "Reject on the IMS: the document isn't the client's, or is wrong. The supplier has to correct it, and no ITC is taken on it." },
  keep_pending: {
    label: IMS_ACTION_LABELS.keep_pending,
    tone: "warning",
    meaning: "Keep pending on the IMS: decide in a later month (for example, the goods haven't arrived, or the amounts are being confirmed). No ITC is taken until it is accepted.",
  },
};

export const TIER_LABELS: Record<MatchTier, string> = MATCH_TIER_LABELS;

export { IMS_ACTIONS, RECON_BUCKETS, RECON_RESOLUTIONS };
export type { ImsAction, ReconBucket, ReconResolution };

// =================================================================================================
// Table state
// =================================================================================================

export const RUN_LIST_SORTABLE = ["period_start", "created_at", "client_name", "itc_at_risk_paise", "unclaimed_itc_paise", "open_count"] as const;
export const RUN_LIST_FILTERS = { client: null, period: null, open: ["1"], history: ["1"], gstin: ["mismatch"] } as const;
export const RUN_LIST_DEFAULT_SORT = { sort: "period_start" as const, dir: "desc" as const };

export const RUN_TABS = ["summary", "mismatch", "missing_in_2b", "missing_in_books", "matched", "suppliers", "ims", "carried"] as const;
export type RunTab = (typeof RUN_TABS)[number];

export const RUN_TAB_LABELS: Record<RunTab, string> = {
  summary: "Summary",
  mismatch: BUCKET_SHORT_LABELS.mismatch,
  missing_in_2b: BUCKET_SHORT_LABELS.missing_in_2b,
  missing_in_books: BUCKET_SHORT_LABELS.missing_in_books,
  matched: BUCKET_SHORT_LABELS.matched,
  suppliers: "Suppliers",
  ims: "IMS actions",
  carried: "Carried forward",
};

export function isRunTab(value: unknown): value is RunTab {
  return typeof value === "string" && (RUN_TABS as readonly string[]).includes(value);
}

export const ENTRY_SORTABLE = ["supplier_name", "doc_date", "doc_number", "itc_paise", "itc_difference_paise", "portal_taxable_paise", "books_taxable_paise", "resolution", "first_seen_period"] as const;
export const ENTRY_FILTERS = { resolution: RECON_RESOLUTIONS, supplier: null, ims: IMS_ACTIONS, decided: ["yes", "no"] } as const;
export const ENTRY_DEFAULT_SORT = { sort: "itc_paise" as const, dir: "desc" as const };

export const SUPPLIER_SORTABLE = ["itc_at_risk_paise", "unclaimed_itc_paise", "open_count", "supplier_name", "mismatch_difference_paise"] as const;
export const SUPPLIER_FILTERS = { chase: ["1"] } as const;
export const SUPPLIER_DEFAULT_SORT = { sort: "itc_at_risk_paise" as const, dir: "desc" as const };

// =================================================================================================
// Stored lines (gst_recon_entries.data)
// =================================================================================================

/** What a line stores besides its bucket: both documents, the deltas and the notes (amounts in paise). */
export type StoredEntryData = {
  portal: GstDocRow | null;
  books: GstDocRow | null;
  deltas: DocAmounts | null;
  dateDeltaDays: number | null;
  itc: { portal: Paise; books: Paise };
  notes: string[];
  /** Set on a line of this month that closes an open line of an earlier month. */
  cleared?: { firstSeenPeriod: string; message: string; amountsAgree: boolean; tier: MatchTier } | null;
  /** Set on a carried line: how many months it has been open. */
  carried?: { monthsOpen: number | null } | null;
};

const DOC_DEFAULTS: Partial<Record<keyof GstDocRow, unknown>> = {
  supplierName: null,
  docDate: null,
  originalDocNumber: null,
  originalDocDate: null,
  reverseCharge: false,
  itcAvailable: null,
  itcUnavailableReason: null,
  portCode: null,
  supplierPeriod: null,
};

/** A document as stored: the fields that carry information (defaults left out, amounts in paise). */
export function compactDoc(row: GstDocRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    section: row.section,
    supplierGstin: row.supplierGstin,
    docType: row.docType,
    docNumber: row.docNumber,
    ref: row.ref,
  };
  for (const f of AMOUNT_FIELDS) out[f] = row[f];
  for (const [key, def] of Object.entries(DOC_DEFAULTS)) {
    const v = row[key as keyof GstDocRow];
    if (v !== def && v !== undefined) out[key] = v;
  }
  return out;
}

const SECTIONS = new Set<string>([...GSTR2B_SECTIONS, "register"]);
const DOC_TYPES = new Set<string>(GST_DOC_TYPES);

function int(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** A stored document back as a full row; null when the value isn't a document. */
export function expandDoc(value: unknown): GstDocRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const section = typeof v.section === "string" && SECTIONS.has(v.section) ? (v.section as GstDocRow["section"]) : "register";
  const docType = typeof v.docType === "string" && DOC_TYPES.has(v.docType) ? (v.docType as GstDocType) : "invoice";
  const date = (x: unknown) => (typeof x === "string" && isDateString(x) ? x : null);
  return gstDocRow({
    section,
    supplierGstin: typeof v.supplierGstin === "string" ? v.supplierGstin : "",
    supplierName: str(v.supplierName),
    docType,
    docNumber: typeof v.docNumber === "string" ? v.docNumber : "",
    docDate: date(v.docDate),
    taxable: int(v.taxable),
    igst: int(v.igst),
    cgst: int(v.cgst),
    sgst: int(v.sgst),
    cess: int(v.cess),
    ref: typeof v.ref === "string" ? v.ref : "",
    originalDocNumber: str(v.originalDocNumber),
    originalDocDate: date(v.originalDocDate),
    reverseCharge: v.reverseCharge === true,
    itcAvailable: typeof v.itcAvailable === "boolean" ? v.itcAvailable : null,
    itcUnavailableReason: str(v.itcUnavailableReason),
    portCode: str(v.portCode),
    supplierPeriod: str(v.supplierPeriod),
  });
}

/** The data column for one engine entry. */
export function entryData(entry: ReconEntry, extra: Pick<StoredEntryData, "cleared" | "carried"> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    portal: entry.portal ? compactDoc(entry.portal) : null,
    books: entry.books ? compactDoc(entry.books) : null,
    deltas: entry.deltas,
    dateDeltaDays: entry.dateDeltaDays,
    itc: entry.itc,
    notes: entry.notes,
  };
  if (extra.cleared) out.cleared = extra.cleared;
  if (extra.carried) out.carried = extra.carried;
  return out;
}

function amounts(v: unknown): DocAmounts | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return { taxable: int(r.taxable), igst: int(r.igst), cgst: int(r.cgst), sgst: int(r.sgst), cess: int(r.cess) };
}

/** Reads a stored data column; tolerant of older or partial rows. */
export function readEntryData(value: unknown): StoredEntryData {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const itc = v.itc && typeof v.itc === "object" ? (v.itc as Record<string, unknown>) : {};
  const cleared = v.cleared && typeof v.cleared === "object" ? (v.cleared as Record<string, unknown>) : null;
  const carried = v.carried && typeof v.carried === "object" ? (v.carried as Record<string, unknown>) : null;
  return {
    portal: expandDoc(v.portal),
    books: expandDoc(v.books),
    deltas: amounts(v.deltas),
    dateDeltaDays: typeof v.dateDeltaDays === "number" ? v.dateDeltaDays : null,
    itc: { portal: int(itc.portal), books: int(itc.books) },
    notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === "string") : [],
    cleared: cleared
      ? {
          firstSeenPeriod: typeof cleared.firstSeenPeriod === "string" ? cleared.firstSeenPeriod : "",
          message: typeof cleared.message === "string" ? cleared.message : "",
          amountsAgree: cleared.amountsAgree !== false,
          tier: cleared.tier === "loose" || cleared.tier === "fuzzy" ? cleared.tier : "exact",
        }
      : null,
    carried: carried ? { monthsOpen: typeof carried.monthsOpen === "number" ? carried.monthsOpen : null } : null,
  };
}

/** A saved line as an open item for the next month's carry-forward (§6.12). */
export function openItemFromLine(line: {
  entry_key: string | null;
  id: string;
  bucket: string;
  first_seen_period: string | null;
  supplier_gstin: string;
  supplier_name: string | null;
  data: unknown;
}, runPeriod: string): OpenItem | null {
  if (line.bucket !== "mismatch" && line.bucket !== "missing_in_books" && line.bucket !== "missing_in_2b") return null;
  const d = readEntryData(line.data);
  return {
    key: line.entry_key ?? line.id,
    bucket: line.bucket as OpenBucket,
    firstSeenPeriod: line.first_seen_period && isPeriod(line.first_seen_period) ? line.first_seen_period : runPeriod,
    supplierGstin: line.supplier_gstin,
    supplierName: line.supplier_name,
    portal: d.portal,
    books: d.books,
  };
}

/** The document a line is about (2B side first), for labels. */
export function lineDoc(d: Pick<StoredEntryData, "portal" | "books">): GstDocRow | null {
  return d.portal ?? d.books;
}

export function docTypeLabel(docType: string | null | undefined): string {
  return docType && DOC_TYPES.has(docType) ? GST_DOC_TYPE_LABELS[docType as GstDocType] : "Document";
}

// =================================================================================================
// The run's stored summary (gst_recon_runs.summary)
// =================================================================================================

export type StoredSupplier = {
  supplierGstin: string;
  supplierName: string | null;
  counts: Record<ReconBucket, number>;
  itcAtRisk: Paise;
  unclaimedItc: Paise;
  mismatchDifference: Paise;
  chase: boolean;
};

export type StoredRunSummary = {
  version: 1;
  summary: {
    buckets: Record<ReconBucket, { count: number; portalItc: Paise; booksItc: Paise }>;
    byTier: Record<MatchTier, number>;
    documents: { portal: number; books: number };
    itc: {
      per2b: Paise;
      notAvailablePer2b: Paise;
      perBooks: Paise;
      matched: Paise;
      mismatched: Paise;
      mismatchDifference: Paise;
      unclaimed: Paise;
      reversalPending: Paise;
      atRisk: Paise;
      atRiskMissingIn2b: Paise;
      atRiskExcessOverTwoB: Paise;
      available: Paise;
    };
  };
  suppliers: StoredSupplier[];
  warnings: Array<{ code: string; message: string; supplierGstin: string | null; docNumber: string | null }>;
  gstr2b: { gstin: string | null; period: string | null; generatedOn: string | null; counts: Record<string, number>; documents: number };
  register: { total: number; accepted: number; rejected: number; skipped: number; fileName: string | null; sheet: string | null };
  carryForward: { fromRunId: string; fromPeriod: string; cleared: number; stillOpen: number } | null;
};

const ZERO_BUCKET = { count: 0, portalItc: 0, booksItc: 0 };

/** Reads a stored summary; missing parts are zero (fixture rows and older runs stay readable). */
export function readRunSummary(value: unknown): StoredRunSummary {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const s = v.summary && typeof v.summary === "object" ? (v.summary as Record<string, unknown>) : {};
  const b = s.buckets && typeof s.buckets === "object" ? (s.buckets as Record<string, Record<string, unknown>>) : {};
  const itc = s.itc && typeof s.itc === "object" ? (s.itc as Record<string, unknown>) : {};
  const tier = s.byTier && typeof s.byTier === "object" ? (s.byTier as Record<string, unknown>) : {};
  const docs = s.documents && typeof s.documents === "object" ? (s.documents as Record<string, unknown>) : {};
  const buckets = {} as StoredRunSummary["summary"]["buckets"];
  for (const k of RECON_BUCKETS) {
    const x = b[k] ?? {};
    buckets[k] = { ...ZERO_BUCKET, count: int(x.count), portalItc: int(x.portalItc), booksItc: int(x.booksItc) };
  }
  const g = v.gstr2b && typeof v.gstr2b === "object" ? (v.gstr2b as Record<string, unknown>) : {};
  const reg = v.register && typeof v.register === "object" ? (v.register as Record<string, unknown>) : {};
  const cf = v.carryForward && typeof v.carryForward === "object" ? (v.carryForward as Record<string, unknown>) : null;
  return {
    version: 1,
    summary: {
      buckets,
      byTier: { exact: int(tier.exact), loose: int(tier.loose), fuzzy: int(tier.fuzzy) },
      documents: { portal: int(docs.portal), books: int(docs.books) },
      itc: {
        per2b: int(itc.per2b),
        notAvailablePer2b: int(itc.notAvailablePer2b),
        perBooks: int(itc.perBooks),
        matched: int(itc.matched),
        mismatched: int(itc.mismatched),
        mismatchDifference: int(itc.mismatchDifference),
        unclaimed: int(itc.unclaimed),
        reversalPending: int(itc.reversalPending),
        atRisk: int(itc.atRisk),
        atRiskMissingIn2b: int(itc.atRiskMissingIn2b),
        atRiskExcessOverTwoB: int(itc.atRiskExcessOverTwoB),
        available: int(itc.available),
      },
    },
    suppliers: Array.isArray(v.suppliers) ? (v.suppliers as StoredSupplier[]) : [],
    warnings: Array.isArray(v.warnings) ? (v.warnings as StoredRunSummary["warnings"]) : [],
    gstr2b: {
      gstin: str(g.gstin),
      period: str(g.period),
      generatedOn: str(g.generatedOn),
      counts: g.counts && typeof g.counts === "object" ? (g.counts as Record<string, number>) : {},
      documents: int(g.documents),
    },
    register: {
      total: int(reg.total),
      accepted: int(reg.accepted),
      rejected: int(reg.rejected),
      skipped: int(reg.skipped),
      fileName: str(reg.fileName),
      sheet: str(reg.sheet),
    },
    carryForward: cf
      ? { fromRunId: String(cf.fromRunId ?? ""), fromPeriod: String(cf.fromPeriod ?? ""), cleared: int(cf.cleared), stillOpen: int(cf.stillOpen) }
      : null,
  };
}

// =================================================================================================
// Supplier follow-up (§7.8.1 "Draft supplier follow-up", §7.13.2)
// =================================================================================================

export type FollowUpLine = {
  bucket: ReconBucket;
  docType: string;
  docNumber: string;
  docDate: string | null;
  taxable: Paise;
  itcBooks: Paise;
  itcPortal: Paise;
};

/**
 * One line of the follow-up per document the supplier must act on: the ones booked but not in
 * GSTR-2B, then the ones whose GST differs.
 */
export function followUpLineText(l: FollowUpLine): string {
  const label = `${docTypeLabel(l.docType)} ${l.docNumber} dated ${formatDocDate(l.docDate)}`;
  if (l.bucket === "mismatch") {
    return `${label}: our books show GST ${formatINR(Math.abs(l.itcBooks))}, GSTR-2B shows ${formatINR(Math.abs(l.itcPortal))}.`;
  }
  return `${label}: taxable ${formatINR(Math.abs(l.taxable))}, GST ${formatINR(Math.abs(l.itcBooks))}, not in GSTR-2B.`;
}

/** The `{{missing_items}}` of the supplier follow-up template, for one supplier. */
export function supplierMissingItems(supplier: { name: string | null; gstin: string }, lines: readonly FollowUpLine[]): string {
  const ordered = [...lines].sort((a, b) => (a.bucket === b.bucket ? 0 : a.bucket === "missing_in_2b" ? -1 : 1));
  const head = `${supplier.name ?? "Supplier"} (GSTIN ${supplier.gstin || "not given"})`;
  return [head, ...ordered.map((l) => `• ${followUpLineText(l)}`)].join("\n");
}

/** The draft used when the firm has no supplier follow-up template. */
export function defaultSupplierFollowUp(input: { contactName: string | null; periodText: string; missingItems: string; channel: "whatsapp" | "email"; senderName: string; firmName: string }): string {
  const hello = input.channel === "email" ? `Dear ${input.contactName ?? "Sir/Madam"},` : `Hi${input.contactName ? ` ${input.contactName}` : ""},`;
  const body = [
    hello,
    "",
    `While reconciling your purchases with GSTR-2B for ${input.periodText}, we found invoices from this supplier that are missing from their GST return, or don't match it:`,
    "",
    input.missingItems,
    "",
    "Until the supplier files or corrects their GSTR-1, the input tax credit on these invoices is at risk. Please ask them to do so at the earliest; we will check again once GSTR-2B is updated.",
  ];
  if (input.channel === "email") body.push("", "Warm regards,", input.senderName, input.firmName);
  return body.join("\n");
}

export const FOLLOW_UP_SUBJECT = (firmName: string, periodText: string, supplierName: string | null) =>
  `${firmName} | GST input tax credit for ${periodText}: ${supplierName ?? "supplier"} to follow up`;

/** Template names seeded for this hand-off (§16, supabase/seed/20_templates.sql). */
export const FOLLOW_UP_TEMPLATE_NAMES = { whatsapp: "Supplier follow-up (WhatsApp)", email: "Supplier follow-up (email)" } as const;

// =================================================================================================
// Schemas
// =================================================================================================

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const period = z
  .string({ error: "Choose the month." })
  .trim()
  .regex(PERIOD_PATTERN, { error: "Choose the month the reconciliation is for." });

export const ClientSearchSchema = z.object({ q: z.string().trim().max(100).default("") });

export const RunLookupSchema = z.object({ clientId: uuid("client"), period });

/** The largest GSTR-2B JSON and register the app accepts (§12: 25 MB). */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export const PrepareGstr2bUploadSchema = z.object({
  clientId: uuid("client"),
  fileName: z
    .string()
    .trim()
    .min(1, { error: "The file has no name." })
    .max(200, { error: "Rename the file to under 200 characters." })
    .refine((n) => /\.json$/i.test(n), { error: "Choose the GSTR-2B JSON file downloaded from the GST portal (it ends in .json)." }),
  size: z
    .number()
    .int()
    .min(2, { error: "This file is empty." })
    .max(MAX_SOURCE_BYTES, { error: "Files can be at most 25 MB." }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: "The file couldn't be read. Choose it again." }),
});

/** Where a GSTR-2B upload lives: `<client>/gstr2b/<uuid>.json` in task-files. */
export const GSTR2B_PATH_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/gstr2b\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export const Gstr2bSourceSchema = z.object({
  path: z.string().regex(GSTR2B_PATH_PATTERN, { error: "Upload the GSTR-2B JSON again." }),
  fileName: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(MAX_SOURCE_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Gstr2bSource = z.output<typeof Gstr2bSourceSchema>;

const header = z
  .string()
  .max(200)
  .nullish()
  .transform((v) => (v ? v : null));

export const SheetChoiceSchema = z.object({
  documentId: uuid("file"),
  /** A worksheet of an XLSX; null for CSV or the first sheet with data. */
  sheet: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => (v ? v : null)),
  /** 1-based row of the header; null to find it. */
  headerRow: z.number().int().min(1).max(50).nullish().transform((v) => v ?? null),
});
export type SheetChoice = z.output<typeof SheetChoiceSchema>;

export const InspectSheetSchema = SheetChoiceSchema.extend({ clientId: uuid("client") });

export const RegisterMappingSchema = z.object(Object.fromEntries(REGISTER_FIELDS.map((f) => [f, header])) as Record<RegisterField, typeof header>);
export type RegisterMapping = Record<RegisterField, string | null>;

export const RunReconSchema = z.object({
  clientId: uuid("client"),
  period,
  gstr2b: Gstr2bSourceSchema,
  register: SheetChoiceSchema,
  mapping: RegisterMappingSchema,
  rememberMapping: z.boolean().default(true),
});
export type RunReconInput = z.input<typeof RunReconSchema>;

export const RunRefSchema = z.object({ runId: uuid("reconciliation") });

const note = z
  .string()
  .trim()
  .max(1000, { error: "Keep the note under 1,000 characters." })
  .nullish()
  .transform((v) => (v ? v : null));

export const ResolveLinesSchema = z
  .object({
    runId: uuid("reconciliation"),
    lines: z
      .array(z.object({ id: uuid("line"), updatedAt: z.string().min(10).max(40) }))
      .min(1, { error: "Choose the lines to resolve." })
      .max(1000, { error: "Resolve at most 1,000 lines at a time." }),
    resolution: z.enum(RECON_RESOLUTIONS, { error: "Choose how the lines are resolved." }),
    note,
  })
  .superRefine((v, ctx) => {
    if (v.resolution === "ignore" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Say why the lines are ignored, so the reviewer can see it." });
  });
export type ResolveLinesInput = z.input<typeof ResolveLinesSchema>;

export const ImsDecisionSchema = z.object({
  runId: uuid("reconciliation"),
  lineId: uuid("line"),
  updatedAt: z.string().min(10).max(40),
  action: z.enum(IMS_ACTIONS, { error: "Choose accept, reject or keep pending." }),
  reason: z.string().trim().min(1, { error: "Give the reason for this IMS action." }).max(1000, { error: "Keep the reason under 1,000 characters." }),
});
export type ImsDecisionInput = z.input<typeof ImsDecisionSchema>;

export const SupplierFollowedUpSchema = z.object({
  runId: uuid("reconciliation"),
  supplierGstin: z.string().trim().min(1).max(20),
  channel: z.enum(["whatsapp_handoff", "gmail_handoff"]),
});

export const SupplierLinesSchema = z.object({ runId: uuid("reconciliation"), supplierGstin: z.string().trim().min(1).max(20) });

/** The IMS sections (§6.7): only these documents get an IMS action. */
export const IMS_SECTIONS: readonly string[] = ["b2b", "b2ba", "cdnr", "cdnra"];

/** True when the line's 2B document reduces ITC (a credit note). */
export function isCreditLine(docType: string | null | undefined): boolean {
  return Boolean(docType && DOC_TYPES.has(docType) && isCreditDoc(docType as GstDocType));
}

/** ITC of a document, signed (credit notes negative). */
export function docItc(row: GstDocRow | null): Paise {
  return row ? totalTax(row) : 0;
}

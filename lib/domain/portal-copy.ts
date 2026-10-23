/**
 * The client portal in plain language (§7.22): what each deadline is, for whom it matters and what
 * the firm usually needs from the client, and the words the portal uses for statuses. Pure and
 * client-safe; no I/O.
 *
 *   explainDeadline({ formCode: "GSTR-3B", type: "gstr_3b", filingPeriod: "Sep 2026", title: "GSTR-3B (monthly) for Sep 2026" })
 *     → { name: "GSTR-3B", period: "September 2026", headline: "GSTR-3B for September 2026",
 *         explanation: "your monthly GST summary return, where the tax for the month is paid",
 *         sentence: "GSTR-3B for September 2026: your monthly GST summary return, …", needs: [...] }
 *
 * Form codes are the ones the statutory calendar generates (due_date_rules.form_code, §6.7):
 * GSTR-1, IFF, GSTR-3B, PMT-06, CMP-08, GSTR-4, GSTR-7, GSTR-8, GSTR-9, GSTR-9C, ITR, ITR (belated),
 * ITR (revised), ITR-U, Form 3CA/3CB-3CD, Form 3CEB, Advance tax, TDS deposit, 24Q/26Q/27Q, Form 16,
 * Form 16A, AGM, ADT-1, AOC-4, MGT-7/MGT-7A, DPT-3, MSME-1, DIR-3 KYC Web, LLP Form 11, LLP Form 8,
 * PF/ESIC, PT (Karnataka), PT enrolment (Karnataka). Anything else falls back to its compliance type,
 * then to the deadline's own title, so nothing is ever shown without words.
 *
 * Status labels and colours are the §3.6 vocabulary (lib/status.ts); the explanations here are
 * written for the client, not for the firm's staff.
 */

import type { ComplianceType } from "@/lib/domain/enums";

// -------------------------------------------------------------------------------------------------
// Periods
// -------------------------------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};

/** The months of each FY quarter (April–March year). */
const QUARTER_MONTHS: Record<1 | 2 | 3 | 4, [string, string]> = {
  1: ["April", "June"],
  2: ["July", "September"],
  3: ["October", "December"],
  4: ["January", "March"],
};

function fyStartYear(fy: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(fy.trim());
  if (!m) return null;
  const start = Number(m[1]);
  return (start + 1) % 100 === Number(m[2]) ? start : null;
}

/**
 * A filing period in words:
 *   "Sep 2026" → "September 2026" · "Q2 2026-27" → "July to September 2026" ·
 *   "Q4 2026-27" → "January to March 2027" · "H1 2026-27" → "April to September 2026" ·
 *   "FY 2026-27" → "the year 2026-27 (April 2026 to March 2027)" ·
 *   "AY 2026-27" → "assessment year 2026-27 (income earned in 2025-26)" ·
 *   "Tax year 2026-27" → "tax year 2026-27 (April 2026 to March 2027)".
 * A trailing suffix ("FY 2026-27 (DIN 01234567)") is kept. Unknown shapes come back unchanged.
 */
export function periodInWords(label: string | null | undefined): string | null {
  const raw = label?.trim();
  if (!raw) return null;
  const suffixMatch = /^(.*?)(\s+\(.+\))$/.exec(raw);
  const base = suffixMatch ? suffixMatch[1] : raw;
  const suffix = suffixMatch ? suffixMatch[2] : "";

  const month = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(base);
  if (month && MONTHS[month[1].toLowerCase()]) return `${MONTHS[month[1].toLowerCase()]} ${month[2]}${suffix}`;

  const quarter = /^Q([1-4])\s+(\d{4}-\d{2})$/i.exec(base);
  if (quarter) {
    const start = fyStartYear(quarter[2]);
    if (start !== null) {
      const q = Number(quarter[1]) as 1 | 2 | 3 | 4;
      const [from, to] = QUARTER_MONTHS[q];
      return `${from} to ${to} ${q === 4 ? start + 1 : start}${suffix}`;
    }
  }

  const half = /^H([12])\s+(\d{4}-\d{2})$/i.exec(base);
  if (half) {
    const start = fyStartYear(half[2]);
    if (start !== null) {
      return half[1] === "1" ? `April to September ${start}${suffix}` : `October ${start} to March ${start + 1}${suffix}`;
    }
  }

  const fy = /^FY\s+(\d{4}-\d{2})$/i.exec(base);
  if (fy) {
    const start = fyStartYear(fy[1]);
    if (start !== null) return `the year ${fy[1]} (April ${start} to March ${start + 1})${suffix}`;
  }

  const ay = /^AY\s+(\d{4}-\d{2})$/i.exec(base);
  if (ay) {
    const start = fyStartYear(ay[1]);
    if (start !== null) {
      const prev = `${start - 1}-${String(start % 100).padStart(2, "0")}`;
      return `assessment year ${ay[1]} (income earned in ${prev})${suffix}`;
    }
  }

  const taxYear = /^Tax year\s+(\d{4}-\d{2})$/i.exec(base);
  if (taxYear) {
    const start = fyStartYear(taxYear[1]);
    if (start !== null) return `tax year ${taxYear[1]} (April ${start} to March ${start + 1})${suffix}`;
  }

  return raw;
}

/** The short period for a headline: "September 2026", "July to September 2026", "AY 2026-27". */
export function periodShort(label: string | null | undefined): string | null {
  const raw = label?.trim();
  if (!raw) return null;
  if (/^(AY|Tax year|FY)\s/i.test(raw)) return raw;
  return periodInWords(raw);
}

// -------------------------------------------------------------------------------------------------
// What each deadline is
// -------------------------------------------------------------------------------------------------

export interface FormCopy {
  /** The short name the client sees ("GSTR-3B", "Income tax return"). */
  name: string;
  /** What it is, in a phrase that follows "GSTR-3B for September 2026: " (lower case, no full stop). */
  explanation: string;
  /** What the firm usually needs from the client for it. Empty when nothing is usually needed. */
  needs: string[];
}

const GST_SALES = "Your sales invoices, credit notes and debit notes for the period";
const GST_PURCHASES = "Your purchase invoices and expense bills for the period";
const BANK = "Bank statements for the period";
const TDS_PAYMENTS = "Payments you made on which tax should be deducted: salaries, rent, contractors and professional fees, with each payee's PAN";
const ITR_NEEDS = [
  "Form 16 from your employer, and Form 16A or TDS certificates for other income",
  "Bank statements and interest certificates for the year",
  "Proof of investments and payments you claim deductions for (for example 80C and 80D)",
  "Capital gains statements from your broker or fund house, if you sold shares, funds or property",
];
const ROC_ACCOUNTS = "Your signed financial statements and the directors' report";

/** Monthly and quarterly variants share a code: the period decides which one applies. */
type Variant = { monthly: FormCopy; quarterly: FormCopy };

const FORMS: Record<string, FormCopy | Variant> = {
  "GSTR-1": {
    monthly: { name: "GSTR-1", explanation: "your monthly GST return of sales, so your buyers can claim their input tax credit", needs: [GST_SALES] },
    quarterly: { name: "GSTR-1", explanation: "your quarterly GST return of sales under the QRMP scheme", needs: [GST_SALES] },
  },
  IFF: {
    name: "IFF",
    explanation: "the optional statement of sales to GST-registered buyers for the month, so they can claim their credit before the quarter ends",
    needs: ["Your sales invoices to GST-registered buyers for the month"],
  },
  "GSTR-3B": {
    monthly: { name: "GSTR-3B", explanation: "your monthly GST summary return, where the tax for the month is paid", needs: [GST_SALES, GST_PURCHASES, BANK] },
    quarterly: { name: "GSTR-3B", explanation: "your quarterly GST summary return under the QRMP scheme, where the tax for the quarter is settled", needs: [GST_SALES, GST_PURCHASES, BANK] },
  },
  "PMT-06": {
    name: "GST payment (PMT-06)",
    explanation: "the GST payment for this month under the quarterly (QRMP) scheme",
    needs: ["Your sales and purchase figures for the month, so we can work out the tax"],
  },
  "CMP-08": { name: "CMP-08", explanation: "your quarterly statement and GST payment under the composition scheme", needs: ["Your total sales (turnover) for the quarter"] },
  "GSTR-4": { name: "GSTR-4", explanation: "your annual GST return under the composition scheme", needs: ["Your sales and purchase totals for the year"] },
  "GSTR-7": { name: "GSTR-7", explanation: "your monthly return of GST you deducted at source from payments to suppliers", needs: ["Payments to suppliers on which you deducted GST, with their GSTINs"] },
  "GSTR-8": { name: "GSTR-8", explanation: "your monthly statement of GST collected at source on sales through your platform", needs: ["Sales made through your platform during the month, by seller"] },
  "GSTR-9": { name: "GSTR-9", explanation: "your annual GST return, summarising the year's monthly returns", needs: ["Your sales and purchase registers for the year", "Your books of account for the year"] },
  "GSTR-9C": { name: "GSTR-9C", explanation: "the yearly reconciliation of your GST returns with your audited accounts", needs: ["Your audited financial statements for the year"] },
  ITR: { name: "Income tax return", explanation: "your income tax return for the year", needs: ITR_NEEDS },
  "ITR (BELATED)": { name: "Belated income tax return", explanation: "the last date to file a late income tax return for the year", needs: ITR_NEEDS },
  "ITR (REVISED)": { name: "Revised income tax return", explanation: "the last date to correct a return already filed for the year", needs: ["Details of what needs correcting in the return already filed"] },
  "ITR-U": { name: "Updated return (ITR-U)", explanation: "the last date to file an updated return reporting income left out earlier", needs: ["Details of the income that wasn't reported"] },
  "FORM 3CA/3CB-3CD": {
    name: "Tax audit report",
    explanation: "the tax audit report on your accounts, which must be filed before an audited return",
    needs: ["Your books of account for the year", "Bank statements for the year", "Your fixed asset register and loan confirmations"],
  },
  "FORM 3CEB": {
    name: "Transfer-pricing report (Form 3CEB)",
    explanation: "the report on your transactions with related parties outside India",
    needs: ["Agreements and invoices for transactions with related parties outside India"],
  },
  "ADVANCE TAX": {
    name: "Advance tax",
    explanation: "an instalment of income tax paid during the year on the income you expect to earn",
    needs: ["Your income so far this year, and what you expect for the rest of it"],
  },
  "TDS DEPOSIT": { name: "TDS deposit", explanation: "the deposit of tax you deducted from last month's payments", needs: [TDS_PAYMENTS] },
  "24Q/26Q/27Q": { name: "TDS return", explanation: "your quarterly TDS return, reporting the tax you deducted and deposited", needs: [TDS_PAYMENTS, "Challans for the tax you deposited"] },
  "FORM 16": { name: "Form 16", explanation: "the salary TDS certificates you give your employees", needs: ["Your employees' salary details for the year"] },
  "FORM 16A": { name: "Form 16A", explanation: "the TDS certificates for people you deducted tax from on payments other than salary", needs: [] },
  AGM: { name: "Annual general meeting", explanation: "the last date to hold your company's annual general meeting", needs: ["A date for the AGM that suits your directors", ROC_ACCOUNTS] },
  "ADT-1": { name: "ADT-1", explanation: "the filing that tells the Registrar of Companies who your auditor is", needs: ["The board or shareholders' resolution appointing the auditor"] },
  "AOC-4": { name: "AOC-4", explanation: "the filing of your company's financial statements with the Registrar of Companies", needs: [ROC_ACCOUNTS] },
  "MGT-7/MGT-7A": {
    name: "Annual return (MGT-7)",
    explanation: "your company's annual return to the Registrar of Companies",
    needs: ["Your shareholding as at the year end", "Changes in directors during the year", "Dates of board and general meetings held"],
  },
  "DPT-3": { name: "DPT-3", explanation: "the return of loans and deposits your company received", needs: ["Loans and advances your company received, and from whom"] },
  "MSME-1": { name: "MSME-1", explanation: "the return of amounts owed to micro and small suppliers for more than 45 days", needs: ["Your unpaid bills from MSME-registered suppliers, with their dates"] },
  "DIR-3 KYC WEB": { name: "Director KYC", explanation: "the KYC confirmation for each of your directors", needs: ["Each director's current mobile number and email address, for the OTP"] },
  "LLP FORM 11": { name: "LLP annual return (Form 11)", explanation: "your LLP's annual return to the Registrar", needs: ["Changes in partners or their contributions during the year"] },
  "LLP FORM 8": { name: "LLP Form 8", explanation: "your LLP's statement of account and solvency for the year", needs: ["Your LLP's financial statements for the year"] },
  "PF/ESIC": { name: "PF and ESIC", explanation: "this month's provident fund and ESI contributions for your employees", needs: ["Salary and attendance for the month, with new joiners and leavers"] },
  "PT (KARNATAKA)": { name: "Professional tax", explanation: "the professional tax deducted from your employees' salaries", needs: ["Salary details for the month"] },
  "PT ENROLMENT (KARNATAKA)": { name: "Professional tax enrolment", explanation: "the yearly professional tax payment for your business's own enrolment", needs: [] },
};

/** When the form code isn't known: what its compliance type means. */
const TYPES: Record<ComplianceType, FormCopy> = {
  gstr_1: { name: "GSTR-1", explanation: "your GST return of sales", needs: [GST_SALES] },
  gstr_3b: { name: "GSTR-3B", explanation: "your GST summary return, where the tax is paid", needs: [GST_SALES, GST_PURCHASES] },
  tds: { name: "TDS", explanation: "a filing for tax deducted at source", needs: [TDS_PAYMENTS] },
  roc: { name: "ROC filing", explanation: "a filing with the Registrar of Companies", needs: [] },
  itr: { name: "Income tax return", explanation: "your income tax return", needs: ITR_NEEDS },
  pf_esic: { name: "PF and ESIC", explanation: "your employees' provident fund and ESI contributions", needs: ["Salary and attendance details"] },
  audit: { name: "Audit", explanation: "an audit report on your accounts", needs: ["Your books of account for the year"] },
  advance_tax: { name: "Advance tax", explanation: "an instalment of income tax paid during the year", needs: ["Your income so far this year"] },
  pt: { name: "Professional tax", explanation: "a professional tax payment", needs: [] },
  custom: { name: "Deadline", explanation: "a deadline we're tracking for you", needs: [] },
};

function normaliseCode(code: string | null | undefined): string {
  return (code ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function isQuarterly(period: string | null | undefined): boolean {
  return /^Q[1-4]\s/i.test(period?.trim() ?? "");
}

/** The copy for a form code (and period, for monthly/quarterly forms), or null when it isn't known. */
export function formCopy(formCode: string | null | undefined, period?: string | null): FormCopy | null {
  const entry = FORMS[normaliseCode(formCode)];
  if (!entry) return null;
  if ("monthly" in entry) return isQuarterly(period) ? entry.quarterly : entry.monthly;
  return entry;
}

export interface DeadlineInput {
  formCode: string | null | undefined;
  type: ComplianceType | string | null | undefined;
  filingPeriod: string | null | undefined;
  title: string | null | undefined;
}

export interface ExplainedDeadline {
  /** "GSTR-3B", "Income tax return", or the deadline's title. */
  name: string;
  /** The period in words for a headline, or null. */
  period: string | null;
  /** "GSTR-3B for September 2026". */
  headline: string;
  /** "your monthly GST summary return, where the tax for the month is paid"; null when unknown. */
  explanation: string | null;
  /** "GSTR-3B for September 2026: your monthly GST summary return, …". */
  sentence: string;
  /** What the firm usually needs from the client for it. */
  needs: string[];
}

/** Strips "(monthly)", "(quarterly, QRMP)" and " for <period>" from a generated title. */
function cleanTitle(title: string, period: string | null | undefined): string {
  let t = title.trim();
  const p = period?.trim();
  if (p) {
    const at = t.toLowerCase().lastIndexOf(` for ${p.toLowerCase()}`);
    if (at > 0) t = t.slice(0, at);
  }
  return t.replace(/\s*\((monthly|quarterly[^)]*)\)\s*$/i, "").trim() || title.trim();
}

/**
 * A deadline for the client (§7.22 Deadlines): its name, period and what it is in plain words,
 * e.g. "GSTR-3B for September 2026: your monthly GST summary return, where the tax for the month is paid".
 */
export function explainDeadline(d: DeadlineInput): ExplainedDeadline {
  const known = formCopy(d.formCode, d.filingPeriod);
  const byType = !known && d.type && d.type in TYPES && d.type !== "custom" ? TYPES[d.type as ComplianceType] : null;
  const copy = known ?? byType;
  const fallbackName = d.title?.trim() ? cleanTitle(d.title, d.filingPeriod) : d.formCode?.trim() || TYPES.custom.name;
  const name = known ? known.name : d.formCode?.trim() || fallbackName;
  const period = periodShort(d.filingPeriod);
  const headline = period && !name.toLowerCase().includes(period.toLowerCase()) ? `${name} for ${period}` : name;
  const explanation = copy?.explanation ?? null;
  return {
    name,
    period,
    headline,
    explanation,
    sentence: explanation ? `${headline}: ${explanation}` : headline,
    needs: copy?.needs ?? [],
  };
}

// -------------------------------------------------------------------------------------------------
// Where a deadline stands, and what we need from the client
// -------------------------------------------------------------------------------------------------

/** portal_compliance_events.progress (0175). */
export const DEADLINE_PROGRESS = ["not_started", "waiting_on_you", "in_progress", "filed", "cancelled"] as const;
export type DeadlineProgress = (typeof DEADLINE_PROGRESS)[number];

export function isDeadlineProgress(v: unknown): v is DeadlineProgress {
  return typeof v === "string" && (DEADLINE_PROGRESS as readonly string[]).includes(v);
}

/** The §3.1 status tones (lib/status.ts StatusTone). */
export type PortalTone = "success" | "warning" | "danger" | "info" | "violet" | "muted" | "neutral";
export interface PortalStatus {
  label: string;
  tone: PortalTone;
  meaning: string;
}

/**
 * The chip for a deadline (§3.6 labels and colours): Overdue while pending past its date, else
 * Documents awaited, In progress, Not started, Filed or Cancelled, explained for the client.
 */
export function deadlineStatus(progress: DeadlineProgress | string | null | undefined, isOverdue: boolean | null | undefined): PortalStatus {
  if (isOverdue && progress !== "filed" && progress !== "cancelled") {
    return {
      label: "Overdue",
      tone: "danger",
      meaning:
        progress === "waiting_on_you"
          ? "Overdue: the due date has passed and we're still waiting for your documents. Late fees and interest may apply, so please send them today."
          : "Overdue: the due date has passed and it isn't filed yet. Late fees and interest may apply; we'll file it as soon as we can.",
    };
  }
  switch (progress) {
    case "waiting_on_you":
      return { label: "Documents awaited", tone: "warning", meaning: "Documents awaited: we need documents from you before we can prepare it. Upload them under Documents." };
    case "in_progress":
      return { label: "In progress", tone: "info", meaning: "In progress: we have what we need and are preparing it. Nothing for you to do." };
    case "filed":
      return { label: "Filed", tone: "success", meaning: "Filed: submitted on the government portal. The acknowledgement number is on the Compliance page." };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", meaning: "Cancelled: no longer needed, for example because the service ended." };
    default:
      return { label: "Not started", tone: "muted", meaning: "Not started: we haven't begun on it yet. We'll ask for anything we need well before the due date." };
  }
}

export interface WhatWeNeed {
  /** `nothing`: we have what we need (or it's done); `list`: the items to send. */
  kind: "nothing" | "list";
  /** `asked`: items the firm requested (Documents); `usual`: what that return usually needs. */
  source: "asked" | "usual" | null;
  items: string[];
  /** One sentence to show with it. */
  note: string;
}

/**
 * "What we need from you" for a deadline (§7.22 Home): nothing once it is filed or cancelled, or
 * while we're preparing it; otherwise the documents the firm has asked for (open request items,
 * up to five) or, when nothing has been asked for yet, what that return usually needs.
 */
export function whatWeNeed(input: { progress: DeadlineProgress | string | null | undefined; formNeeds: readonly string[]; openRequestItems: readonly string[] }): WhatWeNeed {
  const { progress } = input;
  if (progress === "filed" || progress === "cancelled") return { kind: "nothing", source: null, items: [], note: "Nothing more is needed from you." };
  if (progress === "in_progress") return { kind: "nothing", source: null, items: [], note: "We have what we need for now, so there is nothing for you to do." };
  const asked = [...new Set(input.openRequestItems.map((t) => t.trim()).filter(Boolean))];
  if (asked.length > 0) {
    const shown = asked.slice(0, 5);
    const more = asked.length - shown.length;
    return {
      kind: "list",
      source: "asked",
      items: shown,
      note: more > 0 ? `And ${more} more we've asked for under Documents.` : "Upload them under Documents, against each item we've asked for.",
    };
  }
  if (input.formNeeds.length === 0) {
    return { kind: "nothing", source: null, items: [], note: progress === "waiting_on_you" ? "We'll tell you exactly what we need." : "Nothing is needed from you yet." };
  }
  return { kind: "list", source: "usual", items: [...input.formNeeds], note: "What we usually need for this return. We'll send a list if we need anything else." };
}

// -------------------------------------------------------------------------------------------------
// Invoices, payments and document requests, in the client's words
// -------------------------------------------------------------------------------------------------

/** portal_invoices.display_status: the stored status, or the derived overdue / cancelled. */
export function invoiceStatus(display: string | null | undefined): PortalStatus {
  switch (display) {
    case "sent":
      return { label: "Sent", tone: "info", meaning: "Sent: issued to you and waiting for payment by the due date." };
    case "partially_paid":
      return { label: "Partially paid", tone: "warning", meaning: "Partially paid: we've received part of it. The balance is still due." };
    case "paid":
      return { label: "Paid", tone: "success", meaning: "Paid: settled in full. Thank you. The receipt is below." };
    case "overdue":
      return { label: "Overdue", tone: "danger", meaning: "Overdue: the due date has passed and a balance is still due. Please pay it, or tell us if you already have." };
    case "disputed":
      return { label: "Disputed", tone: "violet", meaning: "Disputed: you've raised a question about this invoice. We'll be in touch to resolve it." };
    case "waived":
      return { label: "Waived", tone: "muted", meaning: "Waived: the firm has written off the balance. Nothing is due." };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", meaning: "Cancelled: this invoice was withdrawn. Nothing is due on it." };
    default:
      return { label: "Sent", tone: "info", meaning: "Sent: issued to you." };
  }
}

/** Whether the client can pay an invoice from the portal (and report "I've paid"). */
export function isPayable(inv: { status: string | null | undefined; cancelledAt: string | null | undefined; outstandingPaise: number }): boolean {
  if (inv.cancelledAt) return false;
  if (!inv.status || !["sent", "partially_paid", "disputed"].includes(inv.status)) return false;
  return Number.isSafeInteger(inv.outstandingPaise) && inv.outstandingPaise > 0;
}

/** A payment the client reported ("I've paid") and where it stands. */
export function claimStatus(status: string | null | undefined): PortalStatus {
  switch (status) {
    case "verified":
      return { label: "Confirmed", tone: "success", meaning: "Confirmed: we've matched your payment and recorded the receipt." };
    case "rejected":
      return { label: "Not matched", tone: "danger", meaning: "Not matched: we couldn't find this payment in our account. We'll contact you, or send us a message." };
    default:
      return {
        label: "Payment reported",
        tone: "info",
        meaning: "Payment reported: you told us you've paid. We'll confirm once it shows in our bank account; the invoice changes to Paid when we record the receipt.",
      };
  }
}

/** A requested document item (§3.6 Document request item), explained for the client. */
export function requestItemStatus(status: string | null | undefined): PortalStatus {
  switch (status) {
    case "uploaded":
      return { label: "Uploaded", tone: "info", meaning: "Uploaded: we have your file and will check it soon. You can replace it until we do." };
    case "accepted":
      return { label: "Accepted", tone: "success", meaning: "Accepted: we've checked it. Nothing more to do for this item." };
    case "rejected":
      return { label: "Rejected", tone: "danger", meaning: "Rejected: we couldn't use this file. The reason is shown; please upload it again." };
    default:
      return { label: "Pending", tone: "warning", meaning: "Pending: we're waiting for you to upload this." };
  }
}

/** Items still to do on a request: pending or rejected (what reminders chase, §7.14). */
export function outstandingItemCount(items: ReadonlyArray<{ status: string }>): number {
  return items.filter((i) => i.status === "pending" || i.status === "rejected").length;
}

/** The note a UPI payment carries: the invoice number, so the firm can match it (§7.22 tn=<invoice no>). */
export function paymentNote(invoiceNumber: string | null | undefined): string | null {
  const n = invoiceNumber?.trim();
  return n ? n : null;
}

/**
 * A person's first name for a friendly line ("Ask Anita"), from a full name with an honorific:
 * "CA Vinay Karlagere" → "Vinay".
 */
export function firstName(fullName: string | null | undefined): string | null {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const honorifics = new Set(["ca", "cs", "cma", "dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "shri", "smt", "smt."]);
  const first = parts.find((p) => !honorifics.has(p.toLowerCase()));
  return first ?? null;
}

// -------------------------------------------------------------------------------------------------
// Home
// -------------------------------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/**
 * Home's one-line answer to "what needs me?" (§7.22): what is overdue, what to upload, what is due
 * and what is new, or that nothing needs the client, with the next deadline.
 *   homeSummary({ overdue: 1, toUpload: 3, due: "₹11,800.00", unread: 0, next: null })
 *     → "1 deadline overdue · 3 documents to upload · ₹11,800.00 due"
 */
export function homeSummary(input: { overdue: number; toUpload: number; due: string | null; unread: number; next: string | null }): string {
  const parts: string[] = [];
  if (input.overdue > 0) parts.push(plural(input.overdue, "deadline overdue", "deadlines overdue"));
  if (input.toUpload > 0) parts.push(plural(input.toUpload, "document to upload", "documents to upload"));
  if (input.due) parts.push(`${input.due} due`);
  if (input.unread > 0) parts.push(plural(input.unread, "new message", "new messages"));
  if (parts.length > 0) return parts.join(" · ");
  return input.next ? `Nothing needs you right now. Next: ${input.next}.` : "Nothing needs you right now.";
}

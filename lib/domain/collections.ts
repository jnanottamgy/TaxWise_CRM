/**
 * Collections (§7.9.5, §7.9.9, §7.9.10, §11): the figures on the payments dashboard, the daily
 * reminder decision, the receivables sweep window, the statement of account, and the TDS credit
 * statement (26AS / AIS / Form 168) parser, matcher and correction drafts.
 *
 * Pure and client-safe. Money is integer paise (lib/domain/money.ts); "today" is always a parameter.
 */

import {
  addDays,
  addMonths,
  compareDates,
  diffDays,
  endOfMonth,
  isDateString,
  isFinancialYear,
  MONTH_ABBR,
  parsePeriodLabel,
  quarterLabel,
  toDateString,
  type DateString,
  type FinancialYear,
} from "@/lib/domain/fy";
import { formatINR, toPaise, type Paise } from "@/lib/domain/money";
import type { ClientStatus, InvoiceStatus } from "@/lib/domain/enums";
import {
  INVOICE_REMINDER_DEFAULTS,
  reminderEligibility,
  reminderToSend,
  type ReminderSkipReason,
  type ReminderSlot,
} from "@/lib/domain/invoice";

// -------------------------------------------------------------------------------------------------
// Ratios (§7.9.5, §7.9.10)
// -------------------------------------------------------------------------------------------------

const BIG = (n: number): bigint => BigInt(n);

function divHalfUp(n: bigint, d: bigint): bigint {
  const negative = n < BIG(0) !== d < BIG(0);
  const an = n < BIG(0) ? -n : n;
  const ad = d < BIG(0) ? -d : d;
  let q = an / ad;
  if ((an % ad) * BIG(2) >= ad) q += BIG(1);
  return negative ? -q : q;
}

/**
 * `numerator ÷ denominator` as a percentage, rounded half-up to `decimals` places, exactly (BigInt):
 * `ratioPercent(1, 3)` → 33.3. Null when the denominator is 0 or less (nothing to measure against).
 */
export function ratioPercent(numerator: Paise, denominator: Paise, decimals = 1): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new RangeError("Ratios take whole paise.");
  if (denominator <= 0) return null;
  const scale = BIG(10) ** BIG(decimals);
  const scaled = divHalfUp(BIG(numerator) * BIG(100) * scale, BIG(denominator));
  return Number(scaled) / Number(scale);
}

/** "92.4%"; a missing ratio is an em dash. */
export function formatPercent(value: number | null, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

export type CollectionInputs = {
  /** Receivables open on the first day of the FY. */
  openingPaise: Paise;
  /** Invoiced since (issued, not cancelled), incl. GST. */
  billedPaise: Paise;
  /** Credit notes issued since. */
  creditedPaise: Paise;
  /** Written off (waived) since: not revenue reversal, but no longer collectable (§7.9.3). */
  writtenOffPaise: Paise;
  /** Received + TDS since. */
  collectedPaise: Paise;
};

/**
 * Collection rate for the FY so far (§7.9.5): what came in (received + TDS) out of what there was to
 * collect (receivables open at the start of the FY plus billing since, less credit notes and
 * write-offs). Null when there was nothing to collect.
 */
export function collectionRate(c: CollectionInputs): { ratePercent: number | null; duePaise: Paise } {
  const duePaise = c.openingPaise + c.billedPaise - c.creditedPaise - c.writtenOffPaise;
  return { ratePercent: duePaise > 0 ? ratioPercent(c.collectedPaise, duePaise) : null, duePaise };
}

/**
 * Days sales outstanding (§7.9.5): receivables ÷ billing over the last `days` days × `days`, in whole
 * days (half-up). Null when nothing was billed in the window.
 */
export function daysSalesOutstanding(input: { outstandingPaise: Paise; billedPaise: Paise; days: number }): number | null {
  if (input.billedPaise <= 0 || input.days <= 0) return null;
  return Number(divHalfUp(BIG(input.outstandingPaise) * BIG(input.days), BIG(input.billedPaise)));
}

// -------------------------------------------------------------------------------------------------
// Reminders (§7.9.5): 3 days before the due date (gentle), then 1, 7 and 15 days after (firmer)
// -------------------------------------------------------------------------------------------------

export type ReminderSettings = { beforeDays: number; afterDays: readonly number[] };

/** Settings → Reminders (firm_settings.invoice_reminder_before_days / _after_days), with the §5.2 defaults. */
export function reminderSettingsFrom(row: { invoice_reminder_before_days?: number | null; invoice_reminder_after_days?: readonly number[] | null } | null | undefined): ReminderSettings {
  const before = row?.invoice_reminder_before_days;
  const after = row?.invoice_reminder_after_days;
  return {
    beforeDays: typeof before === "number" && Number.isInteger(before) && before >= 0 ? before : INVOICE_REMINDER_DEFAULTS.beforeDays,
    afterDays: Array.isArray(after) && after.every((d) => Number.isInteger(d) && d > 0) ? [...after] : [...INVOICE_REMINDER_DEFAULTS.afterDays],
  };
}

/** "3 days before the due date", "1 day after the due date". */
export function reminderSlotLabel(key: string | null | undefined): string {
  const m = /^(before_due|after_due):(\d+)$/.exec(key ?? "");
  if (!m) return "Reminder";
  const n = Number(m[2]);
  return `${n} ${n === 1 ? "day" : "days"} ${m[1] === "before_due" ? "before" : "after"} the due date`;
}

/** How late (in days) a reminder may still go out when a run was missed; later than this it waits for the next slot. */
export const REMINDER_GRACE_DAYS = 3;

export type ReminderDecision =
  | { action: "skip"; reason: ReminderSkipReason }
  | { action: "wait" }
  | {
      action: "send";
      slot: ReminderSlot;
      /** For the email template: before the due date, or after it. */
      stage: "before" | "after";
      /** Days until the due date (before) or days overdue (after), counted from today. */
      days: number;
    };

/**
 * What the 10:00 job does with one invoice today (§7.9.5): skip it (never for Draft, Awaiting
 * approval, Disputed, Waived, Paid or cancelled invoices, nothing outstanding, or a client On hold
 * or Inactive, lib/domain/invoice.ts reminderEligibility), wait (no slot due, the due slot already
 * done, or it is more than REMINDER_GRACE_DAYS late), or send the latest slot reached.
 */
export function decideInvoiceReminder(input: {
  status: InvoiceStatus;
  outstandingPaise: Paise;
  clientStatus: ClientStatus;
  cancelled?: boolean;
  dueDate: DateString;
  today: DateString;
  /** reminder_key values already sent, handed off, waiting or dismissed for this invoice. */
  doneKeys: readonly string[];
  settings?: ReminderSettings;
}): ReminderDecision {
  const eligibility = reminderEligibility({ status: input.status, outstandingPaise: input.outstandingPaise, clientStatus: input.clientStatus, cancelled: input.cancelled });
  if (!eligibility.eligible) return { action: "skip", reason: eligibility.reason };
  const settings = input.settings ?? INVOICE_REMINDER_DEFAULTS;
  const slot = reminderToSend(input.dueDate, input.today, input.doneKeys, settings);
  if (!slot) return { action: "wait" };
  if (diffDays(input.today, slot.date) > REMINDER_GRACE_DAYS) return { action: "wait" };
  const toDue = diffDays(input.dueDate, input.today);
  return slot.kind === "before_due" ? { action: "send", slot, stage: "before", days: Math.max(toDue, 0) } : { action: "send", slot, stage: "after", days: Math.max(-toDue, 1) };
}

/**
 * The due dates worth loading for today's reminders: from the latest after-due slot plus the grace
 * days back, to the before-due slot ahead.
 */
export function reminderDueDateWindow(today: DateString, settings: ReminderSettings = INVOICE_REMINDER_DEFAULTS): { from: DateString; to: DateString } {
  const maxAfter = settings.afterDays.length ? Math.max(...settings.afterDays) : 0;
  return { from: addDays(today, -(maxAfter + REMINDER_GRACE_DAYS)), to: addDays(today, Math.max(settings.beforeDays, 0)) };
}

// -------------------------------------------------------------------------------------------------
// Receivables sweep (§8 07:30): invoices that BECAME overdue
// -------------------------------------------------------------------------------------------------

/** The day an invoice becomes overdue: the day after its due date (a draft never is, §5.7). */
export function overdueFrom(dueDate: DateString): DateString {
  return addDays(dueDate, 1);
}

/**
 * Due dates of invoices that became overdue in the last `catchUpDays` days up to today (today's,
 * plus a missed run's): `today − catchUpDays` … `today − 1`. The notice for each is keyed by the
 * day it became overdue, so catching up never repeats one.
 */
export function sweepDueDates(today: DateString, catchUpDays = 3): { from: DateString; to: DateString } {
  const days = Math.max(1, Math.floor(catchUpDays));
  return { from: addDays(today, -days), to: addDays(today, -1) };
}

// -------------------------------------------------------------------------------------------------
// Statement of account (§7.3.3, §7.4, §11)
// -------------------------------------------------------------------------------------------------

export const STATEMENT_KINDS = ["invoice", "debit_note", "receipt", "tds", "credit_note", "write_off", "cancellation", "reversal"] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export const STATEMENT_KIND_LABEL: Readonly<Record<StatementKind, string>> = {
  invoice: "Invoice",
  debit_note: "Debit note",
  receipt: "Receipt",
  tds: "TDS",
  credit_note: "Credit note",
  write_off: "Written off",
  cancellation: "Cancelled",
  reversal: "Receipt reversed",
};

export type StatementEvent = {
  date: DateString;
  kind: StatementKind;
  /** The document number the row is about. */
  reference: string;
  description: string;
  debitPaise: Paise;
  creditPaise: Paise;
  clientId?: string | null;
};

export type StatementInvoice = {
  id: string;
  clientId?: string | null;
  number: string;
  kind: "tax_invoice" | "debit_note";
  issueDate: DateString;
  totalPaise: Paise;
  periodLabel?: string | null;
  cancelledOn?: DateString | null;
  waivedOn?: DateString | null;
  waivedPaise?: Paise | null;
};

export type StatementReceipt = {
  id: string;
  clientId?: string | null;
  number: string;
  invoiceNumber: string;
  paymentDate: DateString;
  receivedPaise: Paise;
  tdsPaise: Paise;
  tdsSection?: string | null;
  methodLabel?: string | null;
  reference?: string | null;
  reversedOn?: DateString | null;
};

export type StatementCreditNote = {
  id: string;
  clientId?: string | null;
  number: string;
  invoiceNumber: string;
  issueDate: DateString;
  totalPaise: Paise;
};

/**
 * Every movement on a client's account (§11 statement of account): an invoice or debit note on its
 * date (debit); a receipt's amount received and its TDS on the payment date (credits); a reversal of
 * a receipt on the day it was reversed (debit); a credit note (credit); a waiver's write-off and a
 * cancellation on their days (credits). Drafts are never passed in.
 */
export function statementEvents(input: { invoices: readonly StatementInvoice[]; receipts: readonly StatementReceipt[]; creditNotes: readonly StatementCreditNote[] }): StatementEvent[] {
  const out: StatementEvent[] = [];
  for (const inv of input.invoices) {
    const what = inv.kind === "debit_note" ? "Debit note" : "Invoice";
    out.push({
      date: inv.issueDate,
      kind: inv.kind === "debit_note" ? "debit_note" : "invoice",
      reference: inv.number,
      description: inv.periodLabel ? `${what} ${inv.number} for ${inv.periodLabel}` : `${what} ${inv.number}`,
      debitPaise: inv.totalPaise,
      creditPaise: 0,
      clientId: inv.clientId ?? null,
    });
    if (inv.cancelledOn) {
      out.push({ date: inv.cancelledOn, kind: "cancellation", reference: inv.number, description: `${what} ${inv.number} cancelled`, debitPaise: 0, creditPaise: inv.totalPaise, clientId: inv.clientId ?? null });
    }
    if (inv.waivedOn && inv.waivedPaise && inv.waivedPaise > 0) {
      out.push({ date: inv.waivedOn, kind: "write_off", reference: inv.number, description: `Balance on ${what.toLowerCase()} ${inv.number} written off`, debitPaise: 0, creditPaise: inv.waivedPaise, clientId: inv.clientId ?? null });
    }
  }
  for (const r of input.receipts) {
    const how = [r.methodLabel, r.reference?.trim()].filter(Boolean).join(" · ");
    if (r.receivedPaise > 0) {
      out.push({
        date: r.paymentDate,
        kind: "receipt",
        reference: r.number,
        description: `Payment against invoice ${r.invoiceNumber}${how ? ` (${how})` : ""}`,
        debitPaise: 0,
        creditPaise: r.receivedPaise,
        clientId: r.clientId ?? null,
      });
    }
    if (r.tdsPaise > 0) {
      out.push({
        date: r.paymentDate,
        kind: "tds",
        reference: r.number,
        description: `TDS deducted${r.tdsSection ? ` under ${r.tdsSection === "393" ? "s.393" : r.tdsSection}` : ""} on invoice ${r.invoiceNumber}`,
        debitPaise: 0,
        creditPaise: r.tdsPaise,
        clientId: r.clientId ?? null,
      });
    }
    if (r.reversedOn) {
      out.push({
        date: r.reversedOn,
        kind: "reversal",
        reference: r.number,
        description: `Receipt ${r.number} reversed`,
        debitPaise: r.receivedPaise + r.tdsPaise,
        creditPaise: 0,
        clientId: r.clientId ?? null,
      });
    }
  }
  for (const n of input.creditNotes) {
    out.push({ date: n.issueDate, kind: "credit_note", reference: n.number, description: `Credit note ${n.number} against invoice ${n.invoiceNumber}`, debitPaise: 0, creditPaise: n.totalPaise, clientId: n.clientId ?? null });
  }
  return out;
}

export type StatementRow = StatementEvent & { balancePaise: Paise };

export type Statement = {
  from: DateString;
  to: DateString;
  /** What the client owed at the start of `from` (positive = owed to the firm). */
  openingPaise: Paise;
  rows: StatementRow[];
  closingPaise: Paise;
  totals: { debitPaise: Paise; creditPaise: Paise; byKind: Record<StatementKind, Paise> };
};

const KIND_ORDER: Readonly<Record<StatementKind, number>> = {
  invoice: 0,
  debit_note: 1,
  receipt: 2,
  tds: 3,
  credit_note: 4,
  write_off: 5,
  cancellation: 6,
  reversal: 7,
};

/**
 * The statement for a period: the opening balance (everything before `from`), the rows in the
 * period in date order (on one day: invoices first, then receipts, TDS, credit notes, write-offs,
 * cancellations and reversals) with a running balance, and the closing balance. Exact in paise.
 */
export function buildStatement(events: readonly StatementEvent[], range: { from: DateString; to: DateString }): Statement {
  if (compareDates(range.from, range.to) > 0) throw new RangeError("The statement's from date must be on or before its to date.");
  let opening = 0;
  const inRange: StatementEvent[] = [];
  for (const e of events) {
    if (compareDates(e.date, range.from) < 0) opening += e.debitPaise - e.creditPaise;
    else if (compareDates(e.date, range.to) <= 0) inRange.push(e);
  }
  inRange.sort((a, b) => compareDates(a.date, b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.reference.localeCompare(b.reference, "en", { numeric: true }));
  const byKind = Object.fromEntries(STATEMENT_KINDS.map((k) => [k, 0])) as Record<StatementKind, Paise>;
  let balance = opening;
  let debit = 0;
  let credit = 0;
  const rows: StatementRow[] = inRange.map((e) => {
    balance += e.debitPaise - e.creditPaise;
    debit += e.debitPaise;
    credit += e.creditPaise;
    byKind[e.kind] += e.debitPaise + e.creditPaise;
    return { ...e, balancePaise: balance };
  });
  return { from: range.from, to: range.to, openingPaise: opening, rows, closingPaise: balance, totals: { debitPaise: debit, creditPaise: credit, byKind } };
}

/** "₹12,500.00 Dr" (owed to the firm) / "₹500.00 Cr" (in the client's favour) / "₹0.00". */
export function formatBalance(paise: Paise): string {
  if (paise === 0) return formatINR(0);
  return `${formatINR(Math.abs(paise))} ${paise > 0 ? "Dr" : "Cr"}`;
}

// -------------------------------------------------------------------------------------------------
// TDS credits (§6.5, §7.9.9)
// -------------------------------------------------------------------------------------------------

export const TDS_CREDIT_STATUSES = ["expected", "reflected", "claimed"] as const;
export type TdsCreditStatus = (typeof TDS_CREDIT_STATUSES)[number];

export const TDS_CREDIT_STATUS_INFO: Readonly<Record<TdsCreditStatus, { label: string; tone: "warning" | "info" | "success"; meaning: string }>> = {
  expected: {
    label: "Expected",
    tone: "warning",
    meaning: "Expected: the client deducted it, and it isn't in our 26AS / AIS yet. It shows after the client files their TDS statement for the quarter.",
  },
  reflected: {
    label: "Reflected",
    tone: "info",
    meaning: "Reflected: it shows in our Form 26AS / AIS (Form 168). It can be claimed in our return.",
  },
  claimed: {
    label: "Claimed",
    tone: "success",
    meaning: "Claimed: taken in our income-tax return. Nothing more to do.",
  },
};

export const TDS_MATCH_STATUSES = ["matched", "amount_mismatch", "unmatched", "ignored"] as const;
export type TdsMatchStatus = (typeof TDS_MATCH_STATUSES)[number];

export const TDS_MATCH_STATUS_INFO: Readonly<Record<TdsMatchStatus, { label: string; tone: "success" | "warning" | "danger" | "muted"; meaning: string }>> = {
  matched: { label: "Matched", tone: "success", meaning: "Matched: the line settles our receipt, which is now Reflected." },
  amount_mismatch: {
    label: "Amount differs",
    tone: "danger",
    meaning: "Amount differs: the client's TAN is on our receipts, but the amount isn't what we recorded. Ask them to check their TDS statement.",
  },
  unmatched: { label: "Not in our books", tone: "warning", meaning: "Not in our books: no expected TDS from this TAN for this amount. Record the receipt, or set the line aside." },
  ignored: { label: "Set aside", tone: "muted", meaning: "Set aside: reviewed and not ours to match (the note says why)." },
};

/** The FY quarter label of a payment (`Q2 2026-27`), as the receipt records it. */
export function tdsQuarterOf(date: DateString): string {
  return quarterLabel(date);
}

/**
 * When the deductor's TDS statement for a quarter is due (§6.7, due_date_rules TDS_RETURN_Q1–Q4:
 * `{ day, monthOffset, quarters: [n], afterQuarterEnd: true }`): the quarter's last month plus
 * `monthOffset` months, on `day` (capped at the month's end). Null for an unknown quarter or rule.
 */
export function tdsStatementDueDate(quarter: string, rules: ReadonlyArray<{ rule: unknown }>): DateString | null {
  const parsed = parsePeriodLabel(quarter);
  if (!parsed || parsed.kind !== "quarter") return null;
  const n = Number(/^Q([1-4])/.exec(quarter.trim())?.[1]);
  for (const r of rules) {
    const rule = r.rule as { day?: unknown; monthOffset?: unknown; quarters?: unknown } | null;
    if (!rule || !Array.isArray(rule.quarters) || !rule.quarters.includes(n)) continue;
    const day = typeof rule.day === "number" ? rule.day : null;
    const offset = typeof rule.monthOffset === "number" ? rule.monthOffset : null;
    if (day === null || offset === null) continue;
    const month = addMonths(`${parsed.end.slice(0, 7)}-01`, offset);
    const last = endOfMonth(month);
    const d = Math.min(day, Number(last.slice(8, 10)));
    return toDateString(Number(month.slice(0, 4)), Number(month.slice(5, 7)), d);
  }
  return null;
}

// --- Statement parsing --------------------------------------------------------------------------

export type TdsStatementLine = {
  /** 1-based line in the file. */
  lineNo: number;
  tan: string;
  deductorName: string | null;
  section: string | null;
  transactionDate: DateString | null;
  /** TRACES booking status: F final, O overbooked, P provisional, U unmatched (no credit yet). */
  bookingStatus: string | null;
  bookingDate: DateString | null;
  amountPaidPaise: Paise | null;
  /** The credit: TDS deposited where the file gives it, else tax deducted. */
  tdsPaise: Paise;
};

export type TdsParseResult = {
  format: "26as_text" | "table" | "unknown";
  /** The FY the file is for, from its "Assessment Year" / "Financial Year" / "Tax Year" line. */
  financialYear: FinancialYear | null;
  lines: TdsStatementLine[];
  problems: Array<{ lineNo: number; message: string }>;
};

const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const SECTION_RE = /^(19[2-6][A-Z0-9]{0,4}|206[A-Z]{1,4}|393[A-Z0-9()]*|OTHER)$/i;

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function cleanCell(v: string): string {
  return v.replace(/^﻿/, "").trim().replace(/^"(.*)"$/, "$1").trim();
}

/** Parses an amount cell: `50,000.00`, `5000`, `₹ 1,234.5`. Null when it isn't one. */
export function parseStatementAmount(v: string | null | undefined): Paise | null {
  const t = (v ?? "").replace(/[₹,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return toPaise(t);
}

/** Parses a date cell: `15-Sep-2026`, `15-SEP-2026`, `15/09/2026`, `15-09-2026`, `2026-09-15`. */
export function parseStatementDate(v: string | null | undefined): DateString | null {
  const t = (v ?? "").trim();
  if (isDateString(t)) return t;
  let m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/.exec(t);
  if (m) {
    const month = MONTH_ABBR.findIndex((a) => a.toLowerCase() === m![2].toLowerCase());
    if (month < 0) return null;
    const d = toDateString(Number(m[3]), month + 1, Number(m[1]));
    return isDateString(d) && Number(d.slice(8, 10)) === Number(m[1]) ? d : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) {
    const month = Number(m[2]);
    const day = Number(m[1]);
    if (month < 1 || month > 12) return null;
    const d = toDateString(Number(m[3]), month, day);
    return isDateString(d) && Number(d.slice(8, 10)) === day ? d : null;
  }
  return null;
}

type Columns = {
  tan?: number;
  name?: number;
  section?: number;
  date?: number;
  status?: number;
  bookingDate?: number;
  amountPaid?: number;
  deducted?: number;
  deposited?: number;
};

function headerColumns(cells: string[]): Columns {
  const c: Columns = {};
  cells.forEach((raw, i) => {
    const h = raw.toLowerCase().replace(/[^a-z0-9 /]/g, " ").replace(/\s+/g, " ").trim();
    if (!h) return;
    if (c.tan === undefined && /\btan\b/.test(h)) c.tan = i;
    else if (c.name === undefined && /name of (the )?deductor|deductor name|^deductor$|information source/.test(h)) c.name = i;
    else if (c.section === undefined && /^section|section code|^section$/.test(h)) c.section = i;
    else if (c.bookingDate === undefined && /date of booking|booking date/.test(h)) c.bookingDate = i;
    else if (c.status === undefined && /status of booking|booking status/.test(h)) c.status = i;
    else if (c.date === undefined && /transaction date|date of (payment|credit)|payment date|credit date|^date$/.test(h)) c.date = i;
    else if (c.amountPaid === undefined && /amount paid|amount credited|paid credited|gross amount/.test(h) && !/total/.test(h)) c.amountPaid = i;
    else if (c.deposited === undefined && /tds deposited|tax deposited/.test(h) && !/total/.test(h)) c.deposited = i;
    else if (c.deducted === undefined && /tax deducted|tds deducted|tds amount|amount of tds|^tds$/.test(h) && !/total/.test(h)) c.deducted = i;
  });
  return c;
}

function detectFinancialYear(text: string): FinancialYear | null {
  const ay = /assessment year[^0-9a-z]{0,6}(\d{4})\s*-\s*(\d{2,4})/i.exec(text);
  if (ay) {
    const start = Number(ay[1]) - 1;
    const fy = `${start}-${String(start + 1).slice(2)}`;
    return isFinancialYear(fy) ? fy : null;
  }
  const fy = /(?:financial|tax) year[^0-9a-z]{0,6}(\d{4})\s*-\s*(\d{2,4})/i.exec(text);
  if (fy) {
    const label = `${fy[1]}-${fy[2].slice(-2)}`;
    return isFinancialYear(label) ? label : null;
  }
  return null;
}

/**
 * Reads a 26AS text export from TRACES (caret-separated: a deductor row "Sr. No.^Name^TAN^…" followed
 * by its transaction rows "^1^194J^15-Sep-2026^F^10-Oct-2026^…^amount^tax deducted^TDS deposited"),
 * or a table (CSV or tab-separated, e.g. the AIS / Form 168 TDS download or a sheet) with a header
 * naming the TAN, section, date and TDS columns. Each transaction becomes a line; anything that
 * can't be read is listed in `problems` with its line number, and nothing is guessed.
 */
export function parseTdsStatement(text: string): TdsParseResult {
  const source = text.replace(/^﻿/, "");
  const rawLines = source.split(/\r?\n/);
  const caret = (source.match(/\^/g) ?? []).length;
  const tabs = (source.match(/\t/g) ?? []).length;
  const delimiter: "^" | "\t" | "," = caret >= rawLines.length / 2 ? "^" : tabs >= rawLines.length / 2 ? "\t" : ",";
  const split = (l: string) => (delimiter === "," ? splitCsvLine(l) : l.split(delimiter)).map(cleanCell);

  const lines: TdsStatementLine[] = [];
  const problems: TdsParseResult["problems"] = [];
  let deductorCols: Columns | null = null;
  let txnCols: Columns | null = null;
  let tableCols: Columns | null = null;
  let current: { tan: string; name: string | null } | null = null;
  let format: TdsParseResult["format"] = "unknown";

  // 26AS has several parts; only Part I (TDS on our receipts) is read.
  let inPartOne = true;

  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (!raw.trim()) return;
    const part = /\bPART\s*-?\s*(I{1,3}|IV|V|VI{0,3}|IX|X)\b/i.exec(raw);
    if (part && !tableCols) {
      inPartOne = part[1].toUpperCase() === "I";
      current = null;
      return;
    }
    if (!inPartOne) return;
    const cells = split(raw);
    const lower = cells.map((c) => c.toLowerCase());

    // Header rows.
    const hasTanHeader = lower.some((c) => /\btan\b/.test(c) && !TAN_RE.test(c.toUpperCase()));
    const hasSourceHeader = lower.some((c) => /information source|name of (the )?deductor|deductor name/.test(c));
    const hasSectionHeader = lower.some((c) => c === "section" || c.startsWith("section"));
    // Per-transaction TDS columns (the 26AS deductor row's "Total Tax Deducted" doesn't count).
    const hasTdsHeader = lower.some((c) => !/total/.test(c) && /tax deducted|tds deducted|tds deposited|tds amount|amount of tds|^tds$/.test(c));
    if (hasTdsHeader && (hasTanHeader || hasSourceHeader)) {
      tableCols = headerColumns(cells);
      format = "table";
      return;
    }
    if (hasTanHeader) {
      deductorCols = headerColumns(cells);
      return;
    }
    if (hasSectionHeader && hasTdsHeader) {
      txnCols = headerColumns(cells);
      if (format === "unknown") format = "26as_text";
      return;
    }

    const read = (cols: Columns, tan: string, name: string | null): void => {
      const tdsRaw = cols.deposited !== undefined && cells[cols.deposited] ? cells[cols.deposited] : cols.deducted !== undefined ? cells[cols.deducted] : undefined;
      const tds = parseStatementAmount(tdsRaw);
      let section = cols.section !== undefined ? cells[cols.section] || null : null;
      if (!section) section = cells.map((c) => /\((19[2-6][A-Z]{0,3}|393)\)|\b(19[2-6][A-Z]{1,3})\b/.exec(c)).find(Boolean)?.slice(1).find(Boolean) ?? null;
      if (tds === null || tds <= 0) {
        problems.push({ lineNo, message: `No TDS amount on this line${section ? ` (section ${section})` : ""}.` });
        return;
      }
      const dateCell = cols.date !== undefined ? cells[cols.date] : "";
      const transactionDate = parseStatementDate(dateCell);
      if (dateCell && !transactionDate) problems.push({ lineNo, message: `The date "${dateCell}" isn't one we can read; the line was kept without it.` });
      lines.push({
        lineNo,
        tan,
        deductorName: name,
        section: section ? section.toUpperCase() : null,
        transactionDate,
        bookingStatus: cols.status !== undefined ? (cells[cols.status] || "").toUpperCase().slice(0, 4) || null : null,
        bookingDate: cols.bookingDate !== undefined ? parseStatementDate(cells[cols.bookingDate]) : null,
        amountPaidPaise: cols.amountPaid !== undefined ? parseStatementAmount(cells[cols.amountPaid]) : null,
        tdsPaise: tds,
      });
    };

    if (tableCols) {
      const t: Columns = tableCols;
      const name = t.name !== undefined ? cells[t.name] || null : null;
      let tan = t.tan !== undefined ? (cells[t.tan] ?? "").toUpperCase().replace(/\s+/g, "") : "";
      // AIS gives the deductor as "NAME (TAN)".
      if (!tan && name) tan = /\(([A-Z]{4}[0-9]{5}[A-Z])\)/i.exec(name)?.[1]?.toUpperCase() ?? "";
      if (!tan) return;
      if (!TAN_RE.test(tan)) {
        problems.push({ lineNo, message: `"${tan}" isn't a valid TAN.` });
        return;
      }
      read(t, tan, name ? name.replace(/\s*\([A-Z]{4}[0-9]{5}[A-Z]\)\s*$/i, "").trim() || null : null);
      return;
    }

    // 26AS text: a deductor row carries a TAN; its transactions follow.
    const tanAt = cells.findIndex((c) => TAN_RE.test(c.toUpperCase()));
    const sectionAt = cells.findIndex((c) => SECTION_RE.test(c));
    if (tanAt >= 0 && (sectionAt < 0 || (deductorCols && deductorCols.tan === tanAt))) {
      const dc: Columns | null = deductorCols;
      const nameIdx = dc && dc.name !== undefined ? dc.name : tanAt - 1;
      const dname = nameIdx >= 0 && cells[nameIdx] && !/^\d+$/.test(cells[nameIdx]) ? cells[nameIdx] : null;
      current = { tan: cells[tanAt].toUpperCase(), name: dname };
      if (format === "unknown") format = "26as_text";
      return;
    }
    if (sectionAt >= 0) {
      if (!current) {
        problems.push({ lineNo, message: "A TDS line comes before any deductor's TAN; it was skipped." });
        return;
      }
      if (txnCols) {
        read(txnCols, current.tan, current.name);
      } else {
        // No header: the 26AS order after the section is date, status, booking date, remarks, amount, deducted, deposited.
        const nums = cells.map((c, i) => ({ i, v: parseStatementAmount(c) })).filter((x) => x.v !== null && x.i > sectionAt);
        const dateIdx = cells.findIndex((c, i) => i > sectionAt && parseStatementDate(c) !== null);
        const cols: Columns = { section: sectionAt, date: dateIdx >= 0 ? dateIdx : undefined };
        if (nums.length >= 3) {
          cols.amountPaid = nums[nums.length - 3].i;
          cols.deducted = nums[nums.length - 2].i;
          cols.deposited = nums[nums.length - 1].i;
        } else if (nums.length >= 1) {
          cols.deducted = nums[nums.length - 1].i;
        }
        read(cols, current.tan, current.name);
      }
    }
  });

  return { format, financialYear: detectFinancialYear(source.slice(0, 4000)), lines, problems };
}

// --- Matching -----------------------------------------------------------------------------------

export type MatchableReceipt = {
  id: string;
  /** The TAN the client deducted under (the receipt's, else the client's). */
  tan: string | null;
  tdsPaise: Paise;
  /** `Q2 2026-27`. */
  quarter: string | null;
  paymentDate: DateString;
  status: TdsCreditStatus;
  /** Already matched to a statement line. */
  matched: boolean;
};

export type TdsLineMatch = {
  /** Index into the parsed lines. */
  index: number;
  status: "matched" | "amount_mismatch" | "unmatched";
  receiptIds: string[];
  note: string | null;
};

/** Received TDS may differ from the statement by at most ₹1 (rounding), as receipts allow (§7.9.4). */
export const TDS_MATCH_TOLERANCE_PAISE = 100;

function subsetsUpTo<T>(items: readonly T[], maxSize: number): T[][] {
  const out: T[][] = [];
  const walk = (start: number, acc: T[]) => {
    if (acc.length >= 2) out.push([...acc]);
    if (acc.length === maxSize) return;
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * Matches statement lines to Expected receipts by deductor TAN and amount (§7.9.9). For each line in
 * date order: the receipt from that TAN with the same TDS (preferring the same quarter, then the
 * nearest payment date); else one within ₹1; else up to four receipts of that TAN that the client
 * paid together and add up to it (within ₹1). A line whose TAN has Expected receipts but no amount
 * fits is an amount mismatch; a TAN with none is unmatched ("not in our books"). A line TRACES marks
 * U (unmatched challan) gives no credit yet and is never matched. A receipt matches one line.
 */
export function matchTdsStatement(lines: readonly TdsStatementLine[], receipts: readonly MatchableReceipt[], opts: { tolerancePaise?: number } = {}): TdsLineMatch[] {
  const tolerance = opts.tolerancePaise ?? TDS_MATCH_TOLERANCE_PAISE;
  const pool = new Map<string, MatchableReceipt[]>();
  for (const r of receipts) {
    if (r.status !== "expected" || r.matched || !r.tan || r.tdsPaise <= 0) continue;
    const key = r.tan.toUpperCase();
    pool.set(key, [...(pool.get(key) ?? []), r]);
  }
  const used = new Set<string>();
  const order = lines.map((l, index) => ({ l, index })).sort((a, b) => (a.l.transactionDate ?? "9999").localeCompare(b.l.transactionDate ?? "9999") || a.index - b.index);
  const out: TdsLineMatch[] = new Array(lines.length);

  for (const { l, index } of order) {
    const lineQuarter = l.transactionDate ? tdsQuarterOf(l.transactionDate) : null;
    const available = (pool.get(l.tan.toUpperCase()) ?? []).filter((r) => !used.has(r.id));
    if (l.bookingStatus === "U") {
      out[index] = { index, status: "unmatched", receiptIds: [], note: "TRACES shows this deposit as unmatched (U), so there is no credit yet. The client should correct the challan details in their TDS statement." };
      continue;
    }
    const rank = (r: MatchableReceipt) => [r.quarter === lineQuarter ? 0 : 1, l.transactionDate ? Math.abs(diffDays(r.paymentDate, l.transactionDate)) : 0] as const;
    const best = (cands: MatchableReceipt[]) =>
      [...cands].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return ra[0] - rb[0] || ra[1] - rb[1] || a.id.localeCompare(b.id);
      })[0];

    const exact = available.filter((r) => r.tdsPaise === l.tdsPaise);
    const near = exact.length ? exact : available.filter((r) => Math.abs(r.tdsPaise - l.tdsPaise) <= tolerance);
    if (near.length) {
      const pick = best(near);
      used.add(pick.id);
      out[index] = { index, status: "matched", receiptIds: [pick.id], note: pick.tdsPaise === l.tdsPaise ? null : `Within ₹1: our receipt shows ${formatINR(pick.tdsPaise)}.` };
      continue;
    }

    // Several receipts paid together: prefer the line's quarter, at most 10 candidates, up to 4 together.
    const sameQuarter = available.filter((r) => r.quarter === lineQuarter);
    const candidates = (sameQuarter.length >= 2 ? sameQuarter : available).slice(0, 10);
    let combo: MatchableReceipt[] | null = null;
    let comboDiff = Infinity;
    for (const set of subsetsUpTo(candidates, 4)) {
      const diff = Math.abs(set.reduce((s, r) => s + r.tdsPaise, 0) - l.tdsPaise);
      if (diff <= tolerance && (diff < comboDiff || (diff === comboDiff && combo && set.length < combo.length))) {
        combo = set;
        comboDiff = diff;
      }
    }
    if (combo) {
      for (const r of combo) used.add(r.id);
      out[index] = { index, status: "matched", receiptIds: combo.map((r) => r.id), note: `${combo.length} receipts paid together.` };
      continue;
    }

    if (available.length) {
      const recorded = (sameQuarter.length ? sameQuarter : available).reduce((s, r) => s + r.tdsPaise, 0);
      out[index] = {
        index,
        status: "amount_mismatch",
        receiptIds: [],
        note: `The statement shows ${formatINR(l.tdsPaise)}; our receipts from this TAN${sameQuarter.length && lineQuarter ? ` for ${lineQuarter}` : ""} show ${formatINR(recorded)} expected.`,
      };
      continue;
    }
    out[index] = { index, status: "unmatched", receiptIds: [], note: "No expected TDS from this TAN in our receipts." };
  }
  return out;
}

// --- Drafts asking the client to correct their TDS statement ------------------------------------

export type TdsCorrectionItem = {
  invoiceNumber: string | null;
  invoiceDate: DateString | null;
  tdsPaise: Paise;
  section: string | null;
  quarter: string | null;
  /** What the statement shows, when it shows a different amount. */
  statementPaise?: Paise | null;
};

function shortDate(date: DateString | null): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return `${d} ${MONTH_ABBR[Number(m) - 1]} ${y}`;
}

/**
 * The WhatsApp draft asking a client to correct their TDS statement (§7.9.9): which deductions
 * don't show in our Form 26AS / AIS (or show a different amount), and what to check in their 26Q /
 * Form 140 filing: our PAN, the amount, the section and the quarter.
 */
export function tdsCorrectionDraft(input: {
  contactName: string | null;
  clientName: string;
  firmName: string;
  firmPan: string | null;
  senderName?: string | null;
  items: readonly TdsCorrectionItem[];
}): { body: string } {
  const greeting = input.contactName?.trim() ? `Dear ${input.contactName.trim()},` : "Dear Sir / Madam,";
  const list = input.items
    .map((i) => {
      const what = [i.invoiceNumber ? `invoice ${i.invoiceNumber}${i.invoiceDate ? ` dated ${shortDate(i.invoiceDate)}` : ""}` : null, i.section ? `section ${i.section === "393" ? "393" : i.section}` : null, i.quarter]
        .filter(Boolean)
        .join(", ");
      const diff = i.statementPaise !== undefined && i.statementPaise !== null ? `; our 26AS shows ${formatINR(i.statementPaise)}` : "; it doesn't show in our 26AS / AIS";
      return `- ${formatINR(i.tdsPaise)} TDS on ${what || "our invoice"}${diff}`;
    })
    .join("\n");
  const total = input.items.reduce((s, i) => s + i.tdsPaise, 0);
  const body = [
    greeting,
    "",
    `Thank you for the payments. The TDS ${input.clientName} deducted on our fees isn't reflecting correctly in our Form 26AS / AIS:`,
    "",
    list,
    "",
    `Total: ${formatINR(total)}.`,
    "",
    `Please check the TDS statement for the quarter${input.firmPan ? `: our PAN is ${input.firmPan}` : ""}, and the amount and section shown against it, and file a correction statement if anything is wrong. Once it is processed the credit appears in our 26AS.`,
    "",
    "Thank you.",
    input.senderName?.trim() ? input.senderName.trim() : "",
    input.firmName,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
  return { body };
}

// -------------------------------------------------------------------------------------------------
// Payment reminder hand-off drafts (§7.9.5, §7.13.2–§7.13.4)
// -------------------------------------------------------------------------------------------------

/**
 * The payment-reminder template for a WhatsApp hand-off (§7.13.4 type "Payment reminder"): a
 * WhatsApp (or "any") one, preferring the one whose name says "before" or "after" to match the
 * reminder's stage.
 */
export function pickReminderTemplate<T extends { name: string; type: string; channel: string }>(templates: readonly T[], stage: "before" | "after"): T | null {
  const usable = templates.filter((t) => t.type === "payment_reminder" && (t.channel === "whatsapp" || t.channel === "any"));
  const word = stage === "before" ? /before/i : /after|overdue/i;
  return usable.find((t) => t.channel === "whatsapp" && word.test(t.name)) ?? usable.find((t) => word.test(t.name)) ?? usable.find((t) => t.channel === "whatsapp") ?? usable[0] ?? null;
}

/** The draft used when no payment-reminder template is set up: short, firm after the due date. */
export function defaultReminderDraft(input: {
  contactName: string | null;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  stage: "before" | "after";
  days: number;
  payLink: string;
  upiLink: string | null;
  firmName: string;
}): { body: string } {
  const hi = input.contactName ? `Hi ${input.contactName},` : "Hello,";
  const line =
    input.stage === "before"
      ? `a friendly reminder from ${input.firmName}: invoice ${input.invoiceNumber} for ${input.amount} is due on ${input.dueDate}.`
      : `invoice ${input.invoiceNumber} for ${input.amount} was due on ${input.dueDate} and is ${input.days} ${input.days === 1 ? "day" : "days"} overdue. We would be grateful if you could arrange the payment.`;
  const body = [`${hi} ${line}`, "", `View and pay: ${input.payLink}`, input.upiLink ? `Pay by UPI: ${input.upiLink}` : null, "", "If it is already paid, please share the reference so that we can match it. Thank you!"]
    .filter((l) => l !== null)
    .join("\n");
  return { body };
}

/**
 * Invoice status derivation, collections and retainer billing (§5.7, §7.9.2, §7.9.3, §7.9.5,
 * §7.9.6, §0.1 rule 10).
 *
 * - "Overdue" is derived, never stored: only a Sent or Partially paid invoice with a balance after
 *   its due date. **A draft is never overdue.** A cancelled invoice is never overdue. This mirrors
 *   `invoices_view` (0016).
 * - Paid / Partially paid come only from receipts (and credit notes), as the settlement trigger
 *   (`invoices_apply_settlement`, 0017) derives them.
 * - Reminders go 3 days before the due date and 1, 7 and 15 days after it, never for Draft,
 *   Disputed, Waived or Paid invoices or for clients On hold (§7.9.5).
 * - The retainer planner decides, per engagement, whether the daily job skips it (with one of the
 *   six §7.9.6 reasons) or which periods it drafts (catching up at most 3 per run).
 *
 * Pure and client-safe. "Today" is always a parameter.
 */

import type { ClientStatus, InvoiceStatus, ServiceFrequency } from "@/lib/domain/enums";
import {
  addDays,
  addMonths,
  compareDates,
  diffDays,
  financialYearOf,
  monthPeriodLabel,
  parsePeriodLabel,
  quarterLabel,
  type DateString,
} from "@/lib/domain/fy";
import { formatINR, type Paise } from "@/lib/domain/money";
import type { Settlement } from "@/lib/domain/tds";

// -------------------------------------------------------------------------------------------------
// Status derivation (§5.7, §7.9.3)
// -------------------------------------------------------------------------------------------------

/** The status to show: the stored one, the derived "overdue", or "cancelled" (cancel & reissue). */
export type InvoiceDerivedStatus = InvoiceStatus | "overdue" | "cancelled";

/** The only stored statuses that can become overdue (§5.7). */
export const OVERDUE_CAPABLE_STATUSES: readonly InvoiceStatus[] = ["sent", "partially_paid"];

export type InvoiceStatusOptions = {
  /** Cancelled under cancel & reissue (`cancelled_at` set, §7.9.3): never overdue. */
  cancelled?: boolean;
};

/**
 * True when the invoice is overdue (§5.7): status Sent or Partially paid, a balance outstanding,
 * and the due date before today. A draft is never overdue; neither is a cancelled invoice.
 */
export function isInvoiceOverdue(
  status: InvoiceStatus,
  outstandingPaise: Paise,
  dueDate: DateString,
  today: DateString,
  opts: InvoiceStatusOptions = {},
): boolean {
  if (opts.cancelled) return false;
  return OVERDUE_CAPABLE_STATUSES.includes(status) && outstandingPaise > 0 && compareDates(dueDate, today) < 0;
}

/**
 * The invoice status to display (§7.9.1, §7.9.3): `cancelled` for a cancelled invoice, `overdue`
 * when `isInvoiceOverdue`, otherwise the stored status. A draft is never overdue.
 */
export function deriveInvoiceStatus(
  status: InvoiceStatus,
  outstandingPaise: Paise,
  dueDate: DateString,
  today: DateString,
  opts: InvoiceStatusOptions = {},
): InvoiceDerivedStatus {
  if (opts.cancelled) return "cancelled";
  return isInvoiceOverdue(status, outstandingPaise, dueDate, today) ? "overdue" : status;
}

/** Days past the due date for an overdue invoice; 0 when it isn't overdue (§5.7 `days_overdue`). */
export function daysOverdue(
  status: InvoiceStatus,
  outstandingPaise: Paise,
  dueDate: DateString,
  today: DateString,
  opts: InvoiceStatusOptions = {},
): number {
  return isInvoiceOverdue(status, outstandingPaise, dueDate, today, opts) ? diffDays(today, dueDate) : 0;
}

/** Statuses whose payment state follows the settlement (§7.9.3: Paid / Partially paid come only from receipts). */
export const SETTLED_FAMILY: readonly InvoiceStatus[] = ["sent", "partially_paid", "paid"];

/**
 * The status after receipts or credit notes change (§7.9.3, mirrors the settlement trigger): for a
 * Sent / Partially paid / Paid invoice, `paid` when nothing is outstanding, `partially_paid` when
 * anything has been received, deducted or credited, else `sent`. Draft, Awaiting approval, Disputed
 * and Waived are left alone.
 */
export function statusAfterReceipts(
  status: InvoiceStatus,
  settlement: Pick<Settlement, "receivedPaise" | "tdsPaise" | "creditNotedPaise" | "outstandingPaise">,
): InvoiceStatus {
  if (!SETTLED_FAMILY.includes(status)) return status;
  if (settlement.outstandingPaise <= 0) return "paid";
  return settlement.receivedPaise + settlement.tdsPaise + settlement.creditNotedPaise > 0 ? "partially_paid" : "sent";
}

// -------------------------------------------------------------------------------------------------
// Receivables ageing (§7.2, §7.9.5)
// -------------------------------------------------------------------------------------------------

export const AGEING_BUCKETS = ["0_30", "31_60", "61_90", "90_plus"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const AGEING_BUCKET_LABELS: Readonly<Record<AgeingBucket, string>> = {
  "0_30": "0–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
};

/** The ageing bucket for a number of days (§7.2): 0–30 (and not yet due), 31–60, 61–90, 90+. */
export function ageingBucket(days: number): AgeingBucket {
  if (days <= 30) return "0_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

/**
 * Days an invoice has been outstanding, for ageing: from its issue date by default, or from its due
 * date (`basis: 'due_date'`, negative while not yet due).
 */
export function invoiceAgeDays(
  invoice: { issueDate: DateString; dueDate: DateString },
  today: DateString,
  basis: "issue_date" | "due_date" = "issue_date",
): number {
  return diffDays(today, basis === "issue_date" ? invoice.issueDate : invoice.dueDate);
}

/** Statuses that count as receivables (money still to collect): not Draft, Awaiting approval, Paid or Waived. */
export const RECEIVABLE_STATUSES: readonly InvoiceStatus[] = ["sent", "partially_paid", "disputed"];

/** True when the invoice is a receivable for ageing and the payments dashboard (§7.9.5). */
export function isReceivable(status: InvoiceStatus, outstandingPaise: Paise, opts: InvoiceStatusOptions = {}): boolean {
  return !opts.cancelled && RECEIVABLE_STATUSES.includes(status) && outstandingPaise > 0;
}

// -------------------------------------------------------------------------------------------------
// Reminders (§7.9.5)
// -------------------------------------------------------------------------------------------------

/** firm_settings defaults (§5.2): `invoice_reminder_before_days = 3`, `invoice_reminder_after_days = {1,7,15}`. */
export const INVOICE_REMINDER_DEFAULTS = { beforeDays: 3, afterDays: [1, 7, 15] as readonly number[] };

export type ReminderSlot = {
  /** The `invoice_reminders.kind` value. */
  kind: "before_due" | "after_due";
  /** Days relative to the due date: −3, +1, +7, +15. */
  offsetDays: number;
  date: DateString;
  /** Gentle before the due date, firmer after it (§7.9.5). */
  tone: "gentle" | "firm";
  /** A stable key for "already sent" (`before_due:3`, `after_due:7`). */
  key: string;
};

/**
 * The reminder dates for an invoice (§7.9.5): `beforeDays` before the due date (gentle), then each of
 * `afterDays` after it (firmer), in date order. A `beforeDays` of 0 or less leaves out the before-due one.
 */
export function reminderSchedule(
  dueDate: DateString,
  opts: { beforeDays: number; afterDays: readonly number[] } = INVOICE_REMINDER_DEFAULTS,
): ReminderSlot[] {
  const slots: ReminderSlot[] = [];
  if (opts.beforeDays > 0) {
    slots.push({ kind: "before_due", offsetDays: -opts.beforeDays, date: addDays(dueDate, -opts.beforeDays), tone: "gentle", key: `before_due:${opts.beforeDays}` });
  }
  const after = Array.from(new Set(opts.afterDays.filter((d) => d > 0))).sort((a, b) => a - b);
  for (const d of after) slots.push({ kind: "after_due", offsetDays: d, date: addDays(dueDate, d), tone: "firm", key: `after_due:${d}` });
  return slots;
}

export const REMINDER_SKIP_REASONS = [
  "draft",
  "awaiting_approval",
  "disputed",
  "waived",
  "paid",
  "cancelled",
  "nothing_outstanding",
  "client_on_hold",
  "client_inactive",
] as const;
export type ReminderSkipReason = (typeof REMINDER_SKIP_REASONS)[number];

const REMINDER_SKIP_MESSAGES: Readonly<Record<ReminderSkipReason, string>> = {
  draft: "Drafts aren't sent, so they get no reminders.",
  awaiting_approval: "It's awaiting a Partner's approval and can't be sent yet.",
  disputed: "It's disputed, so reminders are paused.",
  waived: "It's waived.",
  paid: "It's paid.",
  cancelled: "It was cancelled and reissued.",
  nothing_outstanding: "Nothing is outstanding.",
  client_on_hold: "The client is on hold, so client reminders are paused.",
  client_inactive: "The client is inactive.",
};

export type ReminderEligibility = { eligible: true } | { eligible: false; reason: ReminderSkipReason; message: string };

/**
 * Whether an invoice may get payment reminders (§7.9.5, §7.3.4): never for Draft, Disputed, Waived
 * or Paid invoices, or for clients On hold; also not while awaiting approval (it can't be sent),
 * once cancelled, with nothing outstanding, or for an inactive client.
 */
export function reminderEligibility(input: {
  status: InvoiceStatus;
  outstandingPaise: Paise;
  clientStatus: ClientStatus;
  cancelled?: boolean;
}): ReminderEligibility {
  const skip = (reason: ReminderSkipReason): ReminderEligibility => ({ eligible: false, reason, message: REMINDER_SKIP_MESSAGES[reason] });
  if (input.cancelled) return skip("cancelled");
  switch (input.status) {
    case "draft":
    case "awaiting_approval":
    case "disputed":
    case "waived":
    case "paid":
      return skip(input.status);
    case "sent":
    case "partially_paid":
      break;
  }
  if (input.outstandingPaise <= 0) return skip("nothing_outstanding");
  if (input.clientStatus === "on_hold") return skip("client_on_hold");
  if (input.clientStatus === "inactive") return skip("client_inactive");
  return { eligible: true };
}

/**
 * The reminder the daily job should send today (§7.9.5), or null: the latest slot dated today or
 * earlier that hasn't been sent (`sentKeys`). Older missed slots are skipped, so a client never gets
 * several reminders at once; a before-due reminder is never sent once the due date has passed.
 */
export function reminderToSend(
  dueDate: DateString,
  today: DateString,
  sentKeys: readonly string[] = [],
  opts: { beforeDays: number; afterDays: readonly number[] } = INVOICE_REMINDER_DEFAULTS,
): ReminderSlot | null {
  const reached = reminderSchedule(dueDate, opts).filter((s) => compareDates(s.date, today) <= 0);
  const latest = reached[reached.length - 1];
  if (!latest || sentKeys.includes(latest.key)) return null;
  if (latest.kind === "before_due" && compareDates(today, dueDate) > 0) return null;
  return latest;
}

// -------------------------------------------------------------------------------------------------
// Duplicate period and agreed-fee checks (§7.9.2)
// -------------------------------------------------------------------------------------------------

/**
 * A comparable form of a billing period label: `Sep 2026`, `sep  2026`, `FY 2026-27` and `2026-27`
 * match their equivalents (via `parsePeriodLabel`); anything else compares trimmed, case-insensitive.
 */
export function normalisePeriodLabel(label: string): string {
  const parsed = parsePeriodLabel(label.replace(/\s+/g, " "));
  if (parsed) return `${parsed.kind}:${parsed.start}`;
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export type PeriodInvoice = {
  id: string;
  invoiceNumber: string | null;
  clientServiceId: string | null;
  billingPeriodLabel: string | null;
  status: InvoiceStatus;
  cancelled?: boolean;
  deleted?: boolean;
};

/**
 * The invoice that already bills this engagement for this period (§7.9.2: "the same engagement
 * period already invoiced → block with a link"), or null. Drafts count (a retainer draft may exist);
 * cancelled and deleted invoices, and the invoice itself, don't.
 */
export function findDuplicatePeriodInvoice<T extends PeriodInvoice>(
  candidate: { id?: string | null; clientServiceId: string | null; billingPeriodLabel: string | null },
  existing: readonly T[],
): T | null {
  if (!candidate.clientServiceId || !candidate.billingPeriodLabel || candidate.billingPeriodLabel.trim() === "") return null;
  const period = normalisePeriodLabel(candidate.billingPeriodLabel);
  return (
    existing.find(
      (inv) =>
        inv.id !== candidate.id &&
        !inv.cancelled &&
        !inv.deleted &&
        inv.clientServiceId === candidate.clientServiceId &&
        inv.billingPeriodLabel !== null &&
        normalisePeriodLabel(inv.billingPeriodLabel) === period,
    ) ?? null
  );
}

/** The block message for a duplicate period, naming the invoice to open instead (§7.9.2). */
export function duplicatePeriodMessage(duplicate: PeriodInvoice): string {
  const period = duplicate.billingPeriodLabel?.trim() ?? "This period";
  const which = duplicate.invoiceNumber ? `invoice ${duplicate.invoiceNumber}` : "a draft invoice";
  return `${period} is already billed for this engagement on ${which}. Open it instead of raising another.`;
}

/**
 * The note shown when the fee differs from the agreed engagement fee (§7.9.2):
 * "Agreed ₹X; invoicing ₹Y". Null when there's no agreed fee or they match.
 */
export function agreedFeeNote(agreedPaise: Paise | null, invoicedPaise: Paise): string | null {
  if (agreedPaise === null || agreedPaise === invoicedPaise) return null;
  return `Agreed ${formatINR(agreedPaise)}; invoicing ${formatINR(invoicedPaise)}.`;
}

// -------------------------------------------------------------------------------------------------
// Retainer (auto) billing (§7.9.6)
// -------------------------------------------------------------------------------------------------

/** At most 3 missed periods are caught up per run (§7.9.6). */
export const RETAINER_DEFAULTS = { maxPeriodsPerRun: 3 } as const;

/** The six skip reasons, counted by the job (§7.9.6), in the order they are checked. */
export const RETAINER_SKIP_REASONS = [
  "not_enabled",
  "service_inactive",
  "client_inactive_or_on_hold",
  "no_agreed_fee",
  "one_time_service",
  "not_yet_due",
] as const;
export type RetainerSkipReason = (typeof RETAINER_SKIP_REASONS)[number];

/** The reasons as §7.9.6 words them. */
export const RETAINER_SKIP_REASON_LABELS: Readonly<Record<RetainerSkipReason, string>> = {
  not_enabled: "not enabled",
  service_inactive: "service inactive",
  client_inactive_or_on_hold: "client inactive or on hold",
  no_agreed_fee: "no agreed fee",
  one_time_service: "one-time service",
  not_yet_due: "not yet due",
};

export type RetainerEngagement = {
  /** `client_services.auto_invoice`. */
  autoInvoice: boolean;
  /** `client_services.is_active`. */
  isActive: boolean;
  clientStatus: ClientStatus;
  /** Per billing occurrence, excl. GST; null = not agreed. */
  agreedFeePaise: Paise | null;
  frequency: ServiceFrequency;
  /** Null = same as `frequency`. */
  billingFrequency?: ServiceFrequency | null;
  nextBillingDate: DateString | null;
};

export type RetainerPeriod = {
  /** The billing date this draft is for (`next_billing_date`, then one cycle later each time). */
  billingDate: DateString;
  /** `Sep 2026`, `Q2 2026-27` or `FY 2026-27`: the period containing the billing date (or the one before, `arrears`). */
  periodLabel: string;
};

export type RetainerPlan =
  | { kind: "skip"; reason: RetainerSkipReason; label: string }
  | {
      kind: "bill";
      /** Drafts to create, oldest first (1 to 3). */
      periods: RetainerPeriod[];
      amountPaise: Paise;
      /** The new `next_billing_date`: advanced one cycle per draft. */
      nextBillingDate: DateString;
      /** True when the cap stopped the catch-up and more periods are still due (reported, §7.9.6). */
      hitCap: boolean;
    };

const CYCLE_MONTHS: Readonly<Record<Exclude<ServiceFrequency, "one_time">, number>> = { monthly: 1, quarterly: 3, annual: 12 };

/** The billing period label for a date and cycle (§5.5 period labels). */
export function retainerPeriodLabel(date: DateString, frequency: Exclude<ServiceFrequency, "one_time">): string {
  switch (frequency) {
    case "monthly":
      return monthPeriodLabel(date);
    case "quarterly":
      return quarterLabel(date);
    case "annual":
      return `FY ${financialYearOf(date)}`;
  }
}

/**
 * Plans one engagement for the daily retainer job (§7.9.6). Skips it, with the first reason that
 * applies, when: auto-invoicing isn't enabled · the service is inactive · the client is inactive or
 * on hold · there is no agreed fee (null or not above 0) · it's a one-time service (or billed
 * one-time) · it isn't yet due (`next_billing_date` empty or after today). Otherwise it drafts every
 * billing date from `next_billing_date` up to today, at most `maxPeriodsPerRun` (3), and advances
 * `next_billing_date` one cycle per draft. Cycles are counted from the original date, so a 31st
 * stays on month ends (31 Jan → 28 Feb → 31 Mar).
 */
export function planRetainerBilling(
  engagement: RetainerEngagement,
  today: DateString,
  opts: { maxPeriodsPerRun?: number; arrears?: boolean } = {},
): RetainerPlan {
  const skip = (reason: RetainerSkipReason): RetainerPlan => ({ kind: "skip", reason, label: RETAINER_SKIP_REASON_LABELS[reason] });
  if (!engagement.autoInvoice) return skip("not_enabled");
  if (!engagement.isActive) return skip("service_inactive");
  if (engagement.clientStatus === "inactive" || engagement.clientStatus === "on_hold") return skip("client_inactive_or_on_hold");
  if (engagement.agreedFeePaise === null || engagement.agreedFeePaise <= 0) return skip("no_agreed_fee");
  const cycle = engagement.billingFrequency ?? engagement.frequency;
  if (engagement.frequency === "one_time" || cycle === "one_time") return skip("one_time_service");
  const start = engagement.nextBillingDate;
  if (!start || compareDates(start, today) > 0) return skip("not_yet_due");

  const max = Math.max(1, opts.maxPeriodsPerRun ?? RETAINER_DEFAULTS.maxPeriodsPerRun);
  const step = CYCLE_MONTHS[cycle];
  const periods: RetainerPeriod[] = [];
  let k = 0;
  while (k < max) {
    const billingDate = addMonths(start, k * step);
    if (compareDates(billingDate, today) > 0) break;
    const labelDate = opts.arrears ? addMonths(start, (k - 1) * step) : billingDate;
    periods.push({ billingDate, periodLabel: retainerPeriodLabel(labelDate, cycle) });
    k += 1;
  }
  const nextBillingDate = addMonths(start, k * step);
  return {
    kind: "bill",
    periods,
    amountPaise: engagement.agreedFeePaise,
    nextBillingDate,
    hitCap: compareDates(nextBillingDate, today) <= 0,
  };
}

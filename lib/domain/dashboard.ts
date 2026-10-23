/**
 * The dashboards' arithmetic (§7.2), pure and client-safe, so every figure on Firm today, Team
 * today and My day comes from the rows it summarises and is unit-tested:
 *   - receivables ageing by days since the invoice date (0–30 / 31–60 / 61–90 / 90+);
 *   - fees invoiced against collected, by month of the FY, summed in paise;
 *   - filing status by return type for the current month (filed, pending, overdue);
 *   - "at risk" clients (3+ overdue tasks, or receivables over 90 days);
 *   - "sent back to me": the task's latest status change is a reviewer's send-back;
 *   - overdue tasks by person; the setup checklist; the quotation conversion rate.
 */

import { addMonths, compareDates, diffDays, fyStart, MONTH_ABBR, parseDateString, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { fromPaise, sumPaise, type Paise } from "@/lib/domain/money";

// -------------------------------------------------------------------------------------------------
// Receivables ageing
// -------------------------------------------------------------------------------------------------

export const AGEING_BUCKETS = [
  { id: "d0_30", label: "0–30 days", min: 0, max: 30 },
  { id: "d31_60", label: "31–60 days", min: 31, max: 60 },
  { id: "d61_90", label: "61–90 days", min: 61, max: 90 },
  { id: "d90_plus", label: "90+ days", min: 91, max: Number.POSITIVE_INFINITY },
] as const;
export type AgeingBucketId = (typeof AGEING_BUCKETS)[number]["id"];

/** The bucket for an invoice this many days after its date (a future-dated invoice counts as 0). */
export function ageingBucket(daysSinceInvoice: number): AgeingBucketId {
  const d = Math.max(0, Math.floor(daysSinceInvoice));
  return (AGEING_BUCKETS.find((b) => d >= b.min && d <= b.max) ?? AGEING_BUCKETS[AGEING_BUCKETS.length - 1]).id;
}

export type AgeingRow = { id: AgeingBucketId; label: string; count: number; paise: Paise };

/** Outstanding receivables by age; every bucket is present (zero when empty), in order. */
export function ageReceivables(rows: ReadonlyArray<{ issueDate: DateString; outstandingPaise: Paise }>, today: DateString): AgeingRow[] {
  return AGEING_BUCKETS.map((b) => {
    const mine = rows.filter((r) => r.outstandingPaise > 0 && ageingBucket(diffDays(today, r.issueDate)) === b.id);
    return { id: b.id, label: b.label, count: mine.length, paise: sumPaise(mine.map((r) => r.outstandingPaise)) };
  });
}

// -------------------------------------------------------------------------------------------------
// Invoiced against collected, by month of the FY
// -------------------------------------------------------------------------------------------------

/** "2026-04" … "2027-03" for FY 2026-27. */
export function fyMonths(fy: FinancialYear): string[] {
  const start = fyStart(fy);
  return Array.from({ length: 12 }, (_, i) => addMonths(start, i).slice(0, 7));
}

export type MonthFigures = { month: string; label: string; invoicedPaise: Paise; collectedPaise: Paise; invoiced: number; collected: number };

/**
 * Each month of the FY with what was invoiced (by invoice date) and collected (by payment date),
 * summed in paise; the rupee numbers are for the chart only. Rows outside the FY are ignored.
 */
export function invoicedVsCollected(
  fy: FinancialYear,
  invoices: ReadonlyArray<{ issueDate: DateString; totalPaise: Paise }>,
  receipts: ReadonlyArray<{ paymentDate: DateString; amountPaise: Paise }>,
): MonthFigures[] {
  return fyMonths(fy).map((month) => {
    const invoicedPaise = sumPaise(invoices.filter((i) => i.issueDate.startsWith(month)).map((i) => i.totalPaise));
    const collectedPaise = sumPaise(receipts.filter((r) => r.paymentDate.startsWith(month)).map((r) => r.amountPaise));
    const { month: m } = parseDateString(`${month}-01`);
    return { month, label: MONTH_ABBR[m - 1], invoicedPaise, collectedPaise, invoiced: fromPaise(invoicedPaise), collected: fromPaise(collectedPaise) };
  });
}

// -------------------------------------------------------------------------------------------------
// Filing status by return type (the current month)
// -------------------------------------------------------------------------------------------------

export type FilingStatusRow<T extends string = string> = { type: T; filed: number; pending: number; overdue: number; total: number };

/**
 * Deadlines falling due in a month, by type: Filed (completed), Pending (not yet due, or due today)
 * and Overdue (past due and not filed; derived, never stored). Cancelled deadlines are left out.
 * Types with nothing due are dropped; the rest keep the order given.
 */
export function filingStatusByType<T extends string>(
  events: ReadonlyArray<{ type: T; status: "pending" | "completed" | "cancelled"; dueDate: DateString }>,
  today: DateString,
  order: readonly T[],
): FilingStatusRow<T>[] {
  return order
    .map((type) => {
      const mine = events.filter((e) => e.type === type && e.status !== "cancelled");
      const filed = mine.filter((e) => e.status === "completed").length;
      const overdue = mine.filter((e) => e.status === "pending" && compareDates(e.dueDate, today) < 0).length;
      const pending = mine.length - filed - overdue;
      return { type, filed, pending, overdue, total: mine.length };
    })
    .filter((r) => r.total > 0);
}

// -------------------------------------------------------------------------------------------------
// At-risk clients (§7.2 Partner: "3+ overdue tasks, or receivables over 90 days")
// -------------------------------------------------------------------------------------------------

export const AT_RISK_OVERDUE_TASKS = 3;
export const AT_RISK_RECEIVABLE_DAYS = 90;

export type AtRiskReason = "overdue_tasks" | "old_receivables";

export function atRiskReasons(c: { overdueTasks: number; receivablesOver90Paise: Paise }): AtRiskReason[] {
  const out: AtRiskReason[] = [];
  if (c.overdueTasks >= AT_RISK_OVERDUE_TASKS) out.push("overdue_tasks");
  if (c.receivablesOver90Paise > 0) out.push("old_receivables");
  return out;
}

// -------------------------------------------------------------------------------------------------
// "Sent back to me" (§7.2 Employee)
// -------------------------------------------------------------------------------------------------

export type StatusChange = { taskId: string; from: string | null; to: string; reason: string | null; at: string; by: string | null };

/**
 * The tasks whose latest status change is a send-back (Under review → In progress, §7.6.4), with the
 * reviewer's reason. A task that moved again since (resubmitted, put on hold …) is not "sent back"
 * any more.
 */
export function latestSendBacks(history: readonly StatusChange[]): Map<string, StatusChange> {
  const latest = new Map<string, StatusChange>();
  for (const h of history) {
    const prev = latest.get(h.taskId);
    if (!prev || h.at > prev.at) latest.set(h.taskId, h);
  }
  const out = new Map<string, StatusChange>();
  for (const [taskId, h] of latest) if (h.from === "under_review" && h.to === "in_progress") out.set(taskId, h);
  return out;
}

// -------------------------------------------------------------------------------------------------
// Overdue tasks by person (§7.2 Manager)
// -------------------------------------------------------------------------------------------------

export type PersonCount = { employeeId: string | null; name: string; count: number };

/** Overdue tasks grouped by assignee, most first (ties by name); unassigned work is one row, last. */
export function countByPerson(rows: ReadonlyArray<{ assigneeId: string | null; assigneeName: string | null }>): PersonCount[] {
  const byId = new Map<string, PersonCount>();
  let unassigned = 0;
  for (const r of rows) {
    if (!r.assigneeId) {
      unassigned++;
      continue;
    }
    const cur = byId.get(r.assigneeId) ?? { employeeId: r.assigneeId, name: r.assigneeName ?? "Someone", count: 0 };
    cur.count++;
    byId.set(r.assigneeId, cur);
  }
  const people = [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return unassigned ? [...people, { employeeId: null, name: "Unassigned", count: unassigned }] : people;
}

// -------------------------------------------------------------------------------------------------
// The Partner's setup checklist (§7.2)
// -------------------------------------------------------------------------------------------------

export type SetupFacts = {
  hasLogo: boolean;
  hasBankAndUpi: boolean;
  hasFrnAndMembership: boolean;
  emailDomainVerified: boolean;
  hasWhatsAppNumbers: boolean;
  teamAdded: boolean;
  firstClientOnboarded: boolean;
  firstInvoiceIssued: boolean;
  lawReviewed: boolean;
};

export type SetupItem = { id: keyof SetupFacts; label: string; href: string; done: boolean };

const SETUP_ITEMS: ReadonlyArray<Omit<SetupItem, "done">> = [
  { id: "hasLogo", label: "Upload the firm's logo", href: "/settings/firm" },
  { id: "hasBankAndUpi", label: "Add the bank account and UPI ID", href: "/settings/bank" },
  { id: "hasFrnAndMembership", label: "Enter the ICAI FRN and each Partner's membership number", href: "/settings/firm" },
  { id: "emailDomainVerified", label: "Verify the email domain", href: "/settings/email" },
  { id: "hasWhatsAppNumbers", label: "Add the firm's WhatsApp numbers", href: "/settings/whatsapp" },
  { id: "teamAdded", label: "Add the team", href: "/people" },
  { id: "firstClientOnboarded", label: "Onboard the first client", href: "/clients/new" },
  { id: "firstInvoiceIssued", label: "Issue the first invoice", href: "/invoices/new" },
  { id: "lawReviewed", label: "Review Law & rules and confirm every [verify] item", href: "/settings/law" },
];

/** The checklist in §7.2 order; it is shown until every item is done. */
export function setupChecklist(facts: SetupFacts): { items: SetupItem[]; done: number; complete: boolean } {
  const items = SETUP_ITEMS.map((i) => ({ ...i, done: facts[i.id] }));
  const done = items.filter((i) => i.done).length;
  return { items, done, complete: done === items.length };
}

// -------------------------------------------------------------------------------------------------
// Pipeline (§7.2 Partner)
// -------------------------------------------------------------------------------------------------

/** Accepted ÷ (accepted + rejected + expired), as a whole percentage; null when nothing was decided. */
export function conversionRate(c: { accepted: number; rejected: number; expired: number }): number | null {
  const decided = c.accepted + c.rejected + c.expired;
  return decided > 0 ? Math.round((c.accepted / decided) * 100) : null;
}

/** "3 days" waiting since a status change on `since` (an IST date), never negative. */
export function daysSince(since: DateString, today: DateString): number {
  return Math.max(0, diffDays(today, since));
}

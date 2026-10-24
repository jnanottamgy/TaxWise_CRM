/**
 * The dashboards' arithmetic (§7.2), pure and client-safe, so every figure on Firm today, Team
 * today and My day comes from the rows it summarises and is unit-tested:
 *   - receivables ageing by days since the invoice date (0–30 / 31–60 / 61–90 / 90+);
 *   - fees invoiced against collected, by month of the FY, summed in paise;
 *   - filing status by return type for the current month (filed, pending, overdue);
 *   - "at risk" clients (3+ overdue tasks, or receivables over 90 days);
 *   - "sent back to me": the task's latest status change is a reviewer's send-back;
 *   - overdue tasks by person; the setup checklist; the quotation conversion rate;
 *   - receivable totals, at-risk clients from their rows, days waiting in a status, this week's
 *     hours against the target, the practice-health list windows, and attendance so far today;
 *   - from the database's one-call readers (0216–0218): the setup checklist with what is still
 *     missing and where to finish it, the FY's months (months not yet begun stay empty), the
 *     ageing buckets, at-risk clients from per-client counts, and how urgent each practice-health
 *     item is.
 */

import { addMonths, compareDates, diffDays, fyStart, MONTH_ABBR, nowIST, parseDateString, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { fromPaise, sumPaise, type Paise } from "@/lib/domain/money";
import { deriveAttendance, parseTimeOfDay, summariseDay, type AttendanceParams, type DaySession } from "@/lib/domain/attendance";

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
  { id: "hasFrnAndMembership", label: "Enter the ICAI FRN and membership numbers", href: "/settings/firm" },
  { id: "emailDomainVerified", label: "Verify the email domain", href: "/settings/email" },
  { id: "hasWhatsAppNumbers", label: "Enter the firm's WhatsApp numbers", href: "/settings/whatsapp" },
  { id: "teamAdded", label: "Add the team", href: "/people" },
  { id: "firstClientOnboarded", label: "Onboard the first client", href: "/clients/new" },
  { id: "firstInvoiceIssued", label: "Issue the first invoice", href: "/invoices/new" },
  { id: "lawReviewed", label: "Review Law & rules", href: "/settings/law" },
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

// -------------------------------------------------------------------------------------------------
// Receivable totals (§7.2 Partner KPIs: outstanding; overdue receivables, amount and count)
// -------------------------------------------------------------------------------------------------

export type ReceivableTotals = { count: number; outstandingPaise: Paise; overdueCount: number; overduePaise: Paise };

/** Outstanding and overdue (derived: Sent/Partially paid past the due date) receivables, summed in paise. */
export function receivableTotals(rows: ReadonlyArray<{ outstandingPaise: Paise; isOverdue: boolean }>): ReceivableTotals {
  const open = rows.filter((r) => r.outstandingPaise > 0);
  const overdue = open.filter((r) => r.isOverdue);
  return {
    count: open.length,
    outstandingPaise: sumPaise(open.map((r) => r.outstandingPaise)),
    overdueCount: overdue.length,
    overduePaise: sumPaise(overdue.map((r) => r.outstandingPaise)),
  };
}

// -------------------------------------------------------------------------------------------------
// At-risk clients, from their overdue tasks and their receivables
// -------------------------------------------------------------------------------------------------

export type AtRiskClient = {
  clientId: string;
  clientName: string;
  overdueTasks: number;
  /** Receivables more than 90 days after the invoice date (the ageing chart's 90+ bucket). */
  receivablesOver90Paise: Paise;
  reasons: AtRiskReason[];
};

/**
 * Clients with 3+ overdue tasks, or receivables over 90 days (§7.2 Partner), worst first: both
 * reasons, then the most overdue tasks, then the largest old balance, then by name.
 */
export function atRiskClients(
  overdueTasks: ReadonlyArray<{ clientId: string; clientName: string | null }>,
  receivables: ReadonlyArray<{ clientId: string; clientName: string | null; issueDate: DateString; outstandingPaise: Paise }>,
  today: DateString,
): AtRiskClient[] {
  const byClient = new Map<string, { clientName: string; overdueTasks: number; old: Paise[] }>();
  const entry = (id: string, name: string | null) => {
    const cur = byClient.get(id) ?? { clientName: name ?? "", overdueTasks: 0, old: [] };
    if (!cur.clientName && name) cur.clientName = name;
    byClient.set(id, cur);
    return cur;
  };
  for (const t of overdueTasks) entry(t.clientId, t.clientName).overdueTasks++;
  for (const r of receivables) {
    if (r.outstandingPaise > 0 && ageingBucket(diffDays(today, r.issueDate)) === "d90_plus") entry(r.clientId, r.clientName).old.push(r.outstandingPaise);
  }
  const out: AtRiskClient[] = [];
  for (const [clientId, c] of byClient) {
    const receivablesOver90Paise = sumPaise(c.old);
    const reasons = atRiskReasons({ overdueTasks: c.overdueTasks, receivablesOver90Paise });
    if (reasons.length) out.push({ clientId, clientName: c.clientName, overdueTasks: c.overdueTasks, receivablesOver90Paise, reasons });
  }
  return out.sort(
    (a, b) =>
      b.reasons.length - a.reasons.length ||
      b.overdueTasks - a.overdueTasks ||
      b.receivablesOver90Paise - a.receivablesOver90Paise ||
      a.clientName.localeCompare(b.clientName),
  );
}

// -------------------------------------------------------------------------------------------------
// Waiting since a status (§7.2 Manager "Data awaited": days waiting)
// -------------------------------------------------------------------------------------------------

/** For each task, when it last moved into `status` (its latest change into it). */
export function latestEntryInto(history: readonly StatusChange[], status: string): Map<string, StatusChange> {
  const out = new Map<string, StatusChange>();
  for (const h of history) {
    if (h.to !== status) continue;
    const prev = out.get(h.taskId);
    if (!prev || h.at > prev.at) out.set(h.taskId, h);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// This week's hours against the target (§7.2 Employee)
// -------------------------------------------------------------------------------------------------

export type WeekHours = {
  loggedMinutes: number;
  targetMinutes: number;
  /** The target for the working days up to and including today. */
  expectedMinutes: number;
  /** How far behind the days so far (0 when on track or ahead). */
  behindMinutes: number;
  /** Logged as a share of the week's target, 0–100 (null with no target this week). */
  percent: number | null;
};

/**
 * The week so far from the timesheet's own figures (the same per-day targets and day totals the
 * timesheet shows, so the two never disagree): logged against the week's target, and against what
 * the days up to today call for.
 */
export function weekHours(dates: readonly DateString[], dayTargets: readonly number[], dayTotals: readonly number[], today: DateString): WeekHours {
  const loggedMinutes = dayTotals.reduce((a, b) => a + b, 0);
  const targetMinutes = dayTargets.reduce((a, b) => a + b, 0);
  const expectedMinutes = dates.reduce((sum, d, i) => (compareDates(d, today) <= 0 ? sum + (dayTargets[i] ?? 0) : sum), 0);
  return {
    loggedMinutes,
    targetMinutes,
    expectedMinutes,
    behindMinutes: Math.max(0, expectedMinutes - loggedMinutes),
    percent: targetMinutes > 0 ? Math.min(100, Math.round((loggedMinutes / targetMinutes) * 100)) : null,
  };
}

// -------------------------------------------------------------------------------------------------
// Practice health (§7.2 Partner). The UDIN, peer review and tax-audit ceiling rules themselves are in
// lib/domain/ceiling.ts (udinStatus, peerReviewStatus, ceilingWarning); these are the list windows.
// -------------------------------------------------------------------------------------------------

/** SA 230: an audit file's assembly due date this close (or past) is "near". */
export const ASSEMBLY_NEAR_DAYS = 14;
/** DSCs, registrations and engagement letters ending this soon are listed. */
export const EXPIRY_WINDOW_DAYS = 30;

/** How many of `all` are not in `have` (e.g. active clients without a WhatsApp group). */
export function countMissing(all: Iterable<string>, have: Iterable<string>): number {
  const present = new Set(have);
  let n = 0;
  for (const id of new Set(all)) if (!present.has(id)) n++;
  return n;
}

// -------------------------------------------------------------------------------------------------
// Attendance so far today (§7.2 Manager "Attendance today": present, late, absent, on leave)
// -------------------------------------------------------------------------------------------------

export type AttendanceSoFar = {
  workingDay: boolean;
  /** "10:15": someone not signed in by then counts as absent (the cover rule's no-show time). */
  cutoff: string;
  present: number;
  late: number;
  onLeave: number;
  /** Not signed in by the cutoff. */
  absent: number;
  /** Not signed in yet, before the cutoff. */
  notInYet: number;
  total: number;
};

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Today's attendance while the day is running, from the day's sessions with the same rules the 11:30
 * job applies once the day is over (lib/domain/attendance deriveAttendance, dayComplete false): On
 * leave, Late login (first sign-in after start + grace), Present; no sign-in yet is "not in yet"
 * until start + grace + the no-show minutes, then Absent (the Absent-without-cover rule, §4.7).
 * Half day is only decided at the end of the day, so it never shows here. A non-working day counts
 * nobody.
 */
export function attendanceSoFar(input: {
  people: ReadonlyArray<{ id: string }>;
  sessions: ReadonlyArray<DaySession & { employeeId: string }>;
  onLeave: ReadonlySet<string>;
  params: AttendanceParams;
  isWorkingDay: boolean;
  noShowAfterMinutes: number;
  today: DateString;
  now: Date;
}): AttendanceSoFar {
  const cutoffMinute = parseTimeOfDay(input.params.workDayStart) + input.params.lateGraceMinutes + input.noShowAfterMinutes;
  const out: AttendanceSoFar = { workingDay: input.isWorkingDay, cutoff: clock(cutoffMinute), present: 0, late: 0, onLeave: 0, absent: 0, notInYet: 0, total: 0 };
  if (!input.isWorkingDay) return out;
  const sessionsBy = new Map<string, DaySession[]>();
  for (const s of input.sessions) sessionsBy.set(s.employeeId, [...(sessionsBy.get(s.employeeId) ?? []), s]);
  const pastCutoff = nowIST(input.now).minutesOfDay >= cutoffMinute;
  for (const p of input.people) {
    const day = summariseDay(sessionsBy.get(p.id) ?? [], input.today);
    const status = deriveAttendance({
      ...input.params,
      firstActivity: day.firstActivity,
      totalActiveMinutes: day.totalActiveMinutes,
      isWorkingDay: true,
      onApprovedLeave: input.onLeave.has(p.id),
      dayComplete: false,
    });
    out.total++;
    if (status === "on_leave") out.onLeave++;
    else if (status === "late_login") out.late++;
    else if (status === "present" || status === "half_day") out.present++;
    else if (pastCutoff) out.absent++;
    else out.notInYet++;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The setup checklist with what is still missing (§7.2, §4.3): the same nine items, in order, with a
// one-line detail from the data and a link to the exact place to finish each one.
// -------------------------------------------------------------------------------------------------

export type DomainStatus = "not_started" | "pending" | "verified" | "failed";

/** What dashboard_firm_today reports about the firm's setup (0216). */
export type SetupDetail = {
  hasLogo: boolean;
  hasBank: boolean;
  hasUpi: boolean;
  hasFrn: boolean;
  domainStatus: DomainStatus;
  lawReviewedAt: string | null;
  partners: number;
  /** Active Partners with no ICAI membership number yet (it goes on every UDIN, §6.8). */
  partnersMissingMembership: ReadonlyArray<{ profileId: string; employeeId: string | null; name: string }>;
  /** Firm WhatsApp numbers switched on with a number entered, of the slots there are (§7.25.4). */
  whatsappNumbers: number;
  whatsappSlots: number;
  /** Active team members, the first Partner included. */
  teamMembers: number;
  clientsOnboarded: number;
  invoicesIssued: number;
};

/** The nine yes/no facts of the checklist (the order and links are SETUP_ITEMS'). */
export function setupFactsOf(d: SetupDetail): SetupFacts {
  return {
    hasLogo: d.hasLogo,
    hasBankAndUpi: d.hasBank && d.hasUpi,
    hasFrnAndMembership: d.hasFrn && d.partners > 0 && d.partnersMissingMembership.length === 0,
    emailDomainVerified: d.domainStatus === "verified",
    hasWhatsAppNumbers: d.whatsappNumbers > 0,
    // The first Partner is on the team from setup; the checklist wants someone else added.
    teamAdded: d.teamMembers > 1,
    firstClientOnboarded: d.clientsOnboarded > 0,
    firstInvoiceIssued: d.invoicesIssued > 0,
    lawReviewed: Boolean(d.lawReviewedAt),
  };
}

export type SetupStep = SetupItem & { detail: string | null };

function namesList(names: readonly string[], max = 2): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown.join(", ");
}

/**
 * The checklist as Firm today shows it: SETUP_ITEMS' order and wording, each with what is still
 * missing ("UPI ID still to add", "No membership number for Ravi") and the link that finishes it.
 * The membership number link goes to the Partner's own Profile when it is theirs, otherwise to that
 * Partner in People (§7.1, §4.5). `percent` is the true share done, for the progress bar.
 */
export function setupSteps(d: SetupDetail, viewer: { profileId: string }): { items: SetupStep[]; done: number; complete: boolean; percent: number } {
  const base = setupChecklist(setupFactsOf(d));
  const missing = d.partnersMissingMembership;
  const mine = missing.some((p) => p.profileId === viewer.profileId);
  const firstOther = missing.find((p) => p.profileId !== viewer.profileId);
  const items: SetupStep[] = base.items.map((item) => {
    if (item.done) return { ...item, detail: null };
    switch (item.id) {
      case "hasBankAndUpi":
        return { ...item, detail: d.hasBank && !d.hasUpi ? "UPI ID still to add" : !d.hasBank && d.hasUpi ? "Bank account still to add" : null };
      case "hasFrnAndMembership": {
        const parts: string[] = [];
        if (!d.hasFrn) parts.push("FRN still to add");
        if (d.partners === 0) parts.push("No active Partner");
        else if (missing.length) parts.push(`No membership number for ${namesList(missing.map((p) => p.name))}`);
        const href = !d.hasFrn ? "/settings/firm" : mine ? "/profile" : firstOther?.employeeId ? `/people/${firstOther.employeeId}` : "/people";
        return { ...item, href, detail: parts.join(" · ") || null };
      }
      case "emailDomainVerified":
        return { ...item, detail: d.domainStatus === "pending" ? "DNS records added, waiting for verification" : d.domainStatus === "failed" ? "Verification failed: check the DNS records" : null };
      case "hasWhatsAppNumbers":
        return { ...item, detail: d.whatsappSlots > 0 ? `0 of ${d.whatsappSlots} numbers entered` : null };
      case "teamAdded":
        return { ...item, detail: d.teamMembers <= 1 ? "Only you so far" : null };
      case "lawReviewed":
        return { ...item, detail: "Confirm every [verify] item before relying on it" };
      default:
        return { ...item, detail: null };
    }
  });
  return { items, done: base.done, complete: base.complete, percent: Math.round((base.done / base.items.length) * 100) };
}

// -------------------------------------------------------------------------------------------------
// Invoiced and collected by month (Firm today's chart): months not yet begun are missing values,
// not zeros, so the lines stop at this month instead of dropping to nothing (DESIGN.md: a forecast
// is not a fact).
// -------------------------------------------------------------------------------------------------

export type FyMonthRow = { month: string; label: string; invoicedPaise: Paise | null; collectedPaise: Paise | null };

/** "2026-04" → "Apr"; each month's figures as given (null for a month that hasn't begun). */
export function fyMonthRows(rows: ReadonlyArray<{ month: string; invoicedPaise: Paise | null; collectedPaise: Paise | null }>): FyMonthRow[] {
  return rows.map((r) => {
    const { month } = parseDateString(`${r.month}-01`);
    return { month: r.month, label: MONTH_ABBR[month - 1], invoicedPaise: r.invoicedPaise, collectedPaise: r.collectedPaise };
  });
}

/** The FY so far: the sums of the months that have begun, in paise. */
export function fyToDate(rows: readonly FyMonthRow[]): { invoicedPaise: Paise; collectedPaise: Paise; months: number } {
  const begun = rows.filter((r) => r.invoicedPaise !== null || r.collectedPaise !== null);
  return {
    invoicedPaise: sumPaise(begun.map((r) => r.invoicedPaise ?? 0)),
    collectedPaise: sumPaise(begun.map((r) => r.collectedPaise ?? 0)),
    months: begun.length,
  };
}

// -------------------------------------------------------------------------------------------------
// Receivables ageing from the database's buckets (0216, the payments dashboard's keys)
// -------------------------------------------------------------------------------------------------

const SQL_AGEING: Record<string, AgeingBucketId> = { "0_30": "d0_30", "31_60": "d31_60", "61_90": "d61_90", "90_plus": "d90_plus" };

/** Every bucket in order (zero when the database has none), labelled "0–30 days" … "90+ days". */
export function ageingFromBuckets(rows: ReadonlyArray<{ bucket: string; count: number; paise: Paise }>): AgeingRow[] {
  const by = new Map<AgeingBucketId, { count: number; paise: Paise }>();
  for (const r of rows) {
    const id = SQL_AGEING[r.bucket];
    if (id) by.set(id, { count: r.count, paise: r.paise });
  }
  return AGEING_BUCKETS.map((b) => ({ id: b.id, label: b.label, count: by.get(b.id)?.count ?? 0, paise: by.get(b.id)?.paise ?? 0 }));
}

// -------------------------------------------------------------------------------------------------
// At-risk clients from the database's per-client counts (0216)
// -------------------------------------------------------------------------------------------------

/** The rows as the list shows them, each with why it is at risk; the database already sorted them. */
export function atRiskFromCounts(rows: ReadonlyArray<{ clientId: string; clientName: string; overdueTasks: number; receivablesOldPaise: Paise }>): AtRiskClient[] {
  return rows
    .map((r) => {
      const reasons = atRiskReasons({ overdueTasks: r.overdueTasks, receivablesOver90Paise: r.receivablesOldPaise });
      return { clientId: r.clientId, clientName: r.clientName, overdueTasks: r.overdueTasks, receivablesOver90Paise: r.receivablesOldPaise, reasons };
    })
    .filter((r) => r.reasons.length > 0);
}

// -------------------------------------------------------------------------------------------------
// Practice health (§7.2 Partner): which items need the Partner, so the block can say so first
// -------------------------------------------------------------------------------------------------

/** "Act" items are overdue or failing (red mark); "watch" items are coming up; the rest are fine. */
export type HealthLevel = "act" | "watch" | "fine";

/** Tax audits against the ceiling: over or at it is act; within the warning counts, watch. */
export function ceilingLevel(warnings: ReadonlyArray<"near" | "at_ceiling" | "over" | null>): HealthLevel {
  if (warnings.some((w) => w === "over" || w === "at_ceiling")) return "act";
  return warnings.some((w) => w === "near") ? "watch" : "fine";
}

/** UDINs: any signed report past the 60 days is act; any still to generate, watch. */
export function udinLevel(rows: ReadonlyArray<{ daysLate: number | null }>, total: number): HealthLevel {
  if (rows.some((r) => r.daysLate !== null && r.daysLate > 0)) return "act";
  return total > 0 ? "watch" : "fine";
}

/** Peer review: missing or expired is act; expiring (within the warning days) is watch. */
export function peerReviewLevel(state: "missing" | "valid" | "expiring" | "expired"): HealthLevel {
  return state === "missing" || state === "expired" ? "act" : state === "expiring" ? "watch" : "fine";
}

/** A count that is overdue (act) or coming up (watch). */
export function countLevel(overdue: number, upcoming: number): HealthLevel {
  return overdue > 0 ? "act" : upcoming > 0 ? "watch" : "fine";
}

/** PCs on a firm number: over WhatsApp's limit is act; at it, watch (§7.25.7). */
export function linkedPcLevel(numbers: ReadonlyArray<{ atLimit: boolean; overLimit: boolean }>): HealthLevel {
  if (numbers.some((n) => n.overLimit)) return "act";
  return numbers.some((n) => n.atLimit) ? "watch" : "fine";
}

/** How many health items need acting on, and how many to watch (the block's one-line summary). */
export function healthTally(levels: ReadonlyArray<HealthLevel | null>): { act: number; watch: number } {
  return { act: levels.filter((l) => l === "act").length, watch: levels.filter((l) => l === "watch").length };
}

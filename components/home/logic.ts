/**
 * The home pages' wording and links (§7.2), pure and client-safe:
 *   - the one-line finding under each page title (what most needs attention, in counts);
 *   - deadlines grouped by the filings grid's return types for the "filing status" chart;
 *   - each person's capacity next to their overdue tasks (Team today);
 *   - the filtered lists every tile and section links to (§7.2: "every tile links to the filtered
 *     list behind it"), built with the same params the pages read.
 */

import { GRID_RETURN_TYPES, matchesReturnType } from "@/lib/schemas/compliance";
import { filingStatusByType, type FilingStatusRow, type PersonCount } from "@/lib/domain/dashboard";
import { CAPACITY_BANDS, type CapacityAssessment } from "@/lib/domain/capacity";
import { formatINRCompact, type Paise } from "@/lib/domain/money";
import type { DateString } from "@/lib/domain/fy";
import { tableHref } from "@/components/app/data-table/params";
import { ME, NONE, OPEN_TASK_STATUSES } from "@/lib/schemas/tasks";

// -------------------------------------------------------------------------------------------------
// Words
// -------------------------------------------------------------------------------------------------

/** "1 task", "3 tasks"; `many` for irregular plurals ("people"). */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** The non-empty parts joined with " · ", or null when there are none. */
export function joinFinding(parts: ReadonlyArray<string | null | false | undefined>): string | null {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return kept.length ? kept.join(" · ") : null;
}

/** My day: what is waiting on the person, most pressing first. */
export function myDayFinding(c: { waiting: number; sentBack: number; overdue: number; dueToday: number; review: number }): string {
  return (
    joinFinding([
      c.sentBack > 0 && `${count(c.sentBack, "task")} sent back to you`,
      c.waiting > 0 && `${count(c.waiting, "task")} waiting for you to accept`,
      c.overdue > 0 && `${c.overdue.toLocaleString("en-IN")} overdue`,
      c.dueToday > 0 && `${c.dueToday.toLocaleString("en-IN")} due today`,
      c.review > 0 && `${count(c.review, "task")} to review`,
    ]) ?? "Nothing is overdue, due today or waiting on you."
  );
}

/** Team today: who is stuck and who is over capacity. */
export function teamFinding(c: { unassigned: number; declined: number; waiting: number; overdue: number; overCapacity: number }): string {
  return (
    joinFinding([
      c.declined > 0 && `${count(c.declined, "declined task")} to reassign`,
      c.unassigned > 0 && `${c.unassigned.toLocaleString("en-IN")} unassigned`,
      c.overdue > 0 && `${count(c.overdue, "task")} overdue`,
      c.overCapacity > 0 && `${count(c.overCapacity, "person", "people")} over capacity`,
      c.waiting > 0 && `${c.waiting.toLocaleString("en-IN")} waiting for acceptance`,
    ]) ?? "Nothing is unassigned, declined or overdue."
  );
}

/** Firm today: decisions waiting, then whether the firm is on time and getting paid. */
export function firmFinding(c: { approvals: number; overdueCount: number; overduePaise: Paise; filingsDueIn7: number; overdueTasks: number }): string {
  return (
    joinFinding([
      c.approvals > 0 && `${count(c.approvals, "approval")} waiting for you`,
      c.overdueCount > 0 && `${formatINRCompact(c.overduePaise)} overdue on ${count(c.overdueCount, "invoice")}`,
      c.filingsDueIn7 > 0 && `${count(c.filingsDueIn7, "filing")} due in 7 days`,
      c.overdueTasks > 0 && `${count(c.overdueTasks, "task")} overdue`,
    ]) ?? "No approvals waiting, nothing overdue and no filings due in the next 7 days."
  );
}

// -------------------------------------------------------------------------------------------------
// Filing status by return type
// -------------------------------------------------------------------------------------------------

export const OTHER_RETURNS = "other";

/** The filings grid's return type for a deadline ("gstr_3b", "tds_return" …), or "other". */
export function returnTypeKey(e: { type: string; form_code: string | null; rule_code: string | null }): string {
  return GRID_RETURN_TYPES.find((rt) => matchesReturnType(e, rt))?.key ?? OTHER_RETURNS;
}

export function returnTypeLabel(key: string): string {
  return GRID_RETURN_TYPES.find((rt) => rt.key === key)?.label ?? "Other";
}

export type ReturnTypeStatus = FilingStatusRow & { label: string; href: string | null };

/**
 * Deadlines due in a period by the filings grid's return types (filed, pending, overdue), in the
 * grid's order with "Other" last; types with nothing due are left out.
 */
export function filingStatusByReturnType(
  events: ReadonlyArray<{ type: string; form_code: string | null; rule_code: string | null; status: "pending" | "completed" | "cancelled"; due_date: DateString }>,
  today: DateString,
): ReturnTypeStatus[] {
  const order = [...GRID_RETURN_TYPES.map((rt) => rt.key), OTHER_RETURNS];
  const rows = filingStatusByType(
    events.map((e) => ({ type: returnTypeKey(e), status: e.status, dueDate: e.due_date })),
    today,
    order,
  );
  return rows.map((r) => ({ ...r, label: returnTypeLabel(r.type), href: r.type === OTHER_RETURNS ? null : `/filings?type=${r.type}` }));
}

// -------------------------------------------------------------------------------------------------
// The team: capacity and overdue work, one row a person
// -------------------------------------------------------------------------------------------------

export type TeamLoadRow = { id: string; name: string; capacity: CapacityAssessment | null; overdue: number };

/**
 * Overdue tasks by person and team capacity (§7.2 Manager, §7.11.4) as one list: every active person
 * with their capacity, plus anyone no longer active who still holds overdue work. Most overdue
 * first, then the most loaded band, then the highest rate, then by name. Unassigned overdue work is
 * not a person and is left out (the caller shows it on its own line).
 */
export function teamLoadRows(
  capacity: ReadonlyArray<{ id: string; name: string; capacity: CapacityAssessment }>,
  overdue: readonly PersonCount[],
): TeamLoadRow[] {
  const overdueBy = new Map(overdue.filter((o) => o.employeeId).map((o) => [o.employeeId as string, o.count]));
  const active = new Set(capacity.map((c) => c.id));
  const rows: TeamLoadRow[] = capacity.map((c) => ({ id: c.id, name: c.name, capacity: c.capacity, overdue: overdueBy.get(c.id) ?? 0 }));
  for (const o of overdue) if (o.employeeId && !active.has(o.employeeId)) rows.push({ id: o.employeeId, name: o.name, capacity: null, overdue: o.count });
  const band = (r: TeamLoadRow) => (r.capacity ? CAPACITY_BANDS.indexOf(r.capacity.band) : -1);
  return rows.sort((a, b) => b.overdue - a.overdue || band(b) - band(a) || (b.capacity?.perDay ?? 0) - (a.capacity?.perDay ?? 0) || a.name.localeCompare(b.name));
}

// -------------------------------------------------------------------------------------------------
// Links
// -------------------------------------------------------------------------------------------------

const OPEN = [...OPEN_TASK_STATUSES];

/** The work tracker filtered to a queue, with the same filters the page reads (lib/schemas/tasks). */
export const workHref = {
  myOpen: () => tableHref("/work", { filters: { assignee: [ME], status: OPEN }, sort: "due_date", dir: "asc" }),
  myWaiting: () => tableHref("/work", { filters: { assignee: [ME], acceptance: ["pending"], status: OPEN }, sort: "due_date", dir: "asc" }),
  myOverdue: () => tableHref("/work", { filters: { assignee: [ME], due: ["overdue"] }, sort: "due_date", dir: "asc" }),
  mySentBack: () => tableHref("/work", { filters: { assignee: [ME], status: ["in_progress"] }, sort: "updated_at", dir: "desc" }),
  review: () => "/work?view=review",
  unassigned: () => tableHref("/work", { filters: { assignee: [NONE], status: OPEN }, sort: "due_date", dir: "asc" }),
  waiting: () => tableHref("/work", { filters: { acceptance: ["pending"], status: OPEN }, sort: "due_date", dir: "asc" }),
  declined: () => tableHref("/work", { filters: { acceptance: ["declined"], assignee: [NONE], status: OPEN }, sort: "due_date", dir: "asc" }),
  dataAwaited: () => tableHref("/work", { filters: { status: ["data_awaited"] }, sort: "due_date", dir: "asc" }),
  overdue: () => tableHref("/work", { filters: { due: ["overdue"] }, sort: "due_date", dir: "asc" }),
  overdueFor: (employeeId: string | null) => tableHref("/work", { filters: { due: ["overdue"], assignee: [employeeId ?? NONE] }, sort: "due_date", dir: "asc" }),
  dueThisWeek: () => tableHref("/work", { filters: { due: ["this_week"], status: OPEN }, sort: "due_date", dir: "asc" }),
};

/** A deadline opened in the calendar's agenda on its due date (the event sheet, §7.7). */
export function deadlineHref(e: { id: string; due_date: DateString }): string {
  return `/calendar?view=agenda&date=${e.due_date}&event=${e.id}`;
}

/** The calendar's agenda from a date (every deadline from then on, soonest first). */
export function agendaHref(from: DateString): string {
  return `/calendar?view=agenda&date=${from}`;
}

/** The calendar's week view of the week holding `date`. */
export function weekHref(date: DateString): string {
  return `/calendar?view=week&date=${date}`;
}

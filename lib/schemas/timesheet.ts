/**
 * Timesheet inputs and the pure rules of the week grid (§7.10): the timer, manual entries (start
 * and end, or a duration), the week grid (days × tasks) with its daily and weekly totals against
 * the target, copying last week's rows, week approval, utilisation and budget against actual.
 * Shared by the forms (client) and server/actions/timesheet.ts. Client-safe.
 *
 * Weeks run Monday–Sunday in IST. A duration-only entry starts at midnight IST of its date, so it
 * lands on the right day of the grid; the database works out its end (time_entries_guard, 0132).
 */

import { z } from "zod";
import { addDays, diffDays, isDateString, istDayBounds, isWorkingDay, isoWeekday, MONTH_ABBR, nowIST, parseDateString, type DateString } from "@/lib/domain/fy";
import type { LeaveSpan } from "@/lib/domain/capacity";
import { isApprovedLeave } from "@/lib/domain/capacity";
import { parseTimeOfDay } from "@/lib/domain/attendance";

// =================================================================================================
// Weeks
// =================================================================================================

export const TIMESHEET_VIEWS = ["mine", "team", "unbilled"] as const;
export type TimesheetView = (typeof TIMESHEET_VIEWS)[number];

export function readTimesheetView(v: string | null | undefined, canSeeTeam: boolean): TimesheetView {
  const view = (TIMESHEET_VIEWS as readonly string[]).includes(v ?? "") ? (v as TimesheetView) : "mine";
  return view !== "mine" && !canSeeTeam ? "mine" : view;
}

/** The Monday of the week a date falls in. */
export function weekStartOf(date: DateString): DateString {
  return addDays(date, 1 - isoWeekday(date));
}

/** `?week=2026-10-19` (any day of it) → its Monday; anything else → this week's Monday. */
export function readWeekParam(v: string | null | undefined, today: DateString): DateString {
  return weekStartOf(v && isDateString(v) ? v : today);
}

/** The seven dates of the week, Monday first. */
export function weekDates(monday: DateString): DateString[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** `19–25 Oct 2026`, or `28 Sep – 04 Oct 2026` across months, `29 Dec 2025 – 04 Jan 2026` across years. */
export function weekLabel(monday: DateString): string {
  const sunday = addDays(monday, 6);
  const a = parseDateString(monday);
  const b = parseDateString(sunday);
  const dd = (n: number) => String(n).padStart(2, "0");
  if (a.year !== b.year) return `${dd(a.day)} ${MONTH_ABBR[a.month - 1]} ${a.year} – ${dd(b.day)} ${MONTH_ABBR[b.month - 1]} ${b.year}`;
  if (a.month !== b.month) return `${dd(a.day)} ${MONTH_ABBR[a.month - 1]} – ${dd(b.day)} ${MONTH_ABBR[b.month - 1]} ${b.year}`;
  return `${dd(a.day)}–${dd(b.day)} ${MONTH_ABBR[b.month - 1]} ${b.year}`;
}

/** `Mon 19`: a grid column's heading. */
export function dayHeading(date: DateString): { weekday: string; day: string } {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return { weekday: names[isoWeekday(date) - 1], day: String(parseDateString(date).day).padStart(2, "0") };
}

// =================================================================================================
// Durations and times of day
// =================================================================================================

export const MAX_ENTRY_MINUTES = 24 * 60;

/**
 * A typed duration in minutes, or null when it can't be read: `1:30`, `1h 30m`, `1h`, `45m`,
 * `90 min`, or a bare number of hours (`2`, `1.5`, `0.25`). Rounded to the minute.
 */
export function parseDuration(text: string | null | undefined): number | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  let m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d{1,3}(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,4})\s*m(?:in(?:ute)?s?)?)?$/.exec(t);
  if (m && (m[1] !== undefined || m[2] !== undefined)) {
    return Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
  }
  m = /^(\d{1,3}(?:\.\d+)?)$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  return null;
}

/** Minutes as the grid cell shows and accepts them: `1:30`, `0:45`; "" for none. */
export function formatDurationInput(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A running timer's elapsed time: `5:09`, `1:05:09`, `26:00:00`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A timer running longer than this is flagged ("Still working? Stop it and correct the time"). */
export const LONG_TIMER_HOURS = 10;

export type EntryTimes =
  | { ok: true; started_at: string; ended_at: string | null; minutes: number; entry_source: "manual_range" | "manual_duration" }
  | { ok: false; field: "start" | "end" | "duration" | "date"; error: string };

/**
 * The instants a manual entry is stored with (§7.10 "Start/End or Duration"): a range on its IST
 * date, or a duration starting at midnight IST of the date.
 */
export function entryTimes(input: { date: string; mode: "range" | "duration"; start?: string | null; end?: string | null; duration?: string | null }): EntryTimes {
  if (!isDateString(input.date)) return { ok: false, field: "date", error: "Choose the date." };
  const dayStart = istDayBounds(input.date).start.getTime();
  if (input.mode === "duration") {
    const minutes = parseDuration(input.duration);
    if (minutes === null || minutes <= 0) return { ok: false, field: "duration", error: "Enter how long, for example 1:30 or 1h 30m." };
    if (minutes > MAX_ENTRY_MINUTES) return { ok: false, field: "duration", error: "One entry can't be longer than 24 hours." };
    return { ok: true, started_at: new Date(dayStart).toISOString(), ended_at: null, minutes, entry_source: "manual_duration" };
  }
  let start: number;
  let end: number;
  try {
    start = parseTimeOfDay(input.start ?? "");
  } catch {
    return { ok: false, field: "start", error: "Enter the start time as HH:MM." };
  }
  try {
    end = parseTimeOfDay(input.end ?? "");
  } catch {
    return { ok: false, field: "end", error: "Enter the end time as HH:MM." };
  }
  if (end <= start) return { ok: false, field: "end", error: "The end time must be after the start time." };
  return {
    ok: true,
    started_at: new Date(dayStart + start * 60_000).toISOString(),
    ended_at: new Date(dayStart + end * 60_000).toISOString(),
    minutes: end - start,
    entry_source: "manual_range",
  };
}

/** `HH:MM` in IST for an instant (the edit form's start and end). */
export function istClock(instant: string | Date): string {
  const p = nowIST(typeof instant === "string" ? new Date(instant) : instant);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

// =================================================================================================
// Targets (§7.10 "daily and weekly totals vs target")
// =================================================================================================

/**
 * Each day's target in minutes for one person: the weekly target (firm_settings.weekly_hours_target)
 * spread over the firm's working weekdays, nothing on a non-working day or holiday, half on a
 * half-day of approved leave and nothing on a whole day of it.
 */
export function dayTargets(
  dates: readonly DateString[],
  opts: { weeklyHours: number; weekdays: readonly number[]; holidays?: readonly DateString[]; leaves?: readonly LeaveSpan[] },
): number[] {
  const perDay = opts.weekdays.length > 0 ? Math.round((opts.weeklyHours * 60) / opts.weekdays.length) : 0;
  return dates.map((d) => {
    if (!isWorkingDay(d, { weekdays: opts.weekdays, holidays: opts.holidays })) return 0;
    const leave = (opts.leaves ?? []).find((l) => isApprovedLeave(l) && diffDays(d, l.start) >= 0 && diffDays(l.end, d) >= 0);
    if (!leave) return perDay;
    return leave.halfDay && leave.start === leave.end ? Math.round(perDay / 2) : 0;
  });
}

/** Billable ÷ total as a percentage to one decimal, or null with no time logged (§7.10 utilisation). */
export function utilisation(billableMinutes: number, totalMinutes: number): number | null {
  if (totalMinutes <= 0) return null;
  return Math.round((Math.max(0, billableMinutes) * 1000) / totalMinutes) / 10;
}

export type BudgetState = "none" | "under" | "near" | "over";

/** Budget (estimate) against actual (time logged) for a task (§7.10 team timesheet, §7.6.6 bar). */
export function budgetState(estimateMinutes: number | null, loggedMinutes: number): { state: BudgetState; percent: number | null } {
  if (!estimateMinutes || estimateMinutes <= 0) return { state: "none", percent: null };
  const percent = Math.round((loggedMinutes * 100) / estimateMinutes);
  return { state: percent > 100 ? "over" : percent >= 80 ? "near" : "under", percent };
}

// =================================================================================================
// The week grid (§7.10 "a week grid (days × tasks)")
// =================================================================================================

export type GridEntry = {
  id: string;
  started_at: string;
  ended_at: string | null;
  minutes: number;
  client_id: string | null;
  task_id: string | null;
  billable: boolean;
  entry_source: string;
  locked: boolean;
  invoice_id: string | null;
};

export type GridRowRef = { id?: string; client_id: string | null; task_id: string | null; billable: boolean };

export type GridCell = {
  date: DateString;
  minutes: number;
  entryIds: string[];
  /** Typed straight into the cell: empty, or exactly one unlocked duration entry. */
  editable: boolean;
  /** The single duration entry the cell edits, if any. */
  durationEntryId: string | null;
  locked: boolean;
};

export type GridRow = {
  key: string;
  client_id: string | null;
  task_id: string | null;
  billable: boolean;
  /** timesheet_week_rows.id when the row is kept on the grid without time. */
  savedRowId: string | null;
  cells: GridCell[];
  total: number;
};

export type WeekGrid = { rows: GridRow[]; dayTotals: number[]; total: number; billable: number; running: GridEntry | null };

export function gridKey(r: { client_id: string | null; task_id: string | null; billable: boolean }): string {
  return `${r.client_id ?? "-"}|${r.task_id ?? "-"}|${r.billable ? "b" : "n"}`;
}

/**
 * Builds the grid from the week's entries and saved rows. Rows are one per client, task and
 * billable flag; a running timer counts nowhere until it stops (it is returned separately). Rows
 * come in first-seen order: saved rows first (their sort order), then rows that only have entries.
 */
export function buildWeekGrid(dates: readonly DateString[], entries: readonly GridEntry[], saved: readonly GridRowRef[]): WeekGrid {
  const rows = new Map<string, GridRow>();
  const ensure = (r: GridRowRef): GridRow => {
    const key = gridKey(r);
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        client_id: r.client_id,
        task_id: r.task_id,
        billable: r.billable,
        savedRowId: null,
        cells: dates.map((date) => ({ date, minutes: 0, entryIds: [], editable: true, durationEntryId: null, locked: false })),
        total: 0,
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const s of saved) {
    const row = ensure(s);
    if (s.id && !row.savedRowId) row.savedRowId = s.id;
  }
  let running: GridEntry | null = null;
  for (const e of entries) {
    if (e.ended_at === null) {
      running = e;
      continue;
    }
    const date = nowIST(new Date(e.started_at)).date;
    const i = dates.indexOf(date);
    if (i < 0) continue;
    const row = ensure(e);
    const cell = row.cells[i];
    cell.minutes += e.minutes;
    cell.entryIds.push(e.id);
    const isLocked = e.locked || e.invoice_id !== null;
    cell.locked = cell.locked || isLocked;
    row.total += e.minutes;
  }
  for (const row of rows.values()) {
    for (const cell of row.cells) {
      if (cell.entryIds.length === 0) continue;
      const only = cell.entryIds.length === 1 ? entries.find((e) => e.id === cell.entryIds[0]) : undefined;
      const isDuration = only?.entry_source === "manual_duration";
      cell.editable = !cell.locked && isDuration === true;
      cell.durationEntryId = isDuration && only ? only.id : null;
    }
  }
  const list = [...rows.values()];
  const dayTotals = dates.map((_, i) => list.reduce((n, r) => n + r.cells[i].minutes, 0));
  const total = dayTotals.reduce((a, b) => a + b, 0);
  const billable = list.filter((r) => r.billable).reduce((n, r) => n + r.total, 0);
  return { rows: list, dayTotals, total, billable, running };
}

/** Last week's rows to copy into this week: each client, task and billable combination once, minus those already here. */
export function rowsToCopy(lastWeek: readonly GridRowRef[], thisWeek: readonly GridRowRef[]): GridRowRef[] {
  const have = new Set(thisWeek.map(gridKey));
  const out: GridRowRef[] = [];
  for (const r of lastWeek) {
    const k = gridKey(r);
    if (have.has(k)) continue;
    have.add(k);
    out.push({ client_id: r.client_id, task_id: r.task_id, billable: r.billable });
  }
  return out;
}

// =================================================================================================
// Schemas
// =================================================================================================

const idField = z.uuid({ error: "Reload the page and try again." });
const optionalId = (error: string) =>
  z
    .union([z.uuid({ error }), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));
const mondayField = z
  .string()
  .refine((v) => isDateString(v) && isoWeekday(v) === 1, { error: "Choose the week by its Monday." });

export const StartTimerSchema = z.object({
  task_id: optionalId("Choose the task again."),
  client_id: optionalId("Choose the client again."),
  description: optionalText(500),
  billable: z.boolean().nullish(),
});
export type StartTimerInput = z.input<typeof StartTimerSchema>;

export const StopTimerSchema = z.object({ description: optionalText(500) });

export const TimeEntrySchema = z
  .object({
    id: optionalId("Reload the page and try again."),
    expected_updated_at: z.string().nullish(),
    date: z.string().refine((v) => isDateString(v), { error: "Choose the date." }),
    client_id: optionalId("Choose the client again."),
    task_id: optionalId("Choose the task again."),
    mode: z.enum(["range", "duration"]),
    start: z.string().trim().optional(),
    end: z.string().trim().optional(),
    duration: z.string().trim().optional(),
    description: optionalText(500),
    billable: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const t = entryTimes(v);
    if (!t.ok) ctx.addIssue({ code: "custom", path: [t.field], message: t.error });
  });
export type TimeEntryInput = z.input<typeof TimeEntrySchema>;

export const DeleteEntrySchema = z.object({ id: idField });

/** One grid cell typed in: the day's duration for a row ("" or 0 removes it). */
export const SetCellSchema = z.object({
  week_start: mondayField,
  date: z.string().refine((v) => isDateString(v), { error: "Choose the day." }),
  client_id: optionalId("Choose the client again."),
  task_id: optionalId("Choose the task again."),
  billable: z.boolean(),
  duration: z.string().trim().max(20),
  entry_id: optionalId("Reload the page and try again."),
});

export const AddRowSchema = z.object({
  week_start: mondayField,
  client_id: optionalId("Choose the client again."),
  task_id: optionalId("Choose the task again."),
  billable: z.boolean().default(true),
});
export const RemoveRowSchema = z.object({ id: idField });
export const CopyLastWeekSchema = z.object({ week_start: mondayField });

export const ApproveWeekSchema = z.object({ employee_id: idField, week_start: mondayField, note: optionalText(500) });
export const ReopenWeekSchema = z.object({
  employee_id: idField,
  week_start: mondayField,
  reason: z.string().trim().min(1, { error: "Give a reason for reopening this week." }).max(500),
});

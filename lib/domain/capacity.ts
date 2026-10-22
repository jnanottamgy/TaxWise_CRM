/**
 * Capacity: open tasks per working day and the CLEAR / BUSY / TIGHT / OVER band (§7.11.4, §7.6.2).
 *
 * - Per person: open tasks due in the window ÷ working days left in it = tasks per working day.
 *   Working days exclude non-working weekdays (`firm_settings.working_weekdays`), firm holidays and
 *   the person's approved leave; a half-day leave takes half a day off.
 * - Bands: **CLEAR** < busy · **BUSY** ≥ busy · **TIGHT** ≥ tight · **OVER** ≥ over. The thresholds
 *   are firm settings (`firm_settings.capacity_thresholds`, Settings → Working hours, §7.21), seeded
 *   from `CAPACITY_DEFAULTS` (1.5 / 2.5 / 4) and always passed in.
 * - No working days left is said in words ("no working days left before the due date"), never a
 *   division by zero (§7.6.2).
 *
 * Comparisons are exact: the ratio is compared in integers (tasks × 200 against threshold-hundredths
 * × half-days), so a threshold such as 1.1 never misfires on float error. The displayed figure is
 * rounded half-up to one decimal ("4.0 a day").
 *
 * Pure and client-safe.
 */

import type { LeaveStatus } from "@/lib/domain/enums";
import { addDays, diffDays, isWorkingDay, type DateString } from "@/lib/domain/fy";
import { divideRoundHalfUp } from "@/lib/domain/money";
import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce } from "@/lib/domain/gst";

// -------------------------------------------------------------------------------------------------
// Bands and thresholds
// -------------------------------------------------------------------------------------------------

export const CAPACITY_BANDS = ["clear", "busy", "tight", "over"] as const;
export type CapacityBand = (typeof CAPACITY_BANDS)[number];

/** The band names as the UI prints them (§7.11.4). */
export const CAPACITY_BAND_LABELS: Record<CapacityBand, string> = {
  clear: "CLEAR",
  busy: "BUSY",
  tight: "TIGHT",
  over: "OVER",
};

/** Tasks-per-working-day thresholds: a band starts AT its threshold (`≥`). */
export type CapacityThresholds = { busy: number; tight: number; over: number };

/** The §7.11.4 seed values (also `firm_settings.capacity_thresholds` and the seed SQL). */
export const CAPACITY_DEFAULTS: CapacityThresholds = { busy: 1.5, tight: 2.5, over: 4 };

/** The `statutory_parameters` key holding the seeded bands (firm_settings has the editable copy). */
export const CAPACITY_PARAM_KEYS = {
  /** `{"busy": 1.5, "tight": 2.5, "over": 4}`. */
  bands: "capacity.bands",
} as const;

/**
 * The capacity row of `supabase/seed/42_params_practice.sql` (§16). Firm practice, not law, so it
 * is seeded verified; `firm_settings.capacity_thresholds` is the copy Partners edit (§7.21).
 */
export const CAPACITY_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: CAPACITY_PARAM_KEYS.bands,
    value: { busy: CAPACITY_DEFAULTS.busy, tight: CAPACITY_DEFAULTS.tight, over: CAPACITY_DEFAULTS.over },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: "Firm practice",
    sectionRef: "§7.11.4 capacity bands",
    sourceRef: "TaxWise Practice OS specification §7.11.4",
    notes: "Tasks per working day: CLEAR below 1.5, BUSY from 1.5, TIGHT from 2.5, OVER from 4. firm_settings.capacity_thresholds is the copy used at run time (Settings → Working hours).",
    verified: true,
  },
];

/**
 * Why a set of thresholds can't be used, or null when it can: each must be a positive number and
 * they must rise strictly (busy < tight < over), as Settings enforces (§7.21).
 */
export function validateCapacityThresholds(t: CapacityThresholds): string | null {
  for (const [name, v] of Object.entries(t)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return `The ${name} threshold must be a positive number.`;
  }
  if (!(t.busy < t.tight)) return "Tight must be higher than Busy.";
  if (!(t.tight < t.over)) return "Over must be higher than Tight.";
  return null;
}

function toThreshold(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Reads thresholds from a jsonb value (`firm_settings.capacity_thresholds` or the `capacity.bands`
 * parameter). Anything missing or inconsistent falls back to `fallback` as a whole.
 */
export function readCapacityThresholds(value: unknown, fallback: CapacityThresholds = CAPACITY_DEFAULTS): CapacityThresholds {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const o = value as Record<string, unknown>;
  const t = { busy: toThreshold(o.busy), tight: toThreshold(o.tight), over: toThreshold(o.over) };
  if (t.busy === null || t.tight === null || t.over === null) return { ...fallback };
  const parsed: CapacityThresholds = { busy: t.busy, tight: t.tight, over: t.over };
  return validateCapacityThresholds(parsed) === null ? parsed : { ...fallback };
}

/** The seeded bands in force on a date (§5.12), or the defaults when the row is missing. */
export function resolveCapacityThresholds(rows: readonly StatutoryParameterRow[], on: DateString): CapacityThresholds {
  const row = parameterInForce(rows, CAPACITY_PARAM_KEYS.bands, on);
  return readCapacityThresholds(row?.value);
}

// -------------------------------------------------------------------------------------------------
// Working days left (§7.11.4)
// -------------------------------------------------------------------------------------------------

/** A leave span as capacity needs it. Only approved leave counts (a missing status means approved). */
export type LeaveSpan = {
  start: DateString;
  end: DateString;
  status?: LeaveStatus;
  /** Half a day off; applies to a single-day leave (`start === end`), as leave requests allow (§7.11.3). */
  halfDay?: boolean;
};

export type WorkingCalendar = {
  /** ISO weekdays that are working days (1 = Monday), `firm_settings.working_weekdays`. */
  weekdays: readonly number[];
  /** Firm holidays (non-working for capacity and attendance, §7.11.3). */
  holidays?: readonly DateString[] | ReadonlySet<DateString>;
  /** The person's leave; requested, declined and cancelled leave is ignored. */
  leaves?: readonly LeaveSpan[];
};

/** True for leave that takes effect: approved, or a span given without a status. */
export function isApprovedLeave(leave: LeaveSpan): boolean {
  return leave.status === undefined || leave.status === "approved";
}

/** Half-days off per date from approved leave (2 = whole day, 1 = half day). */
function leaveHalfDaysOff(leaves: readonly LeaveSpan[] | undefined, from: DateString, to: DateString): Map<DateString, number> {
  const off = new Map<DateString, number>();
  for (const leave of leaves ?? []) {
    if (!isApprovedLeave(leave) || diffDays(leave.end, leave.start) < 0) continue;
    const halves = leave.halfDay && leave.start === leave.end ? 1 : 2;
    const first = diffDays(leave.start, from) > 0 ? leave.start : from;
    const last = diffDays(leave.end, to) < 0 ? leave.end : to;
    for (let d = first; diffDays(last, d) >= 0; d = addDays(d, 1)) off.set(d, Math.max(off.get(d) ?? 0, halves));
  }
  return off;
}

/**
 * Working days from `from` to `to`, **both inclusive** (today counts while it is a working day),
 * excluding non-working weekdays, holidays and approved leave; a half-day leave counts as half.
 * 0 when `to` is before `from`. May be a multiple of 0.5.
 */
export function workingDaysLeft(from: DateString, to: DateString, calendar: WorkingCalendar): number {
  if (diffDays(to, from) < 0) return 0;
  const off = leaveHalfDaysOff(calendar.leaves, from, to);
  const opts = { weekdays: calendar.weekdays, holidays: calendar.holidays };
  let halves = 0;
  for (let d = from; diffDays(to, d) >= 0; d = addDays(d, 1)) {
    if (isWorkingDay(d, opts)) halves += 2 - (off.get(d) ?? 0);
  }
  return halves / 2;
}

// -------------------------------------------------------------------------------------------------
// Tasks per working day and the band (§7.11.4)
// -------------------------------------------------------------------------------------------------

function assertCount(n: number, what: string): void {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${what} must be zero or more; got ${n}.`);
}

function assertTasks(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Open tasks must be a whole number, zero or more; got ${n}.`);
}

/** Working days in half-day units (an integer); throws for a value that isn't a multiple of 0.5. */
function halfDays(workingDays: number): number {
  assertCount(workingDays, "Working days");
  const h = workingDays * 2;
  if (!Number.isInteger(h)) throw new RangeError(`Working days must be a multiple of 0.5; got ${workingDays}.`);
  return h;
}

/** Tasks per working day, or null when there are no working days left (never a divide by zero). */
export function tasksPerWorkingDay(openTasks: number, workingDays: number): number | null {
  assertTasks(openTasks);
  return halfDays(workingDays) === 0 ? null : openTasks / workingDays;
}

/** True when `openTasks / workingDays ≥ threshold`, compared exactly in integers. */
function atLeast(openTasks: number, workingHalfDays: number, threshold: number): boolean {
  const hundredths = Math.round(threshold * 100);
  return openTasks * 200 >= hundredths * workingHalfDays;
}

/**
 * The band for a load (§7.11.4): OVER ≥ over · TIGHT ≥ tight · BUSY ≥ busy · CLEAR below. With no
 * working days left, any open task is OVER (nothing can be done in no time) and none is CLEAR.
 */
export function capacityBand(openTasks: number, workingDays: number, thresholds: CapacityThresholds): CapacityBand {
  assertTasks(openTasks);
  const h = halfDays(workingDays);
  if (h === 0) return openTasks > 0 ? "over" : "clear";
  if (atLeast(openTasks, h, thresholds.over)) return "over";
  if (atLeast(openTasks, h, thresholds.tight)) return "tight";
  if (atLeast(openTasks, h, thresholds.busy)) return "busy";
  return "clear";
}

/** The band for a tasks-per-day figure already worked out (e.g. from a database view). */
export function bandForRate(perDay: number, thresholds: CapacityThresholds): CapacityBand {
  if (perDay >= thresholds.over) return "over";
  if (perDay >= thresholds.tight) return "tight";
  if (perDay >= thresholds.busy) return "busy";
  return "clear";
}

/** Tasks per day to one decimal, half-up: `20 / 5 → "4.0"`, `7 / 3 → "2.3"`. "—" with no days left. */
export function formatPerDay(openTasks: number, workingDays: number): string {
  assertTasks(openTasks);
  const h = halfDays(workingDays);
  if (h === 0) return "—";
  const tenths = divideRoundHalfUp(openTasks * 20, h); // (tasks / (h / 2)) × 10
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function formatDays(workingDays: number): string {
  return Number.isInteger(workingDays) ? String(workingDays) : workingDays.toFixed(1);
}

/**
 * The arithmetic shown in the assignment check (§7.6.2):
 * `"20 open tasks over 5 working days = 4.0 a day"`. With no working days left it says so instead.
 */
export function capacityArithmetic(openTasks: number, workingDays: number): string {
  const tasks = `${openTasks} open ${openTasks === 1 ? "task" : "tasks"}`;
  if (halfDays(workingDays) === 0) return `${tasks} and no working days left`;
  const days = `${formatDays(workingDays)} working ${workingDays === 1 ? "day" : "days"}`;
  return `${tasks} over ${days} = ${formatPerDay(openTasks, workingDays)} a day`;
}

export type CapacityAssessment = {
  openTasks: number;
  workingDays: number;
  /** Exact ratio, or null with no working days left. */
  perDay: number | null;
  band: CapacityBand;
  noWorkingDaysLeft: boolean;
  /** "20 open tasks over 5 working days = 4.0 a day". */
  arithmetic: string;
};

/** Everything the People page, the Manager dashboard and the assignment check show (§7.11.4). */
export function assessCapacity(openTasks: number, workingDays: number, thresholds: CapacityThresholds): CapacityAssessment {
  return {
    openTasks,
    workingDays,
    perDay: tasksPerWorkingDay(openTasks, workingDays),
    band: capacityBand(openTasks, workingDays, thresholds),
    noWorkingDaysLeft: halfDays(workingDays) === 0,
    arithmetic: capacityArithmetic(openTasks, workingDays),
  };
}

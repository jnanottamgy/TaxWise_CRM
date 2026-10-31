/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week), read in UTC, for the
 * scheduled jobs (server/jobs/schedule.ts, §8).
 *
 * - Each field takes `*`, numbers, lists (`1,4,7,10`), ranges (`1-5`) and steps (`*\/15`, `0-30/10`,
 *   `5/15`). Day of week runs 0–7, with 0 and 7 both Sunday.
 * - As in standard cron, when both day of month and day of week are restricted (neither starts with
 *   `*`), a day that matches either one counts; otherwise both must match.
 *
 * Pure and client-safe. Functions whose answer depends on the clock take `now` as a parameter.
 */

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday (a 7 in the expression is folded into 0). */
  weekdays: ReadonlySet<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseField(field: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const item of field.split(",")) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!m) throw new RangeError(`Can't read "${item}" in the ${f.name} field of a cron expression.`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const lo = m[1] ? f.min : Number(m[2]);
    // "5/15" runs from 5 to the end of the range; a bare "5" is just 5.
    const hi = m[1] ? f.max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? f.max : lo;
    if (lo < f.min || hi > f.max || lo > hi || step < 1) {
      throw new RangeError(`"${item}" is out of range for the ${f.name} field (${f.min}–${f.max}).`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Throws a RangeError naming the field it can't read. */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new RangeError(`"${expr}" needs five fields: minute hour day-of-month month day-of-week.`);
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    minutes,
    hours,
    days,
    months,
    weekdays: new Set([...weekdays].map((d) => d % 7)),
    daysRestricted: !parts[2].startsWith("*"),
    weekdaysRestricted: !parts[4].startsWith("*"),
  };
}

/** Whether the expression fires in the UTC minute that `at` falls in. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minutes.has(at.getUTCMinutes()) || !spec.hours.has(at.getUTCHours()) || !spec.months.has(at.getUTCMonth() + 1)) return false;
  const day = spec.days.has(at.getUTCDate());
  const weekday = spec.weekdays.has(at.getUTCDay());
  return spec.daysRestricted && spec.weekdaysRestricted ? day || weekday : day && weekday;
}

/**
 * The latest minute at or before `now` the expression fired, looking back at most `lookbackMinutes`;
 * null when it didn't fire in that window.
 */
export function lastFireTime(expr: string | CronSpec, now: Date, lookbackMinutes: number): Date | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i <= lookbackMinutes; i++) {
    if (cronMatches(spec, t)) return new Date(t.getTime());
    t.setTime(t.getTime() - 60_000);
  }
  return null;
}

/** True for a job that runs less often than daily (a set day of the month, a set month, or a weekday). */
export function runsLessThanDaily(spec: CronSpec): boolean {
  return spec.daysRestricted || spec.weekdaysRestricted || spec.months.size < 12;
}

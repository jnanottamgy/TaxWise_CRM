/**
 * Dates, the financial year and the income-tax statute (§0.1 rule 13, §6.1, §6.3).
 *
 * - "Today" is the calendar date in Asia/Kolkata. IST is a fixed UTC+05:30 with no daylight saving
 *   (since 1945), so it is computed from the offset: exact, and the same on server and browser.
 * - Date-only facts are `'YYYY-MM-DD'` strings. Arithmetic on them goes through whole UTC days, so
 *   there is never a timezone drift.
 * - The financial year runs 1 April – 31 March and is labelled `2026-27`. Quarters: Q1 Apr–Jun,
 *   Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
 *
 * Pure and client-safe. Functions whose answer depends on the clock take `now` as a parameter.
 */

/** A date-only fact, `'YYYY-MM-DD'`. */
export type DateString = string;

/** A financial-year label, `'2026-27'`. */
export type FinancialYear = string;

/** IST offset from UTC, in minutes. */
export const IST_OFFSET_MINUTES = 330;

/** The financial year starts in April (§0.1 rule 13). */
export const FY_START_MONTH = 4;

/**
 * Seed values for the statute rules (§6.1): the Income-tax Act, 2025 governs tax years beginning on
 * or after 1 April 2026, so FY 2026-27 is its first year; FY 2025-26 and earlier stay under the 1961
 * Act. Callers may pass a different value (e.g. from `statutory_parameters`).
 */
export const FY_DEFAULTS = {
  incomeTaxAct2025FirstYear: "2026-27",
} as const;

export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const FY_PATTERN = /^(\d{4})-(\d{2})$/;

// -------------------------------------------------------------------------------------------------
// Date strings
// -------------------------------------------------------------------------------------------------

export type DateParts = { year: number; month: number; day: number };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The number of days in a month (`month` 1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Builds `'YYYY-MM-DD'` from parts (no validation beyond padding). */
export function toDateString(year: number, month: number, day: number): DateString {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** True for a real calendar date written `'YYYY-MM-DD'` (`2026-02-30` is false). */
export function isDateString(value: unknown): value is DateString {
  if (typeof value !== "string") return false;
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(m[1]), month);
}

/** Splits `'YYYY-MM-DD'` into numbers; throws a RangeError for anything that isn't a real date. */
export function parseDateString(date: DateString): DateParts {
  if (!isDateString(date)) throw new RangeError(`Not a date (YYYY-MM-DD): ${String(date)}`);
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

function toEpochDay(date: DateString): number {
  const { year, month, day } = parseDateString(date);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function fromEpochDay(epochDay: number): DateString {
  const d = new Date(epochDay * DAY_MS);
  return toDateString(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `date` plus `days` (negative to go back). */
export function addDays(date: DateString, days: number): DateString {
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * `date` plus `months` calendar months, clamped to the end of a shorter month
 * (`2026-01-31` + 1 → `2026-02-28`).
 */
export function addMonths(date: DateString, months: number): DateString {
  const { year, month, day } = parseDateString(date);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return toDateString(y, m, Math.min(day, daysInMonth(y, m)));
}

/** Whole days from `right` to `left` (`left − right`): `diffDays('2026-10-25', '2026-10-22') === 3`. */
export function diffDays(left: DateString, right: DateString): number {
  return toEpochDay(left) - toEpochDay(right);
}

/** Sort comparator for date strings: negative, zero or positive. */
export function compareDates(a: DateString, b: DateString): number {
  return diffDays(a, b);
}

/** The last day of the date's month. */
export function endOfMonth(date: DateString): DateString {
  const { year, month } = parseDateString(date);
  return toDateString(year, month, daysInMonth(year, month));
}

/** ISO weekday: 1 = Monday … 7 = Sunday (the numbering `firm_settings.working_weekdays` uses). */
export function isoWeekday(date: DateString): number {
  const dow = new Date(toEpochDay(date) * DAY_MS).getUTCDay(); // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

/** True when the date is a Sunday (§6.3: due dates are not moved; the UI shows a hint). */
export function isSunday(date: DateString): boolean {
  return isoWeekday(date) === 7;
}

// -------------------------------------------------------------------------------------------------
// IST "now" and "today"
// -------------------------------------------------------------------------------------------------

function istShifted(instant: Date): Date {
  return new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
}

/** Today's date in Asia/Kolkata, `'YYYY-MM-DD'` (§0.1 rule 13). Pass `now` in tests and jobs. */
export function todayIST(now: Date = new Date()): DateString {
  const s = istShifted(now);
  return toDateString(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
}

export type IstParts = DateParts & {
  date: DateString;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
  /** Minutes since IST midnight, e.g. 09:45 → 585 (attendance compares this with work_day_start). */
  minutesOfDay: number;
};

/** The wall-clock parts of an instant in IST. */
export function nowIST(now: Date = new Date()): IstParts {
  const s = istShifted(now);
  const date = toDateString(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
  const hour = s.getUTCHours();
  const minute = s.getUTCMinutes();
  return {
    date,
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour,
    minute,
    second: s.getUTCSeconds(),
    isoWeekday: isoWeekday(date),
    minutesOfDay: hour * 60 + minute,
  };
}

/**
 * The IST calendar date of a timestamp (a `Date`, or an ISO string as Postgres returns
 * `timestamptz`). A date-only string is returned unchanged. Throws for an unparseable value.
 */
export function istDateOf(value: Date | string): DateString {
  if (typeof value === "string" && isDateString(value)) return value;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) throw new RangeError(`Not a date or timestamp: ${String(value)}`);
  return todayIST(d);
}

/**
 * The UTC instants that bound an IST calendar day: `[start, end)`. Use these to filter
 * `timestamptz` columns by "a day in India".
 */
export function istDayBounds(date: DateString): { start: Date; end: Date } {
  const startMs = toEpochDay(date) * DAY_MS - IST_OFFSET_MINUTES * 60_000;
  return { start: new Date(startMs), end: new Date(startMs + DAY_MS) };
}

// -------------------------------------------------------------------------------------------------
// Financial year (§6.3)
// -------------------------------------------------------------------------------------------------

/** The label for the FY that starts in April of `startYear`: `2026 → '2026-27'`. */
export function financialYearFromStartYear(startYear: number): FinancialYear {
  return `${startYear}-${pad2((startYear + 1) % 100)}`;
}

/** The FY's start year, or null when the label isn't `YYYY-YY` with consecutive years. */
export function parseFinancialYear(fy: string): number | null {
  const m = FY_PATTERN.exec(fy);
  if (!m) return null;
  const start = Number(m[1]);
  return Number(m[2]) === (start + 1) % 100 ? start : null;
}

/** True for a well-formed FY label such as `2026-27` (`2026-28` is false). */
export function isFinancialYear(value: unknown): value is FinancialYear {
  return typeof value === "string" && parseFinancialYear(value) !== null;
}

function startYearOf(fy: FinancialYear): number {
  const start = parseFinancialYear(fy);
  if (start === null) throw new RangeError(`Not a financial year (YYYY-YY): ${fy}`);
  return start;
}

/**
 * The financial year a date falls in (§6.3). A `Date` (an instant) is read in IST, so 31 March
 * 20:00 UTC is already 1 April in India.
 */
export function financialYearOf(date: DateString | Date): FinancialYear {
  const { year, month } = parseDateString(typeof date === "string" ? date : todayIST(date));
  return financialYearFromStartYear(month >= FY_START_MONTH ? year : year - 1);
}

/** 1 April of the FY. */
export function fyStart(fy: FinancialYear): DateString {
  return toDateString(startYearOf(fy), FY_START_MONTH, 1);
}

/** 31 March at the end of the FY. */
export function fyEnd(fy: FinancialYear): DateString {
  return toDateString(startYearOf(fy) + 1, 3, 31);
}

/** True when the date falls in the FY. */
export function fyContains(fy: FinancialYear, date: DateString): boolean {
  return financialYearOf(date) === fy;
}

/** The short form used in document numbers: `'2026-27' → '26-27'` (§5.11). */
export function fyShort(fy: FinancialYear): string {
  const start = startYearOf(fy);
  return `${pad2(start % 100)}-${pad2((start + 1) % 100)}`;
}

/** The FY before: `'2026-27' → '2025-26'`. */
export function previousFinancialYear(fy: FinancialYear): FinancialYear {
  return financialYearFromStartYear(startYearOf(fy) - 1);
}

/** The FY after: `'2026-27' → '2027-28'`. */
export function nextFinancialYear(fy: FinancialYear): FinancialYear {
  return financialYearFromStartYear(startYearOf(fy) + 1);
}

/**
 * The current FY and the `count − 1` before it, newest first (e.g. "Turnover for FY: the last 3
 * FYs", §7.3.2).
 */
export function recentFinancialYears(today: DateString, count: number): FinancialYear[] {
  const start = startYearOf(financialYearOf(today));
  return Array.from({ length: Math.max(0, count) }, (_, i) => financialYearFromStartYear(start - i));
}

// -------------------------------------------------------------------------------------------------
// Quarters and periods (§6.3)
// -------------------------------------------------------------------------------------------------

export type FyQuarter = 1 | 2 | 3 | 4;

/** The FY quarter of a date: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. */
export function quarterOf(date: DateString): FyQuarter {
  const { month } = parseDateString(date);
  return (Math.floor(((month - FY_START_MONTH + 12) % 12) / 3) + 1) as FyQuarter;
}

/** `'Q2 2026-27'` for a date (the `period_label` / `filing_period` form, §5.5, §5.6). */
export function quarterLabel(date: DateString): string {
  return `Q${quarterOf(date)} ${financialYearOf(date)}`;
}

/** The first and last day of an FY quarter. */
export function quarterRange(fy: FinancialYear, quarter: FyQuarter): { start: DateString; end: DateString } {
  const start = addMonths(fyStart(fy), (quarter - 1) * 3);
  return { start, end: endOfMonth(addMonths(start, 2)) };
}

/** `'Sep 2026'` for a date (monthly `period_label` / `filing_period`, §5.5, §5.6). */
export function monthPeriodLabel(date: DateString): string {
  const { year, month } = parseDateString(date);
  return `${MONTH_ABBR[month - 1]} ${year}`;
}

export type PeriodInfo = {
  kind: "month" | "quarter" | "year";
  start: DateString;
  end: DateString;
  financialYear: FinancialYear;
};

/**
 * Reads a period label back into dates: `'Sep 2026'`, `'Q2 2026-27'`, `'2026-27'` or `'FY 2026-27'`.
 * Returns null for anything else.
 */
export function parsePeriodLabel(label: string): PeriodInfo | null {
  const text = label.trim();
  const month = /^([A-Za-z]{3}) (\d{4})$/.exec(text);
  if (month) {
    const idx = MONTH_ABBR.findIndex((m) => m.toLowerCase() === month[1].toLowerCase());
    if (idx < 0) return null;
    const start = toDateString(Number(month[2]), idx + 1, 1);
    return { kind: "month", start, end: endOfMonth(start), financialYear: financialYearOf(start) };
  }
  const quarter = /^Q([1-4]) (\d{4}-\d{2})$/.exec(text);
  if (quarter) {
    if (!isFinancialYear(quarter[2])) return null;
    const range = quarterRange(quarter[2], Number(quarter[1]) as FyQuarter);
    return { kind: "quarter", ...range, financialYear: quarter[2] };
  }
  const year = /^(?:FY )?(\d{4}-\d{2})$/.exec(text);
  if (year && isFinancialYear(year[1])) {
    return { kind: "year", start: fyStart(year[1]), end: fyEnd(year[1]), financialYear: year[1] };
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Income-tax statute and tax-year labels (§6.1)
// -------------------------------------------------------------------------------------------------

export type IncomeTaxStatute = "1961" | "2025";

export type StatuteParams = { incomeTaxAct2025FirstYear: FinancialYear };

/**
 * Which Income-tax Act governs a financial year (§6.1): `'1961'` up to FY 2025-26, `'2025'` from
 * FY 2026-27 (the first year is a parameter; default from `FY_DEFAULTS`).
 */
export function incomeTaxStatute(fy: FinancialYear, params: StatuteParams = FY_DEFAULTS): IncomeTaxStatute {
  return startYearOf(fy) >= startYearOf(params.incomeTaxAct2025FirstYear) ? "2025" : "1961";
}

/** The assessment year of a 1961-Act financial year: the FY after it (`'2025-26' → '2026-27'`). */
export function assessmentYearOf(fy: FinancialYear): FinancialYear {
  return nextFinancialYear(fy);
}

/**
 * The label shown on screens and PDFs for an income-tax record's year (§6.1):
 * - 1961 Act: `'AY 2026-27'` for FY 2025-26 (AY = FY + 1);
 * - 2025 Act: `'Tax year 2026-27'` for FY 2026-27 (the tax year is the FY itself).
 */
export function taxYearLabel(fy: FinancialYear, params: StatuteParams = FY_DEFAULTS): string {
  return incomeTaxStatute(fy, params) === "2025" ? `Tax year ${fy}` : `AY ${assessmentYearOf(fy)}`;
}

/** `'Income-tax Act, 1961'` or `'Income-tax Act, 2025'` for an FY (§6.1). */
export function incomeTaxActName(fy: FinancialYear, params: StatuteParams = FY_DEFAULTS): string {
  return `Income-tax Act, ${incomeTaxStatute(fy, params)}`;
}

// -------------------------------------------------------------------------------------------------
// Working days (§7.11.4, §7.12)
// -------------------------------------------------------------------------------------------------

export type WorkingDayOptions = {
  /** ISO weekdays that are working days (1 = Monday), e.g. `firm_settings.working_weekdays`. */
  weekdays: readonly number[];
  /** Non-working dates: firm holidays, and the person's leave where it applies. */
  holidays?: readonly DateString[] | ReadonlySet<DateString>;
};

function holidaySet(h: WorkingDayOptions["holidays"]): ReadonlySet<DateString> {
  if (!h) return new Set();
  return h instanceof Set ? h : new Set(h as readonly DateString[]);
}

/** True when the date is one of the working weekdays and not a holiday. */
export function isWorkingDay(date: DateString, opts: WorkingDayOptions): boolean {
  return opts.weekdays.includes(isoWeekday(date)) && !holidaySet(opts.holidays).has(date);
}

/**
 * Working days from `start` to `end`, **both inclusive**; 0 when `end` is before `start`
 * (capacity uses this and says "no working days left" instead of dividing by zero, §7.6.2).
 */
export function workingDaysBetween(start: DateString, end: DateString, opts: WorkingDayOptions): number {
  const first = toEpochDay(start);
  const last = toEpochDay(end);
  if (last < first) return 0;
  const holidays = holidaySet(opts.holidays);
  const weekdays = new Set(opts.weekdays);
  let count = 0;
  for (let day = first; day <= last; day++) {
    const date = fromEpochDay(day);
    if (weekdays.has(isoWeekday(date)) && !holidays.has(date)) count++;
  }
  return count;
}

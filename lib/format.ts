/**
 * Display formatting for screens, emails and PDFs (§3.4): dates `22 Oct 2026`, times in IST, relative
 * due dates coloured by urgency, money in Indian grouping, percentages and durations.
 *
 * A missing value is an em dash (`—`), shown grey by the UI; a real zero is printed (`₹0.00`, `0`).
 *
 * Client-safe: no server-only imports. Dates are always read in IST (§0.1 rule 13), whatever the
 * browser's timezone.
 */

import {
  diffDays,
  IST_OFFSET_MINUTES,
  isDateString,
  istDateOf,
  MONTH_ABBR,
  parseDateString,
  todayIST,
  type DateString,
} from "@/lib/domain/fy";
import { formatINR, formatINRCompact, groupIndian, roundHalfUp, toPaise, type FormatINROptions } from "@/lib/domain/money";

/** What the UI prints for a missing value. */
export const EMPTY = "—";

type DateInput = DateString | Date | string | null | undefined;

function istDate(value: DateInput): DateString | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return istDateOf(value);
  } catch {
    return null;
  }
}

/**
 * `22 Oct 2026` (§3.4); the day is two digits (`01 Jul 2026`). Accepts a date string or a timestamp
 * (read in IST). Missing or unreadable → `—`.
 */
export function formatDate(value: DateInput): string {
  const date = istDate(value);
  if (!date) return EMPTY;
  const { year, month, day } = parseDateString(date);
  return `${String(day).padStart(2, "0")} ${MONTH_ABBR[month - 1]} ${year}`;
}

/** `01 Jul`: day and month only, for ranges inside one year ("from 01 Jul to 10 Jul", §7.6.2). */
export function formatDateShort(value: DateInput): string {
  const date = istDate(value);
  if (!date) return EMPTY;
  const { month, day } = parseDateString(date);
  return `${String(day).padStart(2, "0")} ${MONTH_ABBR[month - 1]}`;
}

/**
 * A date range: `01 Jul – 10 Jul 2026` in one year, `28 Mar 2026 – 05 Apr 2027` across years, a
 * single date when both ends are the same day.
 */
export function formatDateRange(start: DateInput, end: DateInput): string {
  const a = istDate(start);
  const b = istDate(end);
  if (!a || !b) return a ? formatDate(a) : b ? formatDate(b) : EMPTY;
  if (a === b) return formatDate(a);
  return a.slice(0, 4) === b.slice(0, 4) ? `${formatDateShort(a)} – ${formatDate(b)}` : `${formatDate(a)} – ${formatDate(b)}`;
}

function toInstant(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && isDateString(value)) return null; // a date has no time
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The IST wall-clock time of a timestamp: `14:05`, or `2:05 pm` with `hour12` ("Draft saved · 12:41",
 * §3.4). Missing → `—`.
 */
export function formatTime(value: Date | string | null | undefined, opts: { hour12?: boolean } = {}): string {
  const d = toInstant(value);
  if (!d) return EMPTY;
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  const h = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, "0");
  if (opts.hour12) return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "am" : "pm"}`;
  return `${String(h).padStart(2, "0")}:${m}`;
}

/** `22 Oct 2026, 14:05` in IST. A date-only value prints as a date. Missing → `—`. */
export function formatDateTime(value: Date | string | null | undefined, opts: { hour12?: boolean } = {}): string {
  if (typeof value === "string" && isDateString(value)) return formatDate(value);
  const d = toInstant(value);
  if (!d) return EMPTY;
  return `${formatDate(d)}, ${formatTime(d, opts)}`;
}

// -------------------------------------------------------------------------------------------------
// Relative time (§3.4)
// -------------------------------------------------------------------------------------------------

/** How close a due date is: overdue = danger, ≤ 3 days = warning, ≤ 7 days = info (§3.4). */
export type DueUrgency = "overdue" | "soon" | "week" | "later";

/** The tone of each urgency, matching the StatusChip tones. */
export const URGENCY_TONE: Readonly<Record<DueUrgency, "danger" | "warning" | "info" | "neutral">> = {
  overdue: "danger",
  soon: "warning",
  week: "info",
  later: "neutral",
};

export type RelativeDue = {
  /** "in 3 days", "tomorrow", "today", "1 day overdue", "2 days overdue". */
  text: string;
  urgency: DueUrgency;
  /** `due − today` in days: negative when overdue. */
  days: number;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The relative text and urgency shown beside a due date (§3.4). `today` is the IST date
 * (`todayIST()` on the server; pass it in so the result is deterministic).
 * - overdue (`due < today`) → "2 days overdue", danger;
 * - today to 3 days ahead → "today", "tomorrow", "in 3 days", warning;
 * - 4 to 7 days ahead → "in 6 days", info;
 * - later → "in 12 days", neutral.
 */
export function relativeDue(due: DateString, today: DateString): RelativeDue {
  const days = diffDays(due, today);
  let text: string;
  if (days === 0) text = "today";
  else if (days === 1) text = "tomorrow";
  else if (days > 1) text = `in ${plural(days, "day")}`;
  else text = `${plural(-days, "day")} overdue`;
  const urgency: DueUrgency = days < 0 ? "overdue" : days <= 3 ? "soon" : days <= 7 ? "week" : "later";
  return { text, urgency, days };
}

/**
 * How long ago something happened, for activity lines ("Last opened 2 hours ago by Anita", §7.25.1):
 * "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", then the date.
 * A time in the future (clock skew) reads "just now".
 */
export function formatTimeAgo(value: Date | string | null | undefined, now: Date = new Date()): string {
  const d = toInstant(value);
  if (!d) return typeof value === "string" && isDateString(value) ? formatDate(value) : EMPTY;
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = diffDays(todayIST(now), todayIST(d));
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDate(d);
}

// -------------------------------------------------------------------------------------------------
// Numbers and money
// -------------------------------------------------------------------------------------------------

type MoneyInput = number | string | null | undefined;

/** Paise from a database amount; null when missing or unreadable (display never throws). */
function paiseOrNull(rupees: MoneyInput): number | null {
  if (rupees === null || rupees === undefined || rupees === "") return null;
  try {
    return toPaise(rupees);
  } catch {
    return null;
  }
}

/**
 * An amount from the database (`numeric` arrives as a number or a string, in rupees) as
 * `₹1,23,456.00` (§3.4). Missing or unreadable → `—`. For amounts already in paise use `formatINR`.
 */
export function formatMoney(rupees: MoneyInput, opts: FormatINROptions = {}): string {
  const paise = paiseOrNull(rupees);
  return paise === null ? EMPTY : formatINR(paise, opts);
}

/**
 * A dashboard-tile amount (`₹12.3L`, §3.4) with the full value for the hover title and screen
 * readers. Missing or unreadable → both `—`.
 */
export function formatMoneyCompact(rupees: MoneyInput): { compact: string; full: string } {
  const paise = paiseOrNull(rupees);
  return paise === null ? { compact: EMPTY, full: EMPTY } : { compact: formatINRCompact(paise), full: formatINR(paise) };
}

/**
 * A count or quantity in Indian grouping (`1,23,456`; decimals kept up to `maxDecimals`, trailing
 * zeros dropped). Missing or unreadable → `—`.
 */
export function formatNumber(value: number | string | null | undefined, opts: { maxDecimals?: number } = {}): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  let rounded: number;
  try {
    rounded = roundHalfUp(value, opts.maxDecimals ?? 2);
  } catch {
    return EMPTY;
  }
  const negative = rounded < 0;
  const [int, frac] = String(Math.abs(rounded)).split(".");
  return `${negative ? "-" : ""}${groupIndian(int)}${frac ? `.${frac}` : ""}`;
}

/**
 * A percentage stored as a percent (18 → `18%`, 12.5 → `12.5%`), rounded half-up to `decimals`
 * (default 2) with trailing zeros dropped. Missing → `—`.
 */
export function formatPercent(percent: number | string | null | undefined, opts: { decimals?: number } = {}): string {
  const number = formatNumber(percent, { maxDecimals: opts.decimals ?? 2 });
  return number === EMPTY ? EMPTY : `${number}%`;
}

/** Minutes as hours and minutes: 135 → `2h 15m`, 120 → `2h`, 45 → `45m`, 0 → `0m`. Missing → `—`. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return EMPTY;
  const total = Math.round(Math.abs(minutes));
  const sign = minutes < 0 && total > 0 ? "-" : "";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

/** `FY 2026-27` for the FY switcher and headings. Missing → `—`. */
export function formatFinancialYear(fy: string | null | undefined): string {
  return fy ? `FY ${fy}` : EMPTY;
}

/**
 * A downloaded document's file name, readable and safe on every system: ("TW/26-27/0070",
 * "Invoice") → `Invoice TW-26-27-0070.pdf`. Slashes, spaces and other characters a file name can't
 * carry become hyphens in the number. The same name is used for the PDF route's download and for
 * the file that Send on WhatsApp downloads, so the client sees it in the chat as it reads here.
 */
export function pdfFileName(documentNumber: string, prefix?: string): string {
  const safe = documentNumber.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${prefix ? `${prefix} ` : ""}${safe || "document"}.pdf`;
}

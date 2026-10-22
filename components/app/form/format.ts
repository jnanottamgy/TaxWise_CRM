/**
 * Pure helpers behind MoneyInput, PercentInput and DatePicker. Client- and server-safe, unit-tested
 * in tests/unit/ui-form-format.test.ts.
 */
import { groupIndian } from "@/lib/domain/money"
import { isDateString, MONTH_ABBR, toDateString, daysInMonth } from "@/lib/domain/fy"

// -------------------------------------------------------------------------------------------------
// Money (rupees as a decimal string: the value a numeric(14,2) column and parseAmount take)
// -------------------------------------------------------------------------------------------------

/**
 * Cleans what the user typed into a money field, keeping their intent: digits, one decimal point,
 * at most `decimals` decimal digits, and (when allowed) a leading minus. Commas, spaces and ₹ go.
 *
 *   cleanMoneyTyping("₹ 1,23,456.789") → "123456.78"
 *   cleanMoneyTyping("12.")            → "12."      (still typing)
 */
export function cleanMoneyTyping(raw: string, opts: { allowNegative?: boolean; decimals?: number } = {}): string {
  const decimals = opts.decimals ?? 2
  const negative = !!opts.allowNegative && raw.trim().startsWith("-")
  let out = ""
  let seenDot = false
  let fracDigits = 0
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") {
      if (seenDot) {
        if (fracDigits >= decimals) continue
        fracDigits++
      }
      out += ch
    } else if (ch === "." && !seenDot && decimals > 0) {
      seenDot = true
      out += "."
    }
  }
  // Drop leading zeros ("00012" → "12", but keep "0" and "0.5").
  out = out.replace(/^0+(?=\d)/, "")
  if (out.startsWith(".")) out = `0${out}`
  return negative && out ? `-${out}` : out
}

/**
 * The value to store: the cleaned number without a trailing dot ("12." → "12"), or "" when empty.
 * Never formats or pads; the server's parseAmount does the rest.
 */
export function moneyValueFromTyping(raw: string, opts: { allowNegative?: boolean; decimals?: number } = {}): string {
  const cleaned = cleanMoneyTyping(raw, opts)
  if (cleaned === "" || cleaned === "-") return ""
  return cleaned.endsWith(".") ? cleaned.slice(0, -1) : cleaned
}

/**
 * How a stored value displays when the field isn't being edited: Indian grouping with two decimals.
 *
 *   formatMoneyDisplay("123456.5") → "1,23,456.50"
 *   formatMoneyDisplay("")         → ""
 */
export function formatMoneyDisplay(value: string | number | null | undefined, opts: { decimals?: number } = {}): string {
  if (value === null || value === undefined) return ""
  const s = String(value).trim().replace(/[₹,\s]/g, "")
  if (s === "" || !/^-?\d*(\.\d*)?$/.test(s) || s === "-" || s === ".") return String(value)
  const decimals = opts.decimals ?? 2
  const negative = s.startsWith("-")
  const [intRaw, fracRaw = ""] = (negative ? s.slice(1) : s).split(".")
  const int = intRaw.replace(/^0+(?=\d)/, "") || "0"
  const frac = decimals > 0 ? `.${fracRaw.padEnd(decimals, "0").slice(0, decimals)}` : ""
  return `${negative ? "-" : ""}${groupIndian(int)}${frac}`
}

// -------------------------------------------------------------------------------------------------
// Percent
// -------------------------------------------------------------------------------------------------

/** Like cleanMoneyTyping, capped at `max` (default 100) on blur by clampPercent. */
export function cleanPercentTyping(raw: string, decimals = 2): string {
  return cleanMoneyTyping(raw, { decimals })
}

/** "120" → "100", "12." → "12", "" stays "". */
export function clampPercent(value: string, max = 100, min = 0): string {
  const v = moneyValueFromTyping(value, { decimals: 4 })
  if (v === "") return ""
  const n = Number(v)
  if (!Number.isFinite(n)) return ""
  if (n > max) return String(max)
  if (n < min) return String(min)
  return v
}

// -------------------------------------------------------------------------------------------------
// Dates (date-only facts are YYYY-MM-DD strings, §0.1 rule 13)
// -------------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {}
MONTH_ABBR.forEach((m, i) => {
  MONTHS[m.toLowerCase()] = i + 1
})
Object.assign(MONTHS, {
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8,
  september: 9, sept: 9, october: 10, november: 11, december: 12,
})

function build(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null
  if (day > daysInMonth(year, month)) return null
  return toDateString(year, month, day)
}

function fullYear(y: string): number {
  const n = Number(y)
  return y.length <= 2 ? 2000 + n : n
}

/**
 * Reads a date typed the way people in an Indian office type it (day first). Returns YYYY-MM-DD or
 * null when it isn't a real date.
 *
 *   "2026-10-22", "22/10/2026", "22-10-26", "22.10.2026", "22 Oct 2026", "22-oct-2026", "22 October 26"
 */
export function parseDateInput(text: string): string | null {
  const s = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ")
  if (!s) return null
  if (isDateString(s)) return s
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2}|\d{4})$/.exec(s)
  if (m) return build(fullYear(m[3]), Number(m[2]), Number(m[1]))
  m = /^(\d{1,2})[ \-/.]?([a-z]{3,9})\.?[ \-/.]?(\d{2}|\d{4})$/.exec(s)
  if (m && MONTHS[m[2]]) return build(fullYear(m[3]), MONTHS[m[2]], Number(m[1]))
  return null
}

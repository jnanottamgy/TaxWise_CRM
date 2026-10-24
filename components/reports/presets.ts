/**
 * The period presets the reports offer (§7.16 "filters FY, date range"): the current FY to date and
 * the previous FYs in full, this and last month, this and last quarter of the FY, and the last 30
 * and 90 days. Pure and client-safe; "today" is passed in (IST).
 */

import {
  addDays,
  compareDates,
  endOfMonth,
  financialYearOf,
  fyEnd,
  fyStart,
  previousFinancialYear,
  quarterOf,
  quarterRange,
  type DateString,
  type FinancialYear,
} from "@/lib/domain/fy"
import { MONTH_ABBR } from "@/lib/domain/fy"
import type { PeriodPreset } from "@/components/reports/period-picker"

function monthName(d: DateString): string {
  const [y, m] = d.split("-").map(Number)
  return `${MONTH_ABBR[m - 1]} ${y}`
}

/** FYs, newest first: the current one to date, then `back` previous ones in full. */
export function fyPresets(today: DateString, back = 3): PeriodPreset[] {
  const out: PeriodPreset[] = []
  let fy: FinancialYear = financialYearOf(today)
  out.push({ id: `fy-${fy}`, label: `FY ${fy} to date`, from: fyStart(fy), to: today })
  for (let i = 0; i < back; i++) {
    fy = previousFinancialYear(fy)
    out.push({ id: `fy-${fy}`, label: `FY ${fy}`, from: fyStart(fy), to: fyEnd(fy) })
  }
  return out
}

/** Whole FYs, newest first, for a report kept per FY (the current one and `back` before it). */
export function yearPresets(today: DateString, back = 4): PeriodPreset[] {
  const out: PeriodPreset[] = []
  let fy: FinancialYear = financialYearOf(today)
  for (let i = 0; i <= back; i++) {
    out.push({ id: `fy-${fy}`, label: `FY ${fy}`, from: fyStart(fy), to: fyEnd(fy) })
    fy = previousFinancialYear(fy)
  }
  return out
}

/** The full set for a report over any period. */
export function reportPeriodPresets(today: DateString): PeriodPreset[] {
  const monthStart = `${today.slice(0, 8)}01`
  const lastMonthEnd = addDays(monthStart, -1)
  const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`
  const fy = financialYearOf(today)
  const q = quarterOf(today)
  const thisQuarter = quarterRange(fy, q)
  const lastQuarter = q === 1 ? quarterRange(previousFinancialYear(fy), 4) : quarterRange(fy, (q - 1) as 1 | 2 | 3)
  const presets: PeriodPreset[] = [
    ...fyPresets(today, 2),
    { id: "this-month", label: `This month (${monthName(today)})`, from: monthStart, to: today },
    { id: "last-month", label: `Last month (${monthName(lastMonthStart)})`, from: lastMonthStart, to: endOfMonth(lastMonthStart) },
    { id: "this-quarter", label: `This quarter (Q${q} ${fy})`, from: thisQuarter.start, to: compareDates(thisQuarter.end, today) > 0 ? today : thisQuarter.end },
    { id: "last-quarter", label: `Last quarter (Q${q === 1 ? 4 : q - 1} ${q === 1 ? previousFinancialYear(fy) : fy})`, from: lastQuarter.start, to: lastQuarter.end },
    { id: "last-30", label: "Last 30 days", from: addDays(today, -29), to: today },
    { id: "last-90", label: "Last 90 days", from: addDays(today, -89), to: today },
  ]
  return presets
}

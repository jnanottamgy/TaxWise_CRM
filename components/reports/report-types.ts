/**
 * The shape every report returns (§7.16), shared by the page, the Excel workbook and the PDF so all
 * three show the same figures. Serialisable (a Server Component hands it to client charts). Money is
 * integer paise; hours are minutes; days carry one decimal; percentages are numbers (12.5 = 12.5%)
 * or null when there is nothing to measure against. Pure and client-safe.
 */

import type { StatusTone } from "@/lib/status"
import { formatINR, formatINRCompact } from "@/lib/domain/money"
import { EMPTY, formatDate, formatNumber } from "@/lib/format"

export type ReportCellKind = "text" | "count" | "money" | "percent" | "days" | "date" | "hours" | "status" | "link"

export type ReportStatusCell = { label: string; tone: StatusTone; meaning?: string }
export type ReportLinkCell = { text: string; href: string; sub?: string | null }
export type ReportCell = string | number | null | ReportStatusCell | ReportLinkCell

export type ReportColumn = {
  key: string
  header: string
  kind: ReportCellKind
  /** Hide below this width on screen (the exports keep every column). */
  hideBelow?: "lg" | "xl" | "2xl"
  /** Keep a short text value (a person's name) on one line instead of wrapping it word by word. */
  nowrap?: boolean
  /** Its place in the phone card: line 1 left (identity) or right (the key figure), or line 2. */
  mobile?: "primary" | "trailing" | "secondary"
}

export type ReportRow = Record<string, ReportCell>

export type ReportChart = {
  /** Columns per period: the x column (text) and the y column (a count or paise). */
  x: string
  y: string
  label: string
  xLabel: string
  format: "number" | "money"
  /** One sentence for screen readers. */
  summary?: string
}

export type ReportSection = {
  id: string
  title: string
  /** One grey line about the data (its scope, its rule). */
  description?: string
  columns: ReportColumn[]
  rows: ReportRow[]
  totals?: ReportRow | null
  /** The sentence in the frame when there are no rows. */
  empty: string
  /** For a capped list: how many there are in all, and where the whole list lives. */
  total?: number
  more?: { label: string; href: string } | null
  /** The one server-paged list of a report (`?page&size`). */
  pager?: { page: number; pageSize: number; total: number } | null
  chart?: ReportChart | null
  /** Sits beside the next half-width section on a wide screen. */
  half?: boolean
}

export type ReportKpi = {
  label: string
  kind: ReportCellKind
  value: number | string | null
  sub?: string | null
  href?: string | null
}

export type ReportResult = {
  slug: string
  title: string
  counts: string
  period: { from: string; to: string; label: string }
  /** The filters in force, in words ("Client: Sharma Traders"). */
  scope: string[]
  kpis: ReportKpi[]
  sections: ReportSection[]
  generatedAt: string
}

export function isStatusCell(v: ReportCell | undefined): v is ReportStatusCell {
  return !!v && typeof v === "object" && "tone" in v && "label" in v
}

export function isLinkCell(v: ReportCell | undefined): v is ReportLinkCell {
  return !!v && typeof v === "object" && "href" in v && "text" in v
}

/** Minutes as hours with one decimal: 135 → "2.3 h"; 0 → "0 h". */
export function formatHours(minutes: number): string {
  return `${formatNumber(Math.round((minutes / 60) * 10) / 10, { maxDecimals: 1 })} h`
}

/** One cell as text (the PDF, the phone card's second line, CSV-like contexts). Missing → em dash. */
export function reportCellText(kind: ReportCellKind, value: ReportCell | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return EMPTY
  if (isStatusCell(value)) return value.label
  if (isLinkCell(value)) return value.text
  switch (kind) {
    case "money":
      return typeof value === "number" ? (opts.compact ? formatINRCompact(value) : formatINR(value)) : String(value)
    case "count":
      return typeof value === "number" ? formatNumber(value) : String(value)
    case "percent":
      return typeof value === "number" ? `${formatNumber(value, { maxDecimals: 1 })}%` : String(value)
    case "days":
      return typeof value === "number" ? `${formatNumber(value, { maxDecimals: 1 })} ${value === 1 ? "day" : "days"}` : String(value)
    case "hours":
      return typeof value === "number" ? formatHours(value) : String(value)
    case "date":
      return formatDate(String(value))
    default:
      return String(value)
  }
}

/** Right-aligned, tabular kinds (DESIGN.md §3: numbers right-aligned). */
export function isNumericKind(kind: ReportCellKind): boolean {
  return kind === "count" || kind === "money" || kind === "percent" || kind === "days" || kind === "hours" || kind === "date"
}

import { cn } from "@/lib/utils"
import { EMPTY, formatMoney, formatMoneyCompact } from "@/lib/format"
import { FullValueHint } from "@/components/app/full-value-hint"

/**
 * An amount in rupees as the database returns it (`numeric(14,2)` arrives as a number or a string):
 * `₹1,23,456.00`, tabular figures, no wrapping (§3.4). Server-safe.
 *
 *   <Money value={invoice.total} />                 → ₹1,23,456.00
 *   <Money value={kpi.outstanding} compact />       → ₹12.3L (full value on hover, focus and for screen readers)
 *   <Money value={null} />                          → grey —
 *   <Money value={-500} />                          → -₹500.00
 *
 * Right-align it in tables with the column's `align: "right"`; pass `block` to right-align it alone.
 * Use `compact` only on dashboard figures (§3.4).
 */
export function Money({
  value,
  compact = false,
  block = false,
  className,
}: {
  value: number | string | null | undefined
  compact?: boolean
  /** Render as a right-aligned block (for use outside a right-aligned table cell). */
  block?: boolean
  className?: string
}) {
  const base = cn("num whitespace-nowrap tabular-nums", block && "block text-right", className)
  if (value === null || value === undefined || value === "") {
    return (
      <span className={cn(base, "text-text-muted")} aria-label="No amount">
        {EMPTY}
      </span>
    )
  }

  let full: string
  let short: string
  try {
    if (compact) {
      const c = formatMoneyCompact(value)
      full = c.full
      short = c.compact
    } else {
      full = formatMoney(value)
      short = full
    }
  } catch {
    // A value that isn't an amount must not break the page: show it as missing.
    return (
      <span className={cn(base, "text-text-muted")} aria-label="Amount unavailable">
        {EMPTY}
      </span>
    )
  }

  if (compact && short !== full) {
    return <FullValueHint short={short} full={full} className={base} />
  }
  return <span className={base}>{full}</span>
}

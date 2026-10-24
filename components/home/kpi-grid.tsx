import Link from "next/link"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatINR, formatINRCompact, type Paise } from "@/lib/domain/money"

/**
 * KPIs as type in one divided container (DESIGN.md §3, taste app-screens §5) for the home pages: a
 * grid of 1px hairlines with a label (13, grey) above each value (24, tabular) and one grey line
 * under it; no icons, no tiles, no sparklines. The first cell can lead (30px): the screen's answer.
 *
 * Unlike the kit's KpiStrip (one row of up to six), it lays nine figures out as a 3 × 3 block beside
 * Approvals on Firm today, and two columns on phones with the lead across both. Each figure links to
 * the filtered list behind it (§7.2), and a compact amount shows its full value on hover and focus:
 * the link itself is the tooltip's trigger, so there is no focusable element inside a link, and
 * screen readers get the full amount in the link's text.
 *
 *   <KpiGrid lead cols={3} items={[{ label: "Overdue receivables", value: money(overdue), sub: "12 invoices", href: "/invoices?status=overdue", tone: "danger" }]} />
 */

export type KpiFigure = {
  label: string
  /** The figure as shown: a count, or `money(paise)` for a compact amount. */
  value: string | MoneyFigure
  sub?: React.ReactNode
  href?: string
  /** Colour on the figure for a status that needs acting on (an overdue amount above zero). */
  tone?: "danger" | "warning"
}

export type MoneyFigure = { short: string; full: string }

/** ₹12.3L with ₹12,34,567.00 for the hover and for screen readers (§3.4). */
export function money(p: Paise): MoneyFigure {
  return { short: formatINRCompact(p), full: formatINR(p) }
}

/** A whole number with Indian grouping. */
export function figure(n: number): string {
  return n.toLocaleString("en-IN")
}

const COLS: Record<2 | 3 | 4, string> = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" }

export function KpiGrid({
  items,
  cols = 3,
  lead = false,
  className,
  "aria-label": ariaLabel,
}: {
  items: KpiFigure[]
  cols?: 2 | 3 | 4
  lead?: boolean
  className?: string
  "aria-label"?: string
}) {
  // Phones: two columns. With a lead across both, the rest must pair up; an odd one out spans too.
  const restOdd = (items.length - (lead ? 1 : 0)) % 2 === 1
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="kpi-grid"
      className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border", COLS[cols], className)}
    >
      {items.map((item, i) => {
        const big = lead && i === 0
        const span = (big && "max-md:col-span-2") || (restOdd && i === items.length - 1 && "max-md:col-span-2")
        return <Cell key={`${item.label}-${i}`} item={item} big={big} className={cn(span || undefined)} />
      })}
    </div>
  )
}

function Cell({ item, big, className }: { item: KpiFigure; big: boolean; className?: string }) {
  const isMoney = typeof item.value !== "string"
  const shown = typeof item.value === "string" ? item.value : item.value.short
  const full = typeof item.value === "string" ? null : item.value.full
  const body = (
    <>
      <div className="text-sm leading-5 text-text-muted">{item.label}</div>
      <div
        className={cn(
          "num mt-1 font-semibold tracking-[-0.01em] whitespace-nowrap tabular-nums",
          big ? "text-2xl leading-9" : "text-xl leading-8",
          item.tone === "danger" ? "text-danger-text" : item.tone === "warning" ? "text-warning-text" : "text-text",
        )}
      >
        {full && full !== shown ? (
          <>
            <span aria-hidden="true">{shown}</span>
            <span className="sr-only">{full}</span>
          </>
        ) : (
          shown
        )}
      </div>
      {item.sub ? <div className="mt-0.5 text-sm leading-5 text-text-muted">{item.sub}</div> : null}
    </>
  )
  const cell = cn("block min-w-0 bg-surface px-4 py-3 md:px-5", className)
  const link = item.href ? (
    <Link
      href={item.href}
      className={cn(
        cell,
        "transition-colors duration-150 hover:bg-surface-2/60 focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      )}
    >
      {body}
    </Link>
  ) : null
  if (isMoney && full && full !== shown) {
    const trigger = link ?? (
      <div tabIndex={0} className={cn(cell, "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring")}>
        {body}
      </div>
    )
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent className="num">{full}</TooltipContent>
      </Tooltip>
    )
  }
  return link ?? <div className={cell}>{body}</div>
}

/**
 * A compact amount inside a linked figure or row (₹12.3L): the full value as the hover title and in
 * the accessible text, with nothing focusable of its own (the surrounding link takes the focus).
 */
export function MoneyText({ paise, className }: { paise: Paise; className?: string }) {
  const m = money(paise)
  if (m.short === m.full) return <span className={cn("num whitespace-nowrap tabular-nums", className)}>{m.full}</span>
  return (
    <span title={m.full} className={cn("num whitespace-nowrap tabular-nums", className)}>
      <span aria-hidden="true">{m.short}</span>
      <span className="sr-only">{m.full}</span>
    </span>
  )
}

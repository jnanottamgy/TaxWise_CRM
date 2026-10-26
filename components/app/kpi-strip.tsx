import Link from "next/link"
import { cn } from "@/lib/utils"
import { WithinInteractive } from "@/components/app/full-value-hint"

export interface KpiItem {
  label: string
  /** The figure: a number, <Money compact />, "12 /40". */
  value: React.ReactNode
  /** One grey line: a delta in words with its baseline, a count, a date. */
  sub?: React.ReactNode
  /** Every tile links to the filtered list behind it (§7.2). */
  href?: string
}

/**
 * KPIs as type (DESIGN.md §3): one bordered container split by 1px dividers into equal columns; label
 * (13, grey) above the value (24, tabular); no icons, no sparklines. Two columns on phones (an odd
 * last item spans both). `lead` makes the first value the screen's answer (30px). Server-safe.
 *
 *   <KpiStrip
 *     items={[
 *       { label: "Outstanding", value: <Money value={1234567} compact />, sub: "42 invoices", href: "/invoices?status=sent,partially_paid" },
 *       { label: "Overdue", value: <Money value={345600} compact />, sub: <Delta change={-2} goodDirection="down" baseline="vs last week" format={(n) => `${n} invoices`} /> },
 *       { label: "Data awaited", value: 17, href: "/work?status=data_awaited" },
 *     ]}
 *   />
 */
export function KpiStrip({
  items,
  lead = false,
  className,
  "aria-label": ariaLabel,
}: {
  items: KpiItem[]
  lead?: boolean
  className?: string
  "aria-label"?: string
}) {
  const cols = Math.min(Math.max(items.length, 1), 6)
  const mdCols =
    cols === 1 ? "md:grid-cols-1" : cols === 2 ? "md:grid-cols-2" : cols === 3 ? "md:grid-cols-3" : cols === 4 ? "md:grid-cols-4" : cols === 5 ? "md:grid-cols-5" : "md:grid-cols-6"
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="kpi-strip"
      className={cn("grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface", mdCols, className)}
    >
      {items.map((item, i) => {
        const big = lead && i === 0
        const inner = (
          <>
            <div className="text-sm leading-5 text-text-muted">{item.label}</div>
            <div
              className={cn(
                // Money and counts set in the serif, like an engraved statement (DESIGN.md §2).
                "num mt-1.5 font-serif font-[450] tracking-[-0.012em] text-text tabular-nums",
                big ? "text-[40px] leading-[44px]" : "text-[30px] leading-9"
              )}
            >
              {item.value}
            </div>
            {item.sub ? <div className="mt-0.5 text-sm leading-5 text-text-muted">{item.sub}</div> : null}
          </>
        )
        const cell = cn(
          "min-w-0 px-4 py-3 md:px-5 md:py-4",
          "max-md:[&:nth-child(even)]:border-l max-md:[&:nth-child(n+3)]:border-t max-md:[&:last-child:nth-child(odd)]:col-span-2",
          "border-border md:border-l md:first:border-l-0"
        )
        return item.href ? (
          <Link
            key={`${item.label}-${i}`}
            href={item.href}
            className={cn(
              cell,
              "block transition-colors duration-150 hover:bg-surface-2/60 focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            )}
          >
            <WithinInteractive>{inner}</WithinInteractive>
          </Link>
        ) : (
          <div key={`${item.label}-${i}`} className={cell}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A change in words with its baseline (DESIGN.md §3): colour says good or bad, not up or down; zero
 * is grey. `goodDirection="down"` for things that should fall (overdue count, days to collect).
 *
 *   <Delta change={4} goodDirection="up" baseline="vs last month" />          → "+4 vs last month" (green)
 *   <Delta change={0} baseline="vs last month" />                             → "No change vs last month" (grey)
 *   <Delta change={3} previous={0} baseline="vs last month" />                → "+3 (new) vs last month" (grey)
 */
export function Delta({
  change,
  previous,
  goodDirection = "up",
  baseline,
  format = (n: number) => n.toLocaleString("en-IN"),
  className,
}: {
  change: number | null | undefined
  /** The baseline figure; when it was zero the change is shown as "(new)" without colour. */
  previous?: number | null
  goodDirection?: "up" | "down"
  baseline: string
  format?: (absChange: number) => string
  className?: string
}) {
  if (change === null || change === undefined || !Number.isFinite(change)) {
    return <span className={cn("text-text-muted", className)}>— {baseline}</span>
  }
  if (change === 0) return <span className={cn("text-text-muted", className)}>No change {baseline}</span>
  const sign = change > 0 ? "+" : "-"
  const text = `${sign}${format(Math.abs(change))}`
  if (previous === 0) {
    return (
      <span className={cn("text-text-muted", className)}>
        <span className="num">{text}</span> (new) {baseline}
      </span>
    )
  }
  const good = goodDirection === "up" ? change > 0 : change < 0
  return (
    <span className={cn("text-text-muted", className)}>
      <span className={cn("num font-medium", good ? "text-success-text" : "text-danger-text")}>{text}</span> {baseline}
    </span>
  )
}

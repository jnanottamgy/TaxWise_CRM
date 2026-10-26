"use client"

import * as React from "react"
import { ChartColumnIcon, TableIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ChartTable {
  columns: Array<{ label: string; align?: "left" | "right" }>
  rows: Array<Array<React.ReactNode>>
}

/**
 * The frame every chart sits in (DESIGN.md §3 charts, §13 accessibility): the card header (16/600
 * title, one grey line, an optional right slot and legend), the plot, and a "View as table" toggle
 * that swaps the plot for the same numbers as a table.
 *
 *   <ChartFrame title="Collections" description="FY 2026-27, by month" table={table} legend={<Legend … />}>
 *     <BarChart …/>
 *   </ChartFrame>
 *
 * Prefer the ready cards (LineChartCard, BarChartCard, StackedBarCard), which build the table for you.
 */
export function ChartFrame({
  title,
  description,
  action,
  legend,
  table,
  summary,
  empty,
  className,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  legend?: React.ReactNode
  table: ChartTable
  /** One sentence for screen readers describing what the chart shows. */
  summary?: string
  /** Rendered instead of the chart and table when there is nothing to plot. */
  empty?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const [asTable, setAsTable] = React.useState(false)
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-surface", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4 pb-2 md:px-5">
        <div className="min-w-0">
          <h2 id={headingId} className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-sm text-text-muted">{description}</p> : null}
        </div>
        <div className="flex flex-none items-center gap-2">
          {action}
          {empty ? null : (
            <button
              type="button"
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
            >
              {asTable ? <ChartColumnIcon aria-hidden="true" className="size-4" /> : <TableIcon aria-hidden="true" className="size-4" />}
              {asTable ? "View as chart" : "View as table"}
            </button>
          )}
        </div>
      </div>
      {legend && !asTable && !empty ? <div className="px-4 pb-1 md:px-5">{legend}</div> : null}
      <div className="min-w-0 px-2 pb-3 md:px-3">
        {empty ? (
          <div className="px-2 pb-1 md:px-2">{empty}</div>
        ) : asTable ? (
          <div className="max-h-80 overflow-auto px-2">
            <table className="w-full border-separate border-spacing-0 text-base">
              <caption className="sr-only">{typeof title === "string" ? `${title}, as a table` : "Chart data"}</caption>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th
                      key={c.label}
                      scope="col"
                      className={cn(
                        "sticky top-0 h-9 bg-surface-2 px-3 text-xs font-medium text-text-muted shadow-[inset_0_-1px_0_var(--border)]",
                        c.align === "right" ? "text-right" : "text-left"
                      )}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i} className="h-9">
                    {r.map((cell, j) => (
                      <td
                        key={j}
                        className={cn(
                          "border-b border-border/70 px-3",
                          table.columns[j]?.align === "right" ? "num text-right tabular-nums" : "text-left"
                        )}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <figure role="img" aria-label={summary ?? (typeof title === "string" ? title : "Chart")} className="m-0">
            {children}
          </figure>
        )}
      </div>
    </section>
  )
}

/** A legend as dots with grey labels, for the card header (only for two or more series). */
export function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full" style={{ background: it.color }} />
          {it.label}
        </li>
      ))}
    </ul>
  )
}

/** The plain tooltip (DESIGN.md: bare box, label and value on one line, no arrow). */
export function ChartTooltipBox({
  label,
  rows,
}: {
  label: React.ReactNode
  rows: Array<{ name: string; value: string; color?: string }>
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-text shadow-2">
      <div className="text-xs text-text-muted">{label}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2 whitespace-nowrap">
          {r.color ? <span aria-hidden="true" className="size-2 rounded-full" style={{ background: r.color }} /> : null}
          {rows.length > 1 ? <span className="text-text-muted">{r.name}</span> : null}
          <span className="num font-medium tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

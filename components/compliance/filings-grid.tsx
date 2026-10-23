"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TablePagination } from "@/components/app/data-table/pagination"
import { useTableNavigationPending, useTableUrlState } from "@/hooks/use-table-url-state"
import { formatDate } from "@/lib/format"
import { filingBarStatus } from "@/lib/domain/statutory-calendar"
import { compareDates, type DateString } from "@/lib/domain/fy"
import type { GridLayout } from "@/lib/schemas/compliance"
import type { GridClient, GridEvent } from "@/lib/data/compliance"
import { layoutRow, type ColumnCount, type GridColumn } from "@/components/compliance/logic/grid"
import { eventDisplayStatus, isDone } from "@/components/compliance/logic/event"
import { withEvent, withParams } from "@/components/compliance/logic/urls"
import { StatusMark, displayLabel } from "@/components/compliance/status-mark"

/**
 * The filings grid (§7.7, the product's signature): rows = clients, columns = periods, each cell a
 * status mark (Not started · Docs awaited · In progress · Under review · Filed · Overdue). A
 * quarterly QRMP return spans its three months. Column headers carry "filed of total" across every
 * client (not just the page) and pick the period the summary above answers for. A cell opens its
 * deadline (or lists them, when it holds several). The frame scrolls sideways inside itself with
 * the client column fixed (DESIGN.md §7); the page never does.
 */

export interface FilingBarInfo {
  rules: string[]
  years: number
  warnMonths: number
  fromPeriod: DateString
}

export function FilingsGrid({
  layout,
  fy,
  columns,
  counts,
  focus,
  clients,
  events,
  today,
  filingBar,
  total,
  page,
  pageSize,
  returnLabel,
}: {
  layout: GridLayout
  fy: string
  columns: GridColumn[]
  counts: ColumnCount[]
  focus: number
  clients: GridClient[]
  events: GridEvent[]
  today: DateString
  filingBar: FilingBarInfo
  total: number
  page: number
  pageSize: number
  returnLabel: string
}) {
  const pathname = usePathname()
  const sp = useSearchParams()
  const url = useTableUrlState({})
  const pending = useTableNavigationPending()
  const barRules = React.useMemo(() => new Set(filingBar.rules), [filingBar.rules])

  const byClient = React.useMemo(() => {
    const m = new Map<string, GridEvent[]>()
    for (const e of events) {
      const list = m.get(e.client_id) ?? []
      list.push(e)
      m.set(e.client_id, list)
    }
    return m
  }, [events])

  const nearBar = (e: GridEvent) => {
    if (isDone(e) || !e.rule_code || !barRules.has(e.rule_code)) return false
    if (e.period_end && compareDates(e.period_end, filingBar.fromPeriod) < 0) return false
    const s = filingBarStatus(e.original_due_date ?? e.due_date, today, { params: filingBar })
    return s.nearBar || s.barred
  }

  const narrow = layout === "month"

  // On a narrow screen the chosen period may be off to the right: bring it into view, past the
  // sticky client column.
  const frame = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = frame.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    const th = el.querySelector<HTMLElement>('thead th[aria-current="true"]')
    const sticky = el.querySelector<HTMLElement>("thead th")
    if (!th || !sticky) return
    const left = th.offsetLeft - sticky.offsetWidth - 8
    if (left > el.scrollLeft && th.offsetLeft + th.offsetWidth <= el.scrollLeft + el.clientWidth) return
    el.scrollLeft = Math.max(0, left)
  }, [focus, layout, fy])

  return (
    <div className={cn("rounded-lg border border-border bg-surface", pending && "opacity-70 transition-opacity")}>
      <div ref={frame} className="max-h-[calc(100dvh-16rem)] min-h-48 overflow-auto [scrollbar-width:thin]">
        <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            {returnLabel} for FY {fy}: clients against periods
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky top-0 left-0 z-30 w-40 min-w-40 border-b border-border bg-surface-2 px-3 py-2 text-left text-xs font-normal text-text-muted md:w-52 md:min-w-52 md:px-4"
              >
                Client
              </th>
              {columns.map((c, i) => {
                const n = counts[i]
                const on = i === focus
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-current={on ? "true" : undefined}
                    className={cn(
                      "sticky top-0 z-20 border-b border-border bg-surface-2 p-0 text-xs font-normal",
                      narrow ? "w-[4.25rem] min-w-[4.25rem]" : "w-32 min-w-32",
                      on && "shadow-[inset_0_2px_0_var(--primary)]"
                    )}
                  >
                    <Link
                      href={withParams(pathname, sp, { period: c.key })}
                      scroll={false}
                      aria-label={`${c.name}: ${n.done} of ${n.total} filed${n.overdue ? `, ${n.overdue} overdue` : ""}. Show this period's summary.`}
                      className="flex h-full flex-col items-center px-1.5 py-1.5 text-center outline-none hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className={cn("leading-4", on ? "font-semibold text-text" : "text-text")}>{c.label}</span>
                      <span className="leading-4 text-text-muted">{c.sub ?? " "}</span>
                      <span className="num leading-4 text-text-muted tabular-nums">
                        {n.total ? (
                          <>
                            {n.done}/{n.total}
                            {n.overdue ? <span className="text-danger-text"> · {n.overdue}</span> : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    </Link>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const cells = layoutRow(layout, fy, columns, byClient.get(c.id) ?? [], today)
              return (
                <tr key={c.id} className="group">
                  <th scope="row" className="sticky left-0 z-10 border-b border-border bg-surface px-3 py-1.5 text-left font-normal group-hover:bg-surface-2 md:px-4">
                    <Link href={`/clients/${c.id}?tab=compliance`} className="block min-w-0 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      <span className="block truncate text-sm font-medium text-text">{c.display_name}</span>
                      <span className="block truncate text-xs text-text-muted">
                        {c.client_code}
                        {c.owner_name ? ` · ${c.owner_name}` : " · No owner"}
                      </span>
                    </Link>
                  </th>
                  {cells.map((cell) => {
                    const col = columns[cell.start]
                    const onFocus = cell.start <= focus && focus < cell.start + (cell.kind === "events" ? cell.span : 1)
                    if (cell.kind === "empty") {
                      return (
                        <td key={`e-${cell.start}`} className={cn("border-b border-border px-1 py-1.5 text-center text-text-muted", onFocus && "bg-surface-2/70")}>
                          <span aria-label={`${c.display_name} · ${col.name}: no return due`}>—</span>
                        </td>
                      )
                    }
                    const spanName = cell.span > 1 ? `${col.name} to ${columns[cell.start + cell.span - 1].name}` : col.name
                    const flagged = cell.events.some(nearBar)
                    const first = cell.events[0]
                    const label = `${c.display_name} · ${spanName}: ${displayLabel(cell.display)}${cell.total > 1 ? `, ${cell.done} of ${cell.total} filed` : ""}, due ${formatDate(first.due_date)}${flagged ? ". Near the three-year filing limit" : ""}`
                    const mark = <StatusMark display={cell.display} showLabel={!narrow || cell.span > 1} count={{ done: cell.done, total: cell.total }} flagged={flagged} />
                    return (
                      <td key={`c-${cell.start}`} colSpan={cell.span} className={cn("border-b border-border px-1 py-1.5", onFocus && "bg-surface-2/70")}>
                        {cell.events.length === 1 ? (
                          <Link
                            href={withEvent(pathname, sp, first.id)}
                            scroll={false}
                            aria-label={label}
                            title={label}
                            className="block rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                          >
                            {mark}
                          </Link>
                        ) : (
                          <CellEvents label={label} events={cell.events} today={today}>
                            {mark}
                          </CellEvents>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <TablePagination page={page} pageSize={pageSize} total={total} onPage={url.setPage} onPageSize={url.setPageSize} disabled={pending} />
    </div>
  )
}

function CellEvents({ label, events, today, children }: { label: string; events: GridEvent[]; today: DateString; children: React.ReactNode }) {
  const pathname = usePathname()
  const sp = useSearchParams()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} title={label} className="block w-full rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="bottom" className="w-72 p-1.5">
        <ul className="flex flex-col">
          {events.map((e) => (
            <li key={e.id}>
              <Link href={withEvent(pathname, sp, e.id)} scroll={false} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring">
                <span className="min-w-0">
                  <span className="block truncate text-text">{e.title}</span>
                  <span className="block text-xs text-text-muted">Due {formatDate(e.due_date)}</span>
                </span>
                <span className="w-24 flex-none">
                  <StatusMark display={eventDisplayStatus(e, today)} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

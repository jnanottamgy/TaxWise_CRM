import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/lib/format"
import { getStatus } from "@/lib/status"
import { parseDateString } from "@/lib/domain/fy"
import { toneClasses } from "@/components/app/tones"
import type { TaskListRow } from "@/lib/data/tasks"
import { monthGrid, monthParam, monthTitle } from "@/lib/schemas/tasks"

/**
 * The calendar (§7.6.1 "by due date"): the month in Monday–Sunday weeks, each day listing its
 * tasks with a status dot (and the status in words for screen readers and on hover). Days with
 * more than three tasks fold the rest under "N more". Phones get the same month as an agenda.
 * Server-safe; the filters above apply.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const VISIBLE = 3

function TaskLine({ row }: { row: TaskListRow }) {
  const info = getStatus("task_status", row.status)
  const tone = toneClasses(info.tone)
  return (
    <Link
      href={`/work/${row.id}`}
      title={`${row.title} · ${row.client_name ?? ""} · ${info.label}`}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs leading-4 text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
        row.status === "filed_done" && "text-text-muted line-through decoration-text-muted/50",
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 flex-none rounded-full", tone.dot)} />
      <span className="sr-only">{info.label}: </span>
      <span className="truncate">{row.title}</span>
    </Link>
  )
}

export function TaskCalendar({
  month,
  rows,
  today,
  hrefFor,
  undated,
  truncated,
}: {
  month: string
  rows: TaskListRow[]
  today: string
  /** Builds the link to another month, keeping the filters. */
  hrefFor: (month: string) => string
  undated: number
  truncated: boolean
}) {
  const weeks = monthGrid(month)
  const byDay = new Map<string, TaskListRow[]>()
  for (const r of rows) if (r.due_date) byDay.set(r.due_date, [...(byDay.get(r.due_date) ?? []), r])
  const { month: m } = parseDateString(month)
  const daysWithTasks = weeks.flat().filter((d) => parseDateString(d).month === m && byDay.has(d))

  return (
    <section aria-label={`Tasks due in ${monthTitle(month)}`} className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-4">
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="icon-sm">
            <Link href={hrefFor(monthParam(month, -1))} aria-label="Previous month" scroll={false}>
              <ChevronLeftIcon aria-hidden="true" />
            </Link>
          </Button>
          <h2 className="min-w-36 text-center font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">{monthTitle(month)}</h2>
          <Button asChild variant="ghost" size="icon-sm">
            <Link href={hrefFor(monthParam(month, 1))} aria-label="Next month" scroll={false}>
              <ChevronRightIcon aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="ml-1">
            <Link href={hrefFor(today.slice(0, 7))} scroll={false}>
              Today
            </Link>
          </Button>
        </div>
        <p className="text-sm text-text-muted">
          <span className="num tabular-nums">{rows.length}</span> due this month
          {undated ? (
            <>
              {" · "}
              <Link href="/work?due=no_date" className="text-text underline-offset-4 hover:underline">
                {undated} open with no due date
              </Link>
            </>
          ) : null}
          {truncated ? " · showing the first 800; narrow the filters" : ""}
        </p>
      </div>

      {/* Desktop and tablet: the month grid. */}
      <div className="hidden md:block">
        <div className="grid grid-cols-7 border-b border-border bg-surface-2">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-1.5 text-xs font-medium text-text-muted">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="grid grid-cols-7 border-b border-border last:border-b-0">
            {week.map((d) => {
              const inMonth = parseDateString(d).month === m
              const list = byDay.get(d) ?? []
              const isToday = d === today
              return (
                <div key={d} className={cn("min-h-28 border-l border-border p-1.5 first:border-l-0", !inMonth && "bg-surface-2/50")}>
                  <div className="mb-1 flex items-center justify-between px-1">
                    <span
                      className={cn("num text-xs tabular-nums", isToday ? "inline-flex size-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground" : inMonth ? "text-text" : "text-text-muted")}
                      aria-label={isToday ? `Today, ${formatDate(d)}` : formatDate(d)}
                    >
                      {parseDateString(d).day}
                    </span>
                    {list.length > VISIBLE ? <span className="num text-xs text-text-muted tabular-nums">{list.length}</span> : null}
                  </div>
                  <div className="flex flex-col">
                    {list.slice(0, VISIBLE).map((r) => (
                      <TaskLine key={r.id} row={r} />
                    ))}
                    {list.length > VISIBLE ? (
                      <details className="group/more">
                        <summary className="cursor-pointer list-none rounded-sm px-1 py-0.5 text-xs font-medium text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                          {list.length - VISIBLE} more
                        </summary>
                        {list.slice(VISIBLE).map((r) => (
                          <TaskLine key={r.id} row={r} />
                        ))}
                      </details>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Phones: the month as an agenda. */}
      <ol className="divide-y divide-border md:hidden">
        {daysWithTasks.length === 0 ? <li className="px-4 py-8 text-center text-base text-text-muted">Nothing is due this month for these filters.</li> : null}
        {daysWithTasks.map((d) => (
          <li key={d} className="px-4 py-3">
            <h3 className={cn("mb-1.5 text-sm font-medium", d === today ? "text-primary" : "text-text")}>
              {formatDate(d)}
              {d === today ? " · today" : ""}
            </h3>
            <div className="flex flex-col gap-0.5">
              {(byDay.get(d) ?? []).map((r) => (
                <TaskLine key={r.id} row={r} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

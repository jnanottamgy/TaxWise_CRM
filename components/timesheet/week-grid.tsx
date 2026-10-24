"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CopyIcon, LockIcon, PlusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState } from "@/components/app/empty-state"
import { formatMinutes } from "@/lib/format"
import { diffDays, type DateString } from "@/lib/domain/fy"
import { dayHeading, formatDurationInput, parseDuration, MAX_ENTRY_MINUTES, NOT_ON_LIST, type GridRow } from "@/lib/schemas/timesheet"
import type { RowLabel, WeekView } from "@/lib/data/timesheet"
import { copyLastWeekRows, removeGridRow, setGridCell } from "@/server/actions/timesheet"
import { AddRowDialog } from "@/components/timesheet/add-row-dialog"

/**
 * My timesheet's week grid (§7.10 "a week grid (days × tasks), daily and weekly totals vs target,
 * copy last week's rows"). One row per client, task and billable flag; type a day's time straight
 * into its cell (1:30, 1h 30m, 90m or 1.5) and it is saved when you leave the cell. A cell made of
 * timer or start-and-end entries, or of several entries, is changed in the entries list below; a
 * billed entry or an approved week is locked. On phones the grid becomes one day at a time.
 */

type CellPos = { rowKey: string; index: number }

function rowName(label: RowLabel | undefined, row: GridRow): { title: string; sub: string | null; href: string | null } {
  // No name means RLS no longer shows the viewer that task or client (they left its team, a cover
  // ended): say so plainly, and don't link to a page that would refuse them.
  if (row.task_id) {
    if (!label?.task_title) return { title: NOT_ON_LIST.task, sub: null, href: null }
    return {
      title: label.task_title,
      sub: [label.task_number, label.client_name].filter(Boolean).join(" · ") || null,
      href: `/work/${row.task_id}`,
    }
  }
  if (row.client_id) return label?.client_name ? { title: label.client_name, sub: "No task", href: `/clients/${row.client_id}` } : { title: NOT_ON_LIST.client, sub: "No task", href: null }
  return { title: "Internal work", sub: null, href: null }
}

export function WeekGrid({ week, today, editable, readOnlyReason }: { week: WeekView; today: DateString; editable: boolean; readOnlyReason?: string | null }) {
  const router = useRouter()
  const [overrides, setOverrides] = React.useState<Record<string, number>>({})
  const [created, setCreated] = React.useState<Record<string, string | null>>({})
  const [saving, setSaving] = React.useState<Set<string>>(() => new Set())
  const [message, setMessage] = React.useState<{ tone: "error" | "info"; text: string } | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const todayIndex = week.dates.indexOf(today)
  const [day, setDay] = React.useState(todayIndex >= 0 ? todayIndex : 0)
  const inputs = React.useRef(new Map<string, HTMLInputElement>())

  // Fresh server data replaces what was typed in the meantime.
  const [seenWeek, setSeenWeek] = React.useState(week)
  if (seenWeek !== week) {
    setSeenWeek(week)
    setOverrides({})
    setCreated({})
  }

  const rows = week.grid.rows
  const keyOf = (rowKey: string, i: number) => `${rowKey}@${i}`
  const minutesOf = (row: GridRow, i: number) => overrides[keyOf(row.key, i)] ?? row.cells[i].minutes
  const dayTotals = week.dates.map((_, i) => rows.reduce((n, r) => n + minutesOf(r, i), 0))
  const total = dayTotals.reduce((a, b) => a + b, 0)
  const rowTotal = (row: GridRow) => row.cells.reduce((n, _, i) => n + minutesOf(row, i), 0)

  /** Moves focus to another cell (its blur saves the one left); false when there is no such cell. */
  const focusCell = (pos: CellPos): boolean => {
    const el = inputs.current.get(keyOf(pos.rowKey, pos.index))
    if (!el) return false
    el.focus()
    el.select()
    return true
  }

  const save = async (row: GridRow, i: number, minutes: number, label: string) => {
    const k = keyOf(row.key, i)
    const cell = row.cells[i]
    const entryId = k in created ? created[k] : cell.durationEntryId
    setOverrides((o) => ({ ...o, [k]: minutes }))
    setSaving((s) => new Set(s).add(k))
    setMessage(null)
    try {
      const r = await setGridCell({
        week_start: week.monday,
        date: cell.date,
        client_id: row.client_id,
        task_id: row.task_id,
        billable: row.billable,
        duration: minutes > 0 ? formatDurationInput(minutes) : "",
        entry_id: entryId,
      })
      if (!r.ok) {
        setOverrides((o) => {
          const next = { ...o }
          delete next[k]
          return next
        })
        setMessage({ tone: "error", text: `${label}: ${r.error}${r.ref ? ` (Ref ${r.ref})` : ""}` })
        return false
      }
      setCreated((c) => ({ ...c, [k]: r.data.id }))
      setMessage({ tone: "info", text: minutes > 0 ? `${label}: ${formatMinutes(minutes)} saved.` : `${label}: cleared.` })
      router.refresh()
      return true
    } catch {
      setOverrides((o) => {
        const next = { ...o }
        delete next[k]
        return next
      })
      setMessage({ tone: "error", text: `${label}: that didn't reach the server. Check your connection and try again.` })
      return false
    } finally {
      setSaving((s) => {
        const next = new Set(s)
        next.delete(k)
        return next
      })
    }
  }

  const copyLastWeek = async () => {
    setCopying(true)
    try {
      const r = await copyLastWeekRows({ week_start: week.monday })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      toast.success(r.data.added === 0 ? "Nothing to copy: last week's rows are already here, or last week had none." : `${r.data.added} ${r.data.added === 1 ? "row" : "rows"} copied from last week.`)
      router.refresh()
    } catch {
      toast.error("That didn't reach the server. Check your connection and try again.")
    } finally {
      setCopying(false)
    }
  }

  const removeRow = async (row: GridRow) => {
    if (!row.savedRowId) return
    setRemoving(row.key)
    try {
      const r = await removeGridRow({ id: row.savedRowId })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      router.refresh()
    } catch {
      toast.error("That didn't reach the server. Check your connection and try again.")
    } finally {
      setRemoving(null)
    }
  }

  const cellFor = (row: GridRow, i: number, label: string, rowIndex: number, layout: "grid" | "day") => {
    const cell = row.cells[i]
    const minutes = minutesOf(row, i)
    const future = diffDays(cell.date, today) > 0
    const k = keyOf(row.key, i)
    const { weekday, day: dd } = dayHeading(cell.date)
    const aria = `${weekday} ${dd}, ${label}`
    if (cell.locked) {
      return (
        <ReadOnlyCell minutes={minutes} label={aria} why="Locked: billed, or in an approved week." icon={<LockIcon aria-hidden="true" className="size-3 text-text-muted" />} />
      )
    }
    if (!editable || future) {
      return <ReadOnlyCell minutes={minutes} label={aria} why={future ? null : (readOnlyReason ?? null)} />
    }
    if (!cell.editable) {
      return (
        <ReadOnlyCell
          minutes={minutes}
          label={aria}
          why={cell.entryIds.length > 1 ? `${cell.entryIds.length} entries. Change them in the entries list below.` : "Timed with a start and end. Change it in the entries list below."}
        />
      )
    }
    return (
      <CellInput
        refCallback={(el) => {
          // Only the week table navigates between cells; the phone day list doesn't register.
          if (layout !== "grid") return
          if (el) inputs.current.set(k, el)
          else inputs.current.delete(k)
        }}
        minutes={minutes}
        label={aria}
        saving={saving.has(k)}
        onCommit={(m) => save(row, i, m, aria)}
        onInvalid={(text) => setMessage({ tone: "error", text: `${aria}: “${text}” isn't a time. Enter it like 1:30, 1h 30m, 90m or 1.5.` })}
        onMove={(dir) => {
          if (layout !== "grid") return false
          const next = rows[rowIndex + (dir === "down" ? 1 : -1)]
          return next ? focusCell({ rowKey: next.key, index: i }) : false
        }}
        className={layout === "day" ? "w-24" : undefined}
      />
    )
  }

  const toolbar = editable ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
        <PlusIcon aria-hidden="true" />
        Add row
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={copyLastWeek} disabled={copying} aria-busy={copying}>
        {copying ? <Spinner /> : <CopyIcon aria-hidden="true" />}
        Copy last week&apos;s rows
      </Button>
    </div>
  ) : null

  return (
    <section aria-labelledby="week-grid-title" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
        <div>
          <h2 id="week-grid-title" className="text-base font-semibold text-text">
            Time by client and task
          </h2>
          <p className="text-sm text-text-muted">
            {editable ? "Type a day's time into its cell, for example 1:30. It saves when you leave the cell." : (readOnlyReason ?? "Read only.")}
          </p>
        </div>
        {toolbar}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          size="compact"
          className="m-4 md:m-5"
          message={editable ? "Nothing on this week yet. Add a row for each client or task you work on, or copy last week's rows." : "No time logged this week."}
          action={
            editable ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden="true" />
                Add row
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Desktop and tablet: the whole week. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <caption className="sr-only">Time by day for the week, one row per client or task</caption>
              <thead className="bg-surface-2">
                <tr className="border-b border-border">
                  <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-4 py-2 text-left text-xs font-medium text-text-muted md:px-5">
                    Client or task
                  </th>
                  {week.dates.map((d, i) => {
                    const h = dayHeading(d)
                    const isToday = d === today
                    return (
                      <th key={d} scope="col" aria-current={isToday ? "date" : undefined} className={cn("w-20 px-1.5 py-2 text-right text-xs font-medium", isToday ? "text-text" : "text-text-muted", week.targets[i] === 0 && !isToday && "opacity-70")}>
                        <span className="block">{h.weekday}</span>
                        <span className={cn("num tabular-nums", isToday && "font-semibold")}>{h.day}</span>
                        {isToday ? <span className="sr-only"> (today)</span> : null}
                      </th>
                    )
                  })}
                  <th scope="col" className="w-24 px-4 py-2 text-right text-xs font-medium text-text-muted md:px-5">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => {
                  const name = rowName(week.labels[row.key], row)
                  const label = name.sub ? `${name.title} (${name.sub})` : name.title
                  const rt = rowTotal(row)
                  return (
                    <tr key={row.key} className="border-b border-border/70 last:border-b-0">
                      <th scope="row" className="sticky left-0 z-10 max-w-[18rem] bg-surface px-4 py-1.5 text-left font-normal md:px-5">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            {name.href ? (
                              <Link href={name.href} className="block truncate text-sm font-medium text-text hover:underline">
                                {name.title}
                              </Link>
                            ) : (
                              <span className="block truncate text-sm font-medium text-text">{name.title}</span>
                            )}
                            <span className="block truncate text-xs text-text-muted">
                              {name.sub}
                              {name.sub && !row.billable ? " · " : null}
                              {!row.billable ? "Not billable" : null}
                            </span>
                          </div>
                          {editable && row.savedRowId && rt === 0 ? (
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove the row ${label}`} onClick={() => void removeRow(row)} disabled={removing === row.key}>
                              {removing === row.key ? <Spinner /> : <XIcon aria-hidden="true" />}
                            </Button>
                          ) : null}
                        </div>
                      </th>
                      {week.dates.map((d, i) => (
                        <td key={d} className="px-1.5 py-1.5 text-right">
                          {cellFor(row, i, label, rowIndex, "grid")}
                        </td>
                      ))}
                      <td className="num px-4 py-1.5 text-right font-medium text-text tabular-nums md:px-5">{rt ? formatDurationInput(rt) : <span className="text-text-muted">0:00</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-surface-2/60">
                  <th scope="row" className="sticky left-0 z-10 bg-surface-2 px-4 py-2 text-left text-sm font-medium text-text md:px-5">
                    Total
                    <span className="block text-xs font-normal text-text-muted">and target</span>
                  </th>
                  {week.dates.map((d, i) => (
                    <td key={d} className="px-1.5 py-2 text-right">
                      <TotalVsTarget minutes={dayTotals[i]} target={week.targets[i]} />
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right md:px-5">
                    <TotalVsTarget minutes={total} target={week.weeklyTarget} strong />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Phones: one day at a time. */}
          <div className="md:hidden">
            <div role="tablist" aria-label="Day" className="grid grid-cols-7 border-b border-border">
              {week.dates.map((d, i) => {
                const h = dayHeading(d)
                const selected = i === day
                return (
                  <button
                    key={d}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-label={`${h.weekday} ${h.day}${d === today ? ", today" : ""}: ${formatMinutes(dayTotals[i])}`}
                    onClick={() => setDay(i)}
                    className={cn(
                      "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      selected ? "bg-primary-soft text-primary" : "text-text-muted",
                    )}
                  >
                    <span>{h.weekday}</span>
                    <span className={cn("num text-sm tabular-nums", selected || d === today ? "font-semibold" : undefined)}>{h.day}</span>
                    <span className="num tabular-nums">{dayTotals[i] ? formatDurationInput(dayTotals[i]) : "0:00"}</span>
                  </button>
                )
              })}
            </div>
            <ul role="tabpanel" aria-label={`${dayHeading(week.dates[day]).weekday} ${dayHeading(week.dates[day]).day}`} className="divide-y divide-border/70">
              {rows.map((row, rowIndex) => {
                const name = rowName(week.labels[row.key], row)
                const label = name.sub ? `${name.title} (${name.sub})` : name.title
                return (
                  <li key={row.key} className="flex min-h-14 items-center gap-3 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">{name.title}</p>
                      <p className="truncate text-xs text-text-muted">
                        {name.sub}
                        {name.sub && !row.billable ? " · " : null}
                        {!row.billable ? "Not billable" : null}
                      </p>
                    </div>
                    <div className="flex-none">{cellFor(row, day, label, rowIndex, "day")}</div>
                  </li>
                )
              })}
            </ul>
            <div className="flex items-center justify-between border-t border-border bg-surface-2/60 px-4 py-2.5 text-sm">
              <span className="font-medium text-text">Day total</span>
              <TotalVsTarget minutes={dayTotals[day]} target={week.targets[day]} />
            </div>
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-sm">
              <span className="font-medium text-text">Week total</span>
              <TotalVsTarget minutes={total} target={week.weeklyTarget} strong />
            </div>
          </div>
        </>
      )}

      <p role="status" aria-live="polite" className={cn("px-4 text-sm md:px-5", message ? "border-t border-border py-2" : "sr-only", message?.tone === "error" ? "text-danger-text" : "text-text-muted")}>
        {message?.text ?? ""}
      </p>

      {adding ? <AddRowDialog open={adding} onOpenChange={setAdding} weekStart={week.monday} /> : null}
    </section>
  )
}

function TotalVsTarget({ minutes, target, strong = false }: { minutes: number; target: number; strong?: boolean }) {
  return (
    <span className="num inline-flex flex-col items-end leading-tight tabular-nums">
      <span className={cn("text-sm text-text", strong ? "font-semibold" : "font-medium")}>{formatDurationInput(minutes) || "0:00"}</span>
      <span className="text-xs text-text-muted">{target > 0 ? `of ${formatDurationInput(target)}` : "no target"}</span>
    </span>
  )
}

function ReadOnlyCell({ minutes, label, why, icon }: { minutes: number; label: string; why: string | null; icon?: React.ReactNode }) {
  const body = (
    <span className="num inline-flex h-9 w-full min-w-16 items-center justify-end gap-1 px-2 text-sm tabular-nums">
      {icon}
      <span className={minutes ? "text-text" : "text-text-muted"}>{minutes ? formatDurationInput(minutes) : ""}</span>
      <span className="sr-only">{`${label}: ${minutes ? formatMinutes(minutes) : "nothing logged"}${why ? `. ${why}` : ""}`}</span>
    </span>
  )
  if (!why) return body
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="block rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring">
          {body}
        </span>
      </TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  )
}

function CellInput({
  minutes,
  label,
  saving,
  onCommit,
  onInvalid,
  onMove,
  refCallback,
  className,
}: {
  minutes: number
  label: string
  saving: boolean
  onCommit: (minutes: number) => Promise<boolean>
  onInvalid: (text: string) => void
  /** Focus the cell above or below; false when there is none. */
  onMove: (dir: "up" | "down") => boolean
  refCallback: (el: HTMLInputElement | null) => void
  className?: string
}) {
  const shown = formatDurationInput(minutes)
  const [text, setText] = React.useState(shown)
  const [invalid, setInvalid] = React.useState(false)
  const [seenShown, setSeenShown] = React.useState(shown)
  if (seenShown !== shown) {
    setSeenShown(shown)
    setText(shown)
    setInvalid(false)
  }

  const commit = async () => {
    const t = text.trim()
    const next = t === "" ? 0 : parseDuration(t)
    if (next === null || next < 0 || next > MAX_ENTRY_MINUTES) {
      setInvalid(true)
      onInvalid(t)
      return
    }
    setInvalid(false)
    if (next === minutes) {
      setText(shown)
      return
    }
    setText(formatDurationInput(next))
    const saved = await onCommit(next)
    if (!saved) setText(shown)
  }

  return (
    <input
      ref={refCallback}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-busy={saving || undefined}
      readOnly={saving}
      value={text}
      placeholder="0:00"
      onChange={(e) => {
        setText(e.target.value)
        if (invalid) setInvalid(false)
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        // Leaving the cell saves it (onBlur), so moving focus is enough; Enter on the last row just blurs.
        if (e.key === "Enter") {
          e.preventDefault()
          if (!onMove(e.shiftKey ? "up" : "down")) e.currentTarget.blur()
        } else if (e.key === "Escape") {
          setText(shown)
          setInvalid(false)
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault()
          onMove(e.key === "ArrowDown" ? "down" : "up")
        }
      }}
      className={cn(
        "num h-9 w-full min-w-16 rounded-md border border-border/70 bg-surface px-2 text-right text-sm text-text tabular-nums transition-colors duration-150 outline-none placeholder:text-transparent hover:border-border focus:placeholder:text-text-muted/60 focus:border-ring focus:ring-2 focus:ring-ring/30 pointer-coarse:h-11",
        invalid && "border-danger focus:border-danger focus:ring-danger/30",
        saving && "opacity-70",
        className,
      )}
    />
  )
}

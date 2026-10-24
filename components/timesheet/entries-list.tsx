"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { LockIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { EmptyState } from "@/components/app/empty-state"
import { formatDate, formatMinutes } from "@/lib/format"
import { istDateOf, type DateString } from "@/lib/domain/fy"
import { dayHeading, formatDurationInput, istClock, NOT_ON_LIST } from "@/lib/schemas/timesheet"
import type { EntryRow } from "@/lib/data/timesheet"
import { deleteTimeEntry } from "@/server/actions/timesheet"
import { TimeEntryDialog, type EntryInitial } from "@/components/timesheet/time-entry-dialog"
import { toastResult } from "@/components/tasks/task-ui"

/**
 * The week's entries, day by day (§7.10): when, on what, how long, and whether it is billable or
 * locked. Your own entries that aren't locked can be edited (start and end, or a duration) or
 * removed; a running timer shows here once it stops.
 */

function whatOf(e: EntryRow): { title: string; sub: string | null; href: string | null } {
  // No name: RLS no longer shows the viewer that task or client, so no link to a page that would refuse them.
  if (e.task_id) return e.task_title ? { title: e.task_title, sub: [e.task_number, e.client_name].filter(Boolean).join(" · ") || null, href: `/work/${e.task_id}` } : { title: NOT_ON_LIST.task, sub: null, href: null }
  if (e.client_id) return e.client_name ? { title: e.client_name, sub: "No task", href: `/clients/${e.client_id}` } : { title: NOT_ON_LIST.client, sub: "No task", href: null }
  return { title: "Internal work", sub: null, href: null }
}

function whenOf(e: EntryRow): string {
  if (e.ended_at === null) return `From ${istClock(e.started_at)}`
  if (e.entry_source === "manual_duration") return "Duration only"
  return `${istClock(e.started_at)}–${istClock(e.ended_at)}`
}

function editInitial(e: EntryRow): EntryInitial {
  const what = whatOf(e)
  return {
    id: e.id,
    updated_at: e.updated_at,
    date: istDateOf(e.started_at),
    client: e.client_id ? { id: e.client_id, label: e.client_name ?? "Client" } : null,
    task: e.task_id ? { id: e.task_id, label: `${e.task_number ?? ""} · ${e.task_title ?? what.title}` } : null,
    mode: e.entry_source === "manual_duration" ? "duration" : "range",
    start: e.entry_source === "manual_duration" ? "" : istClock(e.started_at),
    end: e.entry_source === "manual_duration" || !e.ended_at ? "" : istClock(e.ended_at),
    duration: formatDurationInput(e.minutes),
    description: e.description,
    billable: e.billable,
  }
}

export function EntriesList({ entries, dates, editable }: { entries: EntryRow[]; dates: DateString[]; editable: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<EntryRow | null>(null)
  const [deleting, setDeleting] = React.useState<EntryRow | null>(null)
  const byDay = dates
    .map((d) => ({ date: d, list: entries.filter((e) => istDateOf(e.started_at) === d) }))
    .filter((g) => g.list.length > 0)
    .reverse()

  return (
    <section aria-labelledby="entries-title" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 md:px-5">
        <h2 id="entries-title" className="text-base font-semibold text-text">
          Entries
        </h2>
        <p className="text-sm text-text-muted">Every entry of the week, newest day first.</p>
      </div>
      {byDay.length === 0 ? (
        <EmptyState size="compact" className="m-4 md:m-5" message="No entries this week. Time from the timer, the grid and Log time shows here." />
      ) : (
        <div className="divide-y divide-border">
          {byDay.map((g) => {
            const h = dayHeading(g.date)
            const dayTotal = g.list.reduce((n, e) => n + (e.ended_at ? e.minutes : 0), 0)
            return (
              <div key={g.date}>
                <h3 className="flex items-center justify-between bg-surface-2/60 px-4 py-1.5 text-xs font-medium text-text-muted md:px-5">
                  <span>
                    {h.weekday}, {formatDate(g.date)}
                  </span>
                  <span className="num tabular-nums">{formatMinutes(dayTotal)}</span>
                </h3>
                <ul className="divide-y divide-border/70">
                  {g.list.map((e) => {
                    const what = whatOf(e)
                    const locked = e.locked || e.invoice_id !== null
                    const running = e.ended_at === null
                    const canChange = editable && !locked && !running
                    return (
                      <li key={e.id} className="flex min-h-12 items-center gap-3 px-4 py-2 md:px-5">
                        <span className="num hidden w-28 flex-none text-sm text-text-muted tabular-nums sm:block">{whenOf(e)}</span>
                        <div className="min-w-0 flex-1">
                          {what.href ? (
                            <Link href={what.href} className="block truncate text-sm font-medium text-text hover:underline">
                              {what.title}
                            </Link>
                          ) : (
                            <span className="block truncate text-sm font-medium text-text">{what.title}</span>
                          )}
                          <p className="truncate text-xs text-text-muted">
                            <span className="sm:hidden">{whenOf(e)} · </span>
                            {[what.sub, e.description].filter(Boolean).join(" · ") || (running ? "Timer running" : null)}
                          </p>
                        </div>
                        <div className="flex flex-none flex-col items-end gap-0.5">
                          <span className="num text-sm font-medium text-text tabular-nums">{running ? "Running" : formatMinutes(e.minutes)}</span>
                          <span className="flex items-center gap-1 text-xs text-text-muted">
                            {locked ? (
                              <>
                                <LockIcon aria-hidden="true" className="size-3" />
                                {e.invoice_id ? "Billed" : "Approved"}
                              </>
                            ) : e.billable ? (
                              "Billable"
                            ) : (
                              "Not billable"
                            )}
                          </span>
                        </div>
                        {editable && !canChange ? <span aria-hidden="true" className="size-8 flex-none" /> : null}
                        {canChange ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${what.title}, ${whenOf(e)}`}>
                                <MoreHorizontalIcon aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setEditing(e)}>
                                <PencilIcon aria-hidden="true" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setDeleting(e)} className="text-danger-text focus:text-danger-text">
                                <Trash2Icon aria-hidden="true" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      {editing ? <TimeEntryDialog open onOpenChange={(o) => (!o ? setEditing(null) : undefined)} initial={editInitial(editing)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
        title="Delete this entry?"
        description={deleting ? `${formatMinutes(deleting.minutes)} on ${whatOf(deleting).title}, ${formatDate(istDateOf(deleting.started_at))}, is removed from your timesheet.` : ""}
        confirmLabel="Delete entry"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          const r = await deleteTimeEntry({ id: deleting.id })
          if (!toastResult(r, "Entry deleted.")) return false
          setDeleting(null)
          router.refresh()
        }}
      />
    </section>
  )
}

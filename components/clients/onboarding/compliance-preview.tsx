"use client"

import * as React from "react"
import { CalendarRangeIcon } from "lucide-react"
import { DateText } from "@/components/app/date-text"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/format"
import { groupPreviewByMonth } from "@/lib/schemas/onboarding"
import type { PreviewState } from "@/components/clients/onboarding/use-deadline-preview"

/**
 * The preview of generated deadlines for the next 12 months, grouped by month, with the source of
 * each date (§7.3.2 step 5, §6.7 "Show the legal source on each event"). Extended dates say which
 * circular moved them; AGM-linked ROC dates say they are provisional; a due date on a Sunday is
 * flagged, never moved (§6.3).
 */
export function CompliancePreview({ preview, today, gstPending }: { preview: PreviewState; today: string; gstPending: boolean }) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  if (preview.status === "error" && !preview.events) {
    return <ErrorBlock message={preview.error?.message ?? "Couldn't work out the deadlines."} errorRef={preview.error?.ref} onRetry={preview.retry} size="compact" className="rounded-md border border-border" />
  }
  if (!preview.events) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
        <span className="sr-only" role="status">
          Working out the deadlines…
        </span>
      </div>
    )
  }
  const grouped = groupPreviewByMonth(preview.events, today, 12)
  if (grouped.months.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={<CalendarRangeIcon />}
        message={
          gstPending
            ? "No statutory deadlines yet. GST returns are planned once the client is registered and its GSTIN is entered."
            : "No statutory deadlines in the next 12 months for these services. Internal deadlines can be added on the Compliance tab."
        }
      />
    )
  }
  const total = grouped.months.reduce((n, m) => n + m.events.length, 0)
  return (
    <div className={preview.status === "loading" ? "opacity-60 transition-opacity" : undefined} aria-busy={preview.status === "loading" || undefined}>
      <p className="mb-2 text-sm text-text-muted">
        {total} {total === 1 ? "deadline" : "deadlines"} in the next 12 months
        {grouped.later ? `, plus ${grouped.later} later ${grouped.later === 1 ? "one" : "ones"} up to ${formatDate(grouped.lastLater)}` : ""}.
        {gstPending ? " GST returns start once the GSTIN is entered." : ""}
      </p>
      <ol className="flex flex-col gap-3">
        {grouped.months.map((m) => {
          const open = expanded[m.key] ?? true
          return (
            <li key={m.key} className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setExpanded((e) => ({ ...e, [m.key]: !open }))}
                aria-expanded={open}
                className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-t-lg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="text-base font-medium text-text">{m.label}</span>
                <span className="num text-sm text-text-muted tabular-nums">
                  {m.events.length} {m.events.length === 1 ? "deadline" : "deadlines"}
                </span>
              </button>
              {open ? (
                <ul className="divide-y divide-border/70 border-t border-border">
                  {m.events.map((e) => (
                    <li key={e.dedupeKey} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate text-base text-text">{e.title}</span>
                        <span className="block text-sm text-text-muted">
                          {e.overrideRef ? (
                            <>
                              Extended from {formatDate(e.originalDueDate)} by {e.overrideRef}
                            </>
                          ) : (
                            (e.sourceRef ?? "Statutory calendar")
                          )}
                        </span>
                        {e.provisional || e.fallsOnSunday ? (
                          <span className="mt-0.5 flex flex-wrap gap-1.5">
                            {e.provisional ? (
                              <span title={e.notes ?? undefined} className="rounded-full border border-warning/30 bg-warning-soft px-1.5 text-xs leading-5 text-warning-text">
                                Provisional
                              </span>
                            ) : null}
                            {e.fallsOnSunday ? <span className="rounded-full border border-border bg-surface-2 px-1.5 text-xs leading-5 text-text-muted">Falls on a Sunday</span> : null}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-right text-sm">
                        <DateText date={e.dueDate} withRelative stacked today={today} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

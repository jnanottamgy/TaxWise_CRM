import { unstable_rethrow } from "next/navigation"
import { HistoryIcon } from "lucide-react"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { ErrorBlock } from "@/components/app/error-block"
import { parseTableParams } from "@/components/app/data-table/params"
import { can } from "@/lib/auth/roles"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { istDateOf } from "@/lib/domain/fy"
import { formatDate, formatDateRange, formatTime } from "@/lib/format"
import { getTimeline, hasAnyTimeline, type TimelineRow } from "@/lib/data/client360"
import { groupByDay, groupOf, hasTimelineFilters, parseTimelineFilters, timelineGroups, TIMELINE_GROUPS } from "@/components/client360/logic/timeline"
import { TimelineFilters, TimelinePagination } from "@/components/client360/timeline/timeline-controls"

/**
 * Client 360 → Timeline (§7.3.3 tab 13, §5.11): the client's story from the first lead contact,
 * newest first, grouped by day, filterable by kind of event and by date (IST), paginated in SQL.
 * Employees never see lead, quotation, invoice or payment events (RLS 0043), and aren't offered
 * those filters. Never throws.
 */
export async function TimelineTab({ clientId, user, supabase, searchParams }: { clientId: string; user: CurrentUser; supabase: ServerSupabase; searchParams: Record<string, string | string[] | undefined> }) {
  const seesMoney = can.seeMoney(user.role)
  const filters = parseTimelineFilters(searchParams, seesMoney)
  const table = parseTableParams(searchParams, { defaultPageSize: 50 })
  const filtered = hasTimelineFilters(filters)

  let rows: TimelineRow[] = []
  let total = 0
  let any = true
  try {
    const [page, exists] = await Promise.all([getTimeline(supabase, clientId, filters, { from: table.from, to: table.to }), filtered ? hasAnyTimeline(supabase, clientId) : Promise.resolve(true)])
    rows = page.rows
    total = page.total
    any = exists
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "client360:timeline", userId: user.id, role: user.role, clientId })
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load this client's timeline." errorRef={ref} />
      </div>
    )
  }

  const groupLabel = new Map<string, string>(TIMELINE_GROUPS.map((g) => [g.id, g.label]))
  const days = groupByDay(rows, (r) => istDateOf(r.created_at))
  const range = filters.from || filters.to ? (filters.from && filters.to ? formatDateRange(filters.from, filters.to) : filters.from ? `from ${formatDate(filters.from)}` : `up to ${formatDate(filters.to)}`) : null

  return (
    <section aria-labelledby="timeline-title" className="flex flex-col gap-1">
      <h2 id="timeline-title" className="sr-only">
        Timeline
      </h2>
      <TimelineFilters groups={timelineGroups(seesMoney).map((g) => ({ value: g.id, label: g.label }))} />
      <div className="rounded-lg border border-border bg-surface">
        {rows.length === 0 ? (
          <div className="p-4 md:p-5">
            {filtered && any ? (
              <FilteredEmpty message={range ? `Nothing on the timeline ${range} for these filters.` : "Nothing on the timeline for these filters."} />
            ) : (
              <EmptyState icon={<HistoryIcon />} message="Nothing on this client's timeline yet. Onboarding, tasks, documents, messages and filings appear here as they happen." />
            )}
          </div>
        ) : (
          <>
            {range ? <p className="border-b border-border px-4 py-2 text-sm text-text-muted md:px-5">Showing {range} (IST)</p> : null}
            <ol>
              {days.map((d) => (
                <li key={d.day} className="border-b border-border last:border-b-0">
                  <h3 className="sticky top-0 bg-surface-2 px-4 py-1.5 text-xs font-medium text-text-muted md:px-5">
                    <time dateTime={d.day}>{formatDate(d.day)}</time>
                  </h3>
                  <ol className="divide-y divide-border/70">
                    {d.items.map((e) => {
                      const g = groupOf(e.event_type)
                      return (
                        <li key={e.id} className="grid grid-cols-[3.25rem_1fr] gap-3 px-4 py-2.5 md:px-5">
                          <time dateTime={e.created_at} className="num pt-0.5 text-sm text-text-muted tabular-nums">
                            {formatTime(e.created_at)}
                          </time>
                          <div className="min-w-0">
                            <p className="text-base text-text">{e.title}</p>
                            {e.description ? <p className="mt-0.5 text-sm whitespace-pre-line text-text-muted">{e.description}</p> : null}
                            <p className="mt-0.5 text-xs text-text-muted">
                              {[g ? groupLabel.get(g) : "Other", e.performed_by_name ?? (e.event_type.startsWith("portal_") ? null : "The system")].filter(Boolean).join(" · ")}
                            </p>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </li>
              ))}
            </ol>
            <TimelinePagination page={table.page} pageSize={table.pageSize} total={total} />
          </>
        )}
      </div>
    </section>
  )
}

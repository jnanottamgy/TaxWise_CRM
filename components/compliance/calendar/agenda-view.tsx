import Link from "next/link"
import { cn } from "@/lib/utils"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { isoWeekday, MONTH_ABBR, parseDateString, type DateString } from "@/lib/domain/fy"
import type { AgendaRow } from "@/lib/data/compliance"
import { eventDisplayStatus, eventFamily, isDone } from "@/components/compliance/logic/event"
import { withEvent } from "@/components/compliance/logic/urls"
import { FamilyDot, StatusMark } from "@/components/compliance/status-mark"
import { AgendaPager } from "@/components/compliance/calendar/agenda-pager"

/**
 * The agenda (§7.7): one row per deadline, by due date, with its client, owner, status, the relative
 * due text and the "Extended" badge (the circular is named in the sheet). Rows open the deadline's
 * sheet. Server-paginated (25/50/100). On phones each row is two lines (DESIGN.md §7). Server-safe;
 * the pager is a client island.
 */

type SP = Record<string, string | string[] | undefined>

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

function heading(date: DateString, today: DateString): string {
  const p = parseDateString(date)
  const words = `${WEEKDAYS[isoWeekday(date) - 1]}, ${p.day} ${MONTH_ABBR[p.month - 1]} ${p.year}`
  return date === today ? `Today · ${words}` : words
}

export function AgendaRows({ rows, sp, today, showOwner, dateHeadings = true }: { rows: AgendaRow[]; sp: SP; today: DateString; showOwner: boolean; dateHeadings?: boolean }) {
  const days: Array<{ date: DateString; rows: AgendaRow[] }> = []
  for (const r of rows) {
    const last = days[days.length - 1]
    if (last && last.date === r.due_date) last.rows.push(r)
    else days.push({ date: r.due_date, rows: [r] })
  }
  return (
    <ol className="divide-y divide-border">
      {days.map((d) => (
        <li key={d.date}>
          {dateHeadings ? (
            <h3 className={cn("sticky top-0 z-10 bg-surface-2 px-4 py-1.5 text-xs font-medium md:px-5", d.date === today ? "text-primary" : "text-text-muted")}>{heading(d.date, today)}</h3>
          ) : null}
          <ul className="divide-y divide-border/70">
            {d.rows.map((r) => {
              const display = eventDisplayStatus(r, today)
              const family = eventFamily(r.type, r.form_code, r.is_statutory)
              const extended = Boolean(r.original_due_date && r.original_due_date !== r.due_date)
              return (
                <li key={r.id}>
                  <Link
                    href={withEvent("/calendar", sp, r.id)}
                    scroll={false}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_8.5rem_13.5rem] md:px-5"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FamilyDot family={family} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">{r.title}</span>
                        <span className="block truncate text-xs text-text-muted md:hidden">
                          {r.client_name ?? "Firm-level"}
                          {showOwner && r.owner_name ? ` · ${r.owner_name}` : ""}
                        </span>
                      </span>
                    </span>
                    <span className="hidden min-w-0 md:block">
                      <span className="flex items-center gap-1.5 truncate text-sm text-text">
                        {r.client_code ? <MonoId value={r.client_code} /> : null}
                        <span className="truncate">{r.client_name ?? "Firm-level"}</span>
                      </span>
                      {showOwner ? <span className="block truncate text-xs text-text-muted">{r.owner_name ?? "No owner"}</span> : null}
                    </span>
                    <span className="w-28 justify-self-end md:w-full">
                      <StatusMark display={display} />
                    </span>
                    <span className="col-span-2 flex items-center gap-2 text-xs md:col-span-1 md:justify-end">
                      {extended ? (
                        <span title={r.override_ref ? `Extended by ${r.override_ref}` : undefined} className="rounded-full border border-info/25 bg-info-soft px-1.5 leading-5 font-medium text-info-text">
                          Extended
                        </span>
                      ) : null}
                      <DateText date={r.due_date} withRelative={!isDone(r)} today={today} className="text-xs" />
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ol>
  )
}

export function AgendaView({
  rows,
  total,
  page,
  pageSize,
  sp,
  today,
  showOwner,
  overdue,
}: {
  rows: AgendaRow[]
  total: number
  page: number
  pageSize: number
  sp: SP
  today: DateString
  showOwner: boolean
  overdue?: { rows: AgendaRow[]; total: number; href: string } | null
}) {
  return (
    <div className="flex flex-col gap-4">
      {overdue && overdue.total > 0 ? (
        <section aria-labelledby="agenda-overdue" className="rounded-lg border border-danger/30 bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 md:px-5">
            <h2 id="agenda-overdue" className="text-md font-semibold text-danger-text">
              Overdue <span className="num font-normal text-text-muted tabular-nums">· {overdue.total}</span>
            </h2>
            {overdue.total > overdue.rows.length ? (
              <Link href={overdue.href} scroll={false} className="text-sm font-medium text-primary hover:underline">
                View all {overdue.total}
              </Link>
            ) : null}
          </div>
          <AgendaRows rows={overdue.rows} sp={sp} today={today} showOwner={showOwner} />
        </section>
      ) : null}
      <section aria-label="Deadlines" className="rounded-lg border border-border bg-surface">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-base text-text-muted">Nothing is due from this date for these filters.</p>
        ) : (
          <AgendaRows rows={rows} sp={sp} today={today} showOwner={showOwner} />
        )}
        {total > 0 ? <AgendaPager page={page} pageSize={pageSize} total={total} /> : null}
      </section>
    </div>
  )
}

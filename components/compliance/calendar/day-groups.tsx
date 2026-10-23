import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatCount } from "@/components/app/data-table/params"
import { isoWeekday, MONTH_ABBR, parseDateString, type DateString } from "@/lib/domain/fy"
import type { CalendarGroup } from "@/lib/data/compliance"
import { calendarHref, monthWeeks, weekDays, type CalendarState } from "@/components/compliance/logic/calendar"
import { eventDisplayStatus, eventFamily } from "@/components/compliance/logic/event"
import { withEvent } from "@/components/compliance/logic/urls"
import { FamilyDot, displayLabel, displayTone } from "@/components/compliance/status-mark"
import { toneClasses } from "@/components/app/tones"

/**
 * The month and week views (§7.7): each day lists one entry per return (GSTR-3B for 42 clients is
 * one line: "38 filed · 3 overdue"), coloured by type with a dot and labelled, so status is never
 * colour alone. A single deadline opens its sheet; a group opens the agenda for that day and return.
 * Below 768px both views become a list of the days that have deadlines (DESIGN.md §7). Server-safe.
 */

type SP = Record<string, string | string[] | undefined>

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function dayLabel(date: DateString): string {
  const p = parseDateString(date)
  return `${WEEKDAYS[isoWeekday(date) - 1]} ${p.day} ${MONTH_ABBR[p.month - 1]}`
}

function GroupEntry({ group, sp, today }: { group: CalendarGroup; sp: SP; today: DateString }) {
  const family = eventFamily(group.type, group.label, group.is_statutory)
  if (group.total === 1 && group.event) {
    const e = group.event
    const d = eventDisplayStatus({ status: e.status, workflow_status: e.workflow_status, due_date: group.date }, today)
    const t = toneClasses(displayTone(d))
    return (
      <Link
        href={withEvent("/calendar", sp, e.id)}
        scroll={false}
        className="block rounded px-1.5 py-1 text-xs leading-4 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`${e.title}${e.client_name ? `, ${e.client_name}` : ""}: ${displayLabel(d)}${group.extended ? ", extended" : ""}`}
        title={`${e.title}${e.client_name ? ` · ${e.client_name}` : ""}`}
      >
        <span className="flex items-center gap-1.5">
          <FamilyDot family={family} />
          <span className="truncate font-medium text-text">{group.label}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1 pl-3.5">
          <span className="truncate text-text-muted">{e.client_name ?? "Firm"}</span>
        </span>
        <span className={cn("block pl-3.5", t.text)}>
          {displayLabel(d, true)}
          {group.extended ? <span className="text-info-text"> · Extended</span> : null}
        </span>
      </Link>
    )
  }
  const open = group.total - group.done
  return (
    <Link
      href={calendarHref(sp, { view: "agenda", day: group.date, label: group.label, date: null })}
      scroll={false}
      className="block rounded px-1.5 py-1 text-xs leading-4 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`${group.label}: ${group.total} deadlines, ${group.done} filed${group.overdue ? `, ${group.overdue} overdue` : ""}${group.extended ? `, ${group.extended} extended` : ""}. Open the list.`}
      title={`${group.label}: ${group.total} deadlines`}
    >
      <span className="flex items-center gap-1.5">
        <FamilyDot family={family} />
        <span className="truncate font-medium text-text">{group.label}</span>
        <span className="num ml-auto flex-none text-text-muted tabular-nums">{formatCount(group.total)}</span>
      </span>
      <span className="mt-0.5 block pl-3.5 text-text-muted">
        {group.done === group.total ? (
          <span className="text-success-text">All filed</span>
        ) : (
          <>
            <span className="num tabular-nums">{formatCount(group.done)}</span> filed
            {group.overdue ? (
              <span className="text-danger-text">
                {" "}
                · <span className="num tabular-nums">{formatCount(group.overdue)}</span> overdue
              </span>
            ) : open ? (
              <>
                {" "}
                · <span className="num tabular-nums">{formatCount(open)}</span> open
              </>
            ) : null}
          </>
        )}
        {group.extended ? <span className="text-info-text"> · Extended</span> : null}
      </span>
    </Link>
  )
}

function groupsByDay(groups: readonly CalendarGroup[]): Map<DateString, CalendarGroup[]> {
  const m = new Map<DateString, CalendarGroup[]>()
  for (const g of groups) {
    const list = m.get(g.date) ?? []
    list.push(g)
    m.set(g.date, list)
  }
  return m
}

function DayNumber({ date, today, muted }: { date: DateString; today: DateString; muted?: boolean }) {
  const day = parseDateString(date).day
  const isToday = date === today
  return (
    <span
      className={cn(
        "num inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
        isToday ? "bg-primary font-semibold text-primary-foreground" : muted ? "text-text-muted/70" : "text-text"
      )}
      aria-label={isToday ? `Today, ${dayLabel(date)}` : dayLabel(date)}
    >
      {day}
    </span>
  )
}

/** Days with deadlines as a list (phones, and the week view below 768px). */
function DayList({ days, byDay, sp, today, emptyText }: { days: DateString[]; byDay: Map<DateString, CalendarGroup[]>; sp: SP; today: DateString; emptyText: string }) {
  const withEvents = days.filter((d) => (byDay.get(d)?.length ?? 0) > 0)
  if (withEvents.length === 0) return <p className="px-4 py-8 text-center text-base text-text-muted">{emptyText}</p>
  return (
    <ol className="divide-y divide-border">
      {withEvents.map((d) => (
        <li key={d} className="flex gap-3 px-3 py-2.5">
          <div className="w-14 flex-none pt-1 text-xs text-text-muted">
            <span className={cn("block font-medium", d === today ? "text-primary" : "text-text")}>{WEEKDAYS[isoWeekday(d) - 1]}</span>
            <span className="num tabular-nums">
              {parseDateString(d).day} {MONTH_ABBR[parseDateString(d).month - 1]}
            </span>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-0.5 sm:grid-cols-2">
            {(byDay.get(d) ?? []).map((g) => (
              <GroupEntry key={`${g.type}-${g.label}-${g.is_statutory}`} group={g} sp={sp} today={today} />
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}

const PER_DAY = 3

export function MonthView({ state, groups, sp, today }: { state: CalendarState; groups: CalendarGroup[]; sp: SP; today: DateString }) {
  const weeks = monthWeeks(state.anchor)
  const month = state.anchor.slice(0, 7)
  const byDay = groupsByDay(groups)
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="hidden md:block">
        <div className="grid grid-cols-7 border-b border-border bg-surface-2 text-xs text-text-muted">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {weeks.flat().map((d, i) => {
            const inMonth = d.startsWith(month)
            const list = byDay.get(d) ?? []
            const more = list.length - PER_DAY
            return (
              <div
                key={d}
                className={cn("min-h-28 border-b border-border p-1", i % 7 !== 0 && "border-l", !inMonth && "bg-surface-2/50")}
              >
                <div className="flex items-center justify-between px-0.5">
                  <DayNumber date={d} today={today} muted={!inMonth} />
                </div>
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {list.slice(0, PER_DAY).map((g) => (
                    <GroupEntry key={`${g.type}-${g.label}-${g.is_statutory}`} group={g} sp={sp} today={today} />
                  ))}
                  {more > 0 ? (
                    <Link href={calendarHref(sp, { view: "agenda", day: d, label: null, date: null })} scroll={false} className="px-1.5 text-xs font-medium text-primary hover:underline">
                      +{more} more
                    </Link>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="md:hidden">
        <DayList days={weeks.flat().filter((d) => d.startsWith(month))} byDay={byDay} sp={sp} today={today} emptyText="Nothing is due this month for these filters." />
      </div>
    </div>
  )
}

export function WeekView({ state, groups, sp, today }: { state: CalendarState; groups: CalendarGroup[]; sp: SP; today: DateString }) {
  const days = weekDays(state.anchor)
  const byDay = groupsByDay(groups)
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="hidden md:grid md:grid-cols-7">
        {days.map((d, i) => (
          <div key={d} className={cn("min-h-64 p-1.5", i > 0 && "border-l border-border")}>
            <div className="mb-1 flex items-center gap-1.5 border-b border-border px-0.5 pb-1.5 text-xs text-text-muted">
              <span>{WEEKDAYS[i]}</span>
              <DayNumber date={d} today={today} />
            </div>
            <div className="flex flex-col gap-0.5">
              {(byDay.get(d) ?? []).length === 0 ? <p className="px-1.5 py-1 text-xs text-text-muted">Nothing due</p> : null}
              {(byDay.get(d) ?? []).map((g) => (
                <GroupEntry key={`${g.type}-${g.label}-${g.is_statutory}`} group={g} sp={sp} today={today} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="md:hidden">
        <DayList days={days} byDay={byDay} sp={sp} today={today} emptyText="Nothing is due this week for these filters." />
      </div>
    </div>
  )
}

import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { CALENDAR_VIEWS, calendarHref, calendarTitle, dateParam, shiftAnchor, type CalendarState, type CalendarView } from "@/components/compliance/logic/calendar"

const VIEW_LABEL: Record<CalendarView, string> = { month: "Month", week: "Week", agenda: "Agenda" }

/**
 * The calendar's view switch (month / week / agenda), previous / today / next, and the heading for
 * what is shown. Every control is a link (the state lives in the URL), so it works without script
 * and the browser's back button steps through views. Server-safe.
 */
export function CalendarNav({ state, sp, today }: { state: CalendarState; sp: Record<string, string | string[] | undefined>; today: string }) {
  const prev = shiftAnchor(state.view, state.anchor, -1)
  const next = shiftAnchor(state.view, state.anchor, 1)
  const step = state.view === "month" ? "month" : "week"
  return (
    <div className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        {state.day ? null : (
          <>
            <Button asChild variant="outline" size="icon-sm" aria-label={`Previous ${step}`}>
              <Link href={calendarHref(sp, { date: dateParam(state.view, prev), day: null, label: null, to: null, pending: null })} scroll={false}>
                <ChevronLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="icon-sm" aria-label={`Next ${step}`}>
              <Link href={calendarHref(sp, { date: dateParam(state.view, next), day: null, label: null, to: null, pending: null })} scroll={false}>
                <ChevronRightIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={calendarHref(sp, { date: dateParam(state.view, today), day: null, label: null, to: null, pending: null })} scroll={false}>
                Today
              </Link>
            </Button>
          </>
        )}
        <h2 className="ml-1 truncate font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text" aria-live="polite">
          {calendarTitle(state)}
          {state.label ? <span className="font-normal text-text-muted"> · {state.label}</span> : null}
          {state.pending ? <span className="font-normal text-text-muted"> · Not yet filed</span> : null}
        </h2>
        {state.pending ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={calendarHref(sp, { pending: null })} scroll={false}>
              Show filed ones too
            </Link>
          </Button>
        ) : null}
        {state.day ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={calendarHref(sp, { view: "month", date: state.day.slice(0, 7), day: null, label: null, to: null, pending: null })} scroll={false}>
              Back to the month
            </Link>
          </Button>
        ) : null}
      </div>
      <nav aria-label="Calendar view" className="flex-none">
        <ul className="inline-flex rounded-md border border-border bg-surface p-0.5">
          {CALENDAR_VIEWS.map((v) => {
            const on = v === state.view && !(v === "agenda" && state.day)
            return (
              <li key={v}>
                <Link
                  href={calendarHref(sp, { view: v, date: dateParam(v, state.day ?? state.anchor), day: null, label: null, to: null, pending: null })}
                  scroll={false}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded px-3 text-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-11",
                    on ? "bg-surface-2 text-text" : "text-text-muted hover:text-text"
                  )}
                >
                  {VIEW_LABEL[v]}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}

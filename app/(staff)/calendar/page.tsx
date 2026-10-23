import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { todayIST } from "@/lib/domain/fy"
import { COMPLIANCE_TYPES, COMPLIANCE_TYPE_LABELS } from "@/lib/domain/enums"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { getAgenda, getCalendarGroups, listClientOptions, listOwnerOptions } from "@/lib/data/compliance"
import { CALENDAR_KINDS, CALENDAR_KIND_LABELS, calendarHref, parseCalendarState } from "@/components/compliance/logic/calendar"
import { withParams } from "@/components/compliance/logic/urls"
import { CalendarNav } from "@/components/compliance/calendar/calendar-nav"
import { MonthView, WeekView } from "@/components/compliance/calendar/day-groups"
import { AgendaView } from "@/components/compliance/calendar/agenda-view"
import { FamilyLegend } from "@/components/compliance/status-mark"
import { NewDeadlineButton } from "@/components/compliance/new-deadline-button"
import { EventSheetSlot } from "@/components/compliance/event-sheet-slot"

export const metadata: Metadata = { title: "Calendar" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/calendar:${source}`, userId }) }
  }
}

/**
 * Calendar (§7.7): statutory and firm deadlines in one calendar, by month, week or agenda, coloured
 * by type, filtered by client, owner and type; extended dates carry a badge (the circular is named
 * in the deadline's sheet). Partners and Managers see every client; Employees see the clients they
 * own, are on the team of, or cover (RLS, §4.1, §4.7). `?event=<id>` opens a deadline.
 */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const today = todayIST()
  const manager = can.seeFirmCalendar(user.role)
  const state = parseCalendarState(sp, today)
  const t = parseTableParams(sp, {})
  const overdueOnly = state.view === "agenda" && readParam(sp, "overdue") === "1"

  const [data, overdue, clients, owners, settings, fy] = await Promise.all([
    attempt("data", user.id, async () => {
      if (state.view === "agenda") {
        const r = await getAgenda(supabase, state, { from: t.from, pageSize: t.pageSize, overdueOnly })
        return { kind: "agenda" as const, ...r }
      }
      const r = await getCalendarGroups(supabase, { ...state, to: state.to! })
      return { kind: "days" as const, ...r }
    }),
    state.view === "agenda" && !state.day && !overdueOnly && t.page === 1 && state.anchor <= today
      ? attempt("overdue", user.id, () => getAgenda(supabase, state, { from: 0, pageSize: 10, overdueOnly: true }))
      : Promise.resolve(null),
    attempt("clients", user.id, () => listClientOptions(supabase)),
    manager ? attempt("owners", user.id, () => listOwnerOptions(supabase)) : Promise.resolve(null),
    manager ? supabase.from("firm_settings").select("compliance_reminder_days").eq("id", 1).maybeSingle() : Promise.resolve(null),
    getSelectedFy(),
  ])

  const filters: FilterDef[] = [
    { id: "client", label: "Client", multi: false, searchable: true, options: clients.ok ? clients.data.map((c) => ({ value: c.id, label: `${c.name} · ${c.code}` })) : [] },
    ...(manager && owners && owners.ok
      ? [{ id: "owner", label: "Owner", multi: false, searchable: true, options: owners.data.map((o) => ({ value: o.id, label: o.name })) }]
      : []),
    { id: "type", label: "Type", options: COMPLIANCE_TYPES.map((v) => ({ value: v, label: COMPLIANCE_TYPE_LABELS[v] })) },
    { id: "kind", label: "Kind", multi: false, options: CALENDAR_KINDS.map((k) => ({ value: k, label: CALENDAR_KIND_LABELS[k] })) },
  ]

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Calendar">
        <p>Statutory deadlines and the firm&apos;s own steps in one calendar. The dot shows the type (GST, income tax, TDS, ROC, payroll, firm and internal); the words say where each one stands.</p>
        <p className="mt-2">On busy days the month view shows one line per return, for example GSTR-3B for 42 clients with how many are filed. Click it for the list; click a single deadline to open it.</p>
        <p className="mt-2">&quot;Extended&quot; marks a date moved by a government extension; the deadline names the circular. Dates that fall on a Sunday are not moved; the deadline says so.</p>
      </PageGuide>
      <PageHeader
        title="Calendar"
        description={manager ? "Statutory and firm deadlines for every client." : "Deadlines for the clients you own, are on the team of, or are covering."}
        actions={
          manager ? (
            <NewDeadlineButton
              clients={clients.ok ? clients.data : []}
              fyOptions={fyOptions(today)}
              defaultFy={fy}
              reminderDays={settings && "data" in settings ? (settings.data?.compliance_reminder_days ?? 7) : 7}
              defaultDue={state.day ?? undefined}
            />
          ) : null
        }
      />
      <FilterBar hideSearch searchLabel="Filter the calendar" filters={filters} actions={<FamilyLegend className="hidden xl:flex" />} />
      <CalendarNav state={state} sp={sp} today={today} />
      {!data.ok ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the calendar." errorRef={data.ref} />
        </div>
      ) : data.data.kind === "days" ? (
        state.view === "month" ? (
          <MonthView state={state} groups={data.data.groups} sp={sp} today={today} />
        ) : (
          <WeekView state={state} groups={data.data.groups} sp={sp} today={today} />
        )
      ) : (
        <AgendaView
          rows={data.data.rows}
          total={data.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sp={sp}
          today={today}
          showOwner={manager}
          overdue={overdue && overdue.ok ? { rows: overdue.data.rows, total: overdue.data.total, href: calendarHref(sp, { view: "agenda", overdue: "1", day: null, label: null }) } : null}
        />
      )}
      <FamilyLegend className="mt-3 xl:hidden" />
      {overdueOnly ? (
        <p className="mt-2 text-sm text-text-muted">
          Showing every deadline past its date and not filed.{" "}
          <a href={withParams("/calendar", sp, { overdue: null }, { resetPage: true })} className="text-primary hover:underline">
            Back to the agenda
          </a>
        </p>
      ) : null}
      <EventSheetSlot eventId={readParam(sp, "event")} user={user} supabase={supabase} closeHref={withParams("/calendar", sp, {})} />
    </div>
  )
}

import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { cn } from "@/lib/utils"
import { todayIST, type DateString } from "@/lib/domain/fy"
import { formatDate, formatMinutes, formatNumber } from "@/lib/format"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { KpiStrip, type KpiItem } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { FilterBar } from "@/components/app/filter-bar"
import { Money } from "@/components/app/money"
import { PageGuide } from "@/components/shell/page-slots"
import { readTimesheetView, readWeekParam, utilisation, weekLabel, weekStartOf, type TimesheetView } from "@/lib/schemas/timesheet"
import { UNBILLED_SORTABLE, getRunningTimer, getTeamWeek, getWeek, listUnbilledByClient, listUnbilledEntries, type WeekView } from "@/lib/data/timesheet"
import { WeekNav } from "@/components/timesheet/week-nav"
import { WeekGrid } from "@/components/timesheet/week-grid"
import { EntriesList } from "@/components/timesheet/entries-list"
import { TimesheetLogTime } from "@/components/timesheet/log-time-button"
import { TimerPanelControls } from "@/components/timesheet/timer-panel-controls"
import { BudgetTable, TeamWeekTable, canApproveWeek, type TeamViewer } from "@/components/timesheet/team-week"
import { ApproveWeekButton, ReopenWeekButton } from "@/components/timesheet/week-approval"
import { UnbilledTable } from "@/components/timesheet/unbilled-table"
import { UnbilledEntries } from "@/components/timesheet/unbilled-entries"

export const metadata: Metadata = { title: "Timesheet" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNBILLED_ENTRY_LIMIT = 200

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/timesheet:${source}`, userId }) }
  }
}

function toParams(sp: SearchParams): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one)
  }
  return p
}

/**
 * The timesheet (§7.10). My timesheet: the week grid (days × tasks) with daily and weekly totals
 * against the target, copy last week's rows, and every entry of the week. Team (Partners and
 * Managers): each person's week, utilisation, approval (which locks the week) and budget against
 * actual. Unbilled time (Partners and Managers): billable time not on an invoice, by client with
 * its ₹ value. Employees see their own time and never a rupee figure (§4.1).
 */
export default async function TimesheetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const pm = user.role === "partner" || user.role === "manager"
  const view = readTimesheetView(readParam(sp, "view"), pm)
  const today = todayIST()
  const thisMonday = weekStartOf(today)
  const requested = readWeekParam(readParam(sp, "week"), today)
  const monday: DateString = requested > thisMonday ? thisMonday : requested
  const personParam = readParam(sp, "person")
  const person = view === "team" && personParam && UUID_RE.test(personParam) ? personParam : null
  const clientParam = readParam(sp, "client")
  const unbilledClient = view === "unbilled" && clientParam && UUID_RE.test(clientParam) ? clientParam : null
  const tableParams = parseTableParams(sp, { sortable: UNBILLED_SORTABLE, defaultSort: { sort: "amount", dir: "desc" } })

  /** A link within the timesheet that keeps the week and changes only what's given. */
  const href = (patch: { view?: TimesheetView; week?: DateString; person?: string | null; client?: string | null }) => {
    const nextView = patch.view ?? view
    const p = new URLSearchParams()
    if (nextView !== "mine") p.set("view", nextView)
    if (nextView !== "unbilled") {
      const w = patch.week ?? monday
      if (w !== thisMonday) p.set("week", w)
    }
    const nextPerson = patch.person === undefined ? person : patch.person
    if (nextView === "team" && nextPerson) p.set("person", nextPerson)
    if (nextView === "unbilled") {
      const keep = toParams(sp)
      for (const k of ["q", "sort", "dir", "page", "size"]) for (const v of keep.getAll(k)) p.append(k, v)
      const nextClient = patch.client === undefined ? unbilledClient : patch.client
      if (nextClient) p.set("client", nextClient)
    }
    const qs = p.toString()
    return qs ? `/timesheet?${qs}` : "/timesheet"
  }

  const [mine, running, team, personWeek, unbilled, unbilledEntries] = await Promise.all([
    view === "mine" && user.employeeId ? attempt("week", user.id, () => getWeek(supabase, user.employeeId!, monday)) : Promise.resolve(null),
    view === "mine" && user.employeeId ? attempt("timer", user.id, () => getRunningTimer(supabase, user.employeeId!)) : Promise.resolve(null),
    view === "team" && pm ? attempt("team", user.id, () => getTeamWeek(supabase, monday, user.role as "partner" | "manager")) : Promise.resolve(null),
    view === "team" && pm && person ? attempt("person", user.id, () => getWeek(supabase, person, monday)) : Promise.resolve(null),
    view === "unbilled" && pm ? attempt("unbilled", user.id, () => listUnbilledByClient(supabase, tableParams)) : Promise.resolve(null),
    view === "unbilled" && pm && unbilledClient
      ? attempt("unbilled-entries", user.id, async () => {
          const [entries, client] = await Promise.all([
            listUnbilledEntries(supabase, unbilledClient, UNBILLED_ENTRY_LIMIT),
            supabase.from("clients").select("id, display_name").eq("id", unbilledClient).maybeSingle(),
          ])
          if (client.error) throw client.error
          return { entries, client: client.data ? { id: client.data.id, name: client.data.display_name } : null }
        })
      : Promise.resolve(null),
  ])

  const tabs: Array<{ id: TimesheetView; label: string }> = pm
    ? [
        { id: "mine", label: "My timesheet" },
        { id: "team", label: "Team" },
        { id: "unbilled", label: "Unbilled time" },
      ]
    : []

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Timesheet">
        <p>One timer runs at a time, kept on the server, so it carries on across pages, reloads and devices. Starting another stops the one running.</p>
        <p className="mt-2">On the week grid, type a day&apos;s time into a cell (1:30, 1h 30m, 90m or 1.5) and it saves when you leave the cell. Time from the timer, or entered with a start and end, is changed from the entries list.</p>
        <p className="mt-2">Billed entries are read-only. A Partner or Manager can approve a week, which locks it; reopening it needs a reason.{pm ? " Unbilled time is billable time not on an invoice yet, valued at each person's billing rate." : ""}</p>
      </PageGuide>
      <PageHeader
        title="Timesheet"
        description={
          view === "team"
            ? "Everyone's week: time per day, utilisation and approval."
            : view === "unbilled"
              ? "Billable time not on an invoice yet, by client."
              : "Your week: time per client and task against your target."
        }
        actions={user.employeeId ? <TimesheetLogTime variant={view === "mine" ? "default" : "outline"} /> : null}
      />

      {tabs.length ? (
        <nav aria-label="Timesheet views" className="mb-3">
          <ul className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface-2 p-0.5">
            {tabs.map((t) => (
              <li key={t.id}>
                <Link
                  href={href({ view: t.id, person: null, client: null })}
                  aria-current={view === t.id ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                    view === t.id ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
                  )}
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {view === "mine" ? (
        <MineView user={user} mine={mine} running={running} monday={monday} thisMonday={thisMonday} today={today} hrefFor={(w) => href({ week: w })} />
      ) : view === "team" ? (
        <TeamView
          team={team}
          personWeek={personWeek}
          person={person}
          viewer={{ role: user.role as "partner" | "manager", employeeId: user.employeeId }}
          monday={monday}
          thisMonday={thisMonday}
          today={today}
          hrefFor={(w) => href({ week: w })}
          personHref={(id) => href({ person: id })}
          closePersonHref={href({ person: null })}
        />
      ) : (
        <UnbilledView
          unbilled={unbilled}
          entries={unbilledEntries}
          clientId={unbilledClient}
          tableParams={tableParams}
          clientHref={(id) => href({ client: id })}
          closeHref={href({ client: null })}
        />
      )}
    </div>
  )
}

type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string } | null

function Failed({ message, errorRef }: { message: string; errorRef: string | null }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={message} errorRef={errorRef} />
    </div>
  )
}

function weekKpis(week: WeekView, today: DateString): KpiItem[] {
  const ti = week.dates.indexOf(today)
  const u = utilisation(week.grid.billable, week.grid.total)
  const items: KpiItem[] = [
    { label: "Logged this week", value: formatMinutes(week.grid.total), sub: week.weeklyTarget ? `of ${formatMinutes(week.weeklyTarget)} target` : "No target this week" },
    { label: "Billable", value: formatMinutes(week.grid.billable), sub: u === null ? "Nothing logged yet" : `${u.toLocaleString("en-IN", { maximumFractionDigits: 1 })}% of the time logged` },
  ]
  if (ti >= 0) {
    items.push({ label: "Today", value: formatMinutes(week.grid.dayTotals[ti]), sub: week.targets[ti] ? `of ${formatMinutes(week.targets[ti])} target` : "Not a working day" })
  } else {
    const worked = week.grid.dayTotals.filter((m) => m > 0).length
    const working = week.targets.filter((m) => m > 0).length
    items.push({ label: "Days with time", value: formatNumber(worked), sub: `of ${formatNumber(working)} working days` })
  }
  items.push({
    label: "Week",
    value: week.approval ? "Approved" : "Open",
    sub: week.approval ? `${week.approval.approved_by_name ? `By ${week.approval.approved_by_name}, ` : ""}${formatDate(week.approval.approved_at)}` : "Not approved yet",
  })
  return items
}

function lockedReason(week: WeekView): string | null {
  if (!week.approval) return null
  return `Approved${week.approval.approved_by_name ? ` by ${week.approval.approved_by_name}` : ""} on ${formatDate(week.approval.approved_at)} and locked${week.approval.note ? ` (${week.approval.note})` : ""}. Ask a Partner or Manager to reopen it if something needs correcting.`
}

function MineView({
  user,
  mine,
  running,
  monday,
  thisMonday,
  today,
  hrefFor,
}: {
  user: { id: string; employeeId: string | null }
  mine: Loaded<WeekView>
  running: Loaded<Awaited<ReturnType<typeof getRunningTimer>>>
  monday: DateString
  thisMonday: DateString
  today: DateString
  hrefFor: (monday: DateString) => string
}) {
  if (!user.employeeId) {
    return <Failed message="Your team record is missing, so there's no timesheet to show. Ask a Partner to link your account." errorRef={null} />
  }
  const timer = running && running.ok ? running.data : null
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <WeekNav monday={monday} thisMonday={thisMonday} hrefFor={hrefFor} />
      </div>
      {!mine || !mine.ok ? (
        <Failed message="Couldn't load your week." errorRef={mine && !mine.ok ? mine.ref : null} />
      ) : (
        <div className="flex flex-col gap-4 lg:gap-6">
          <KpiStrip items={weekKpis(mine.data, today)} lead aria-label={`Your week, ${weekLabel(monday)}`} />
          {timer ? (
            <section aria-label="Running timer" className="rounded-lg border border-border bg-surface p-4 md:p-5">
              <TimerPanelControls running={{ id: timer.id, startedAt: timer.started_at, description: timer.description, task: timer.task, client: timer.client }} shortcuts={[]} compact />
            </section>
          ) : null}
          <WeekGrid week={mine.data} today={today} editable={!mine.data.approval} readOnlyReason={lockedReason(mine.data)} />
          <EntriesList entries={mine.data.entries} dates={mine.data.dates} editable={!mine.data.approval} />
        </div>
      )}
    </>
  )
}

function TeamView({
  team,
  personWeek,
  person,
  viewer,
  monday,
  thisMonday,
  today,
  hrefFor,
  personHref,
  closePersonHref,
}: {
  team: Loaded<Awaited<ReturnType<typeof getTeamWeek>>>
  personWeek: Loaded<WeekView>
  person: string | null
  viewer: TeamViewer
  monday: DateString
  thisMonday: DateString
  today: DateString
  hrefFor: (monday: DateString) => string
  personHref: (id: string) => string
  closePersonHref: string
}) {
  const nav = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <WeekNav monday={monday} thisMonday={thisMonday} hrefFor={hrefFor} />
    </div>
  )
  if (!team || !team.ok) {
    return (
      <>
        {nav}
        <Failed message="Couldn't load the team's week." errorRef={team && !team.ok ? team.ref : null} />
      </>
    )
  }
  const t = team.data
  const approved = t.people.filter((p) => p.approval).length
  const withTime = t.people.filter((p) => p.total > 0).length
  const u = utilisation(t.billable, t.total)
  const kpis: KpiItem[] = [
    { label: "Team time", value: formatMinutes(t.total), sub: `${formatNumber(withTime)} of ${formatNumber(t.people.length)} people logged time` },
    { label: "Billable", value: formatMinutes(t.billable), sub: "Client work marked billable" },
    { label: "Utilisation", value: u === null ? "—" : `${u.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`, sub: "Billable ÷ total" },
    { label: "Weeks approved", value: `${formatNumber(approved)} of ${formatNumber(t.people.length)}`, sub: approved === t.people.length ? "All locked" : "Approving locks a week" },
  ]
  const who = person ? t.people.find((p) => p.employee_id === person) : undefined

  return (
    <>
      {nav}
      <div className="flex flex-col gap-4 lg:gap-6">
        <KpiStrip items={kpis} lead aria-label={`The team's week, ${weekLabel(monday)}`} />
        {person ? (
          !personWeek || !personWeek.ok ? (
            <Failed message="Couldn't load this person's week." errorRef={personWeek && !personWeek.ok ? personWeek.ref : null} />
          ) : (
            <section aria-label={`${who?.name ?? "Person"}'s week`} className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-text">{who?.name ?? "Timesheet"}</h2>
                  <p className="text-sm text-text-muted">
                    {formatMinutes(personWeek.data.grid.total)} of {formatMinutes(personWeek.data.weeklyTarget)} target
                    {personWeek.data.approval ? ` · approved ${formatDate(personWeek.data.approval.approved_at)}` : " · not approved"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {who && canApproveWeek(viewer, who) ? (
                    personWeek.data.approval ? (
                      <ReopenWeekButton person={{ employee_id: who.employee_id, name: who.name }} weekStart={monday} />
                    ) : personWeek.data.grid.total > 0 ? (
                      <ApproveWeekButton person={{ employee_id: who.employee_id, name: who.name }} weekStart={monday} minutes={personWeek.data.grid.total} running={who.running} variant="default" />
                    ) : null
                  ) : null}
                  <Link href={closePersonHref} scroll={false} className="text-sm font-medium text-text-muted hover:text-text hover:underline">
                    Back to the team
                  </Link>
                </div>
              </div>
              <WeekGrid week={personWeek.data} today={today} editable={false} readOnlyReason={`${who?.name ?? "Their"} entries; only they can change them.`} />
              <EntriesList entries={personWeek.data.entries} dates={personWeek.data.dates} editable={false} />
            </section>
          )
        ) : null}
        <TeamWeekTable team={t} viewer={viewer} today={today} personHref={personHref} />
        <BudgetTable rows={t.budget} />
      </div>
    </>
  )
}

function UnbilledView({
  unbilled,
  entries,
  clientId,
  tableParams,
  clientHref,
  closeHref,
}: {
  unbilled: Loaded<Awaited<ReturnType<typeof listUnbilledByClient>>>
  entries: Loaded<{ entries: Awaited<ReturnType<typeof listUnbilledEntries>>; client: { id: string; name: string } | null }>
  clientId: string | null
  tableParams: ReturnType<typeof parseTableParams<(typeof UNBILLED_SORTABLE)[number], never>>
  clientHref: (id: string) => string
  closeHref: string
}) {
  if (!unbilled || !unbilled.ok) return <Failed message="Couldn't load unbilled time." errorRef={unbilled && !unbilled.ok ? unbilled.ref : null} />
  const u = unbilled.data
  const hrefFor: Record<string, string> = {}
  for (const r of u.rows) hrefFor[r.client_id] = clientHref(r.client_id)
  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <KpiStrip
        lead
        aria-label="Unbilled time"
        items={[
          { label: "Unbilled value", value: <Money value={u.totals.amount} />, sub: "At each person's billing rate" },
          { label: "Unbilled time", value: formatMinutes(u.totals.minutes), sub: "Billable, not on an invoice" },
          { label: "Clients", value: formatNumber(u.totals.clients), sub: "With unbilled time" },
        ]}
      />
      {clientId ? (
        !entries || !entries.ok ? (
          <Failed message="Couldn't load this client's unbilled entries." errorRef={entries && !entries.ok ? entries.ref : null} />
        ) : entries.data.client ? (
          <UnbilledEntries client={entries.data.client} entries={entries.data.entries} limit={UNBILLED_ENTRY_LIMIT} closeHref={closeHref} />
        ) : (
          <Failed message="That client isn't available any more." errorRef={null} />
        )
      ) : null}
      <div>
        <FilterBar searchLabel="Search clients" searchPlaceholder="Client name or code" />
        <UnbilledTable rows={u.rows} total={u.total} page={tableParams.page} pageSize={tableParams.pageSize} sort={tableParams.sort} dir={tableParams.dir} hrefFor={hrefFor} />
      </div>
    </div>
  )
}

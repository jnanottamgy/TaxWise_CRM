import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { CalendarClockIcon } from "lucide-react"
import type { ClientTabProps } from "@/components/client360/types"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { compareDates, fyEnd, monthPeriodLabel, todayIST, type DateString } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { readParam } from "@/components/app/data-table/params"
import { KpiStrip, type KpiItem } from "@/components/app/kpi-strip"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { GRID_RETURN_TYPES, matchesReturnType } from "@/lib/schemas/compliance"
import { getClientComplianceEvents, type ClientEventRow } from "@/lib/data/compliance"
import { documentShare, getShareContextOrNull, type DocumentShare } from "@/lib/data/document-share"
import { loadComplianceEngine } from "@/server/compliance/engine"
import { clientCoverageGaps, type ClientGap } from "@/server/compliance/coverage-gaps"
import { gridColumns, layoutRow } from "@/components/compliance/logic/grid"
import { eventDisplayStatus, eventFamily, isDone, summariseStatuses } from "@/components/compliance/logic/event"
import { withEvent, withParams } from "@/components/compliance/logic/urls"
import { FamilyDot, StatusLegend, StatusMark, displayLabel } from "@/components/compliance/status-mark"
import { ClientGapsList } from "@/components/compliance/coverage-gaps"
import { GenerateButton } from "@/components/compliance/generate-button"
import { NewDeadlineButton } from "@/components/compliance/new-deadline-button"
import { ReportButton } from "@/components/compliance/report-button"
import { EventSheetSlot } from "@/components/compliance/event-sheet-slot"

/**
 * Client 360 → Compliance (§7.3.3 tab 5, §7.7): the client's status per period (GST, TDS, advance
 * tax and payroll returns across the FY's months; annual returns listed), coverage gaps with their
 * one-click fix, the calendar as a list by month, Generate deadlines (idempotent), and the
 * compliance report PDF (downloaded, or sent to the client on WhatsApp). Every deadline opens its
 * sheet (`?event=`). Under the viewer's RLS; no fees. Never throws: a failed load shows its Ref in
 * its own block.
 */
export default async function ClientComplianceTab({ clientId, user, supabase, searchParams }: ClientTabProps) {
  const today = todayIST()
  const fy = await getSelectedFy()
  const manager = can.createAndAssignTasks(user.role)
  const base = `/clients/${clientId}`
  const sp = searchParams

  let events: ClientEventRow[] = []
  let gaps: ClientGap[] = []
  let client: { id: string; display_name: string; client_code: string } | null = null
  let share: DocumentShare | null = null
  let reminderDays = 7
  let loadRef: string | null = null
  let gapsRef: string | null = null
  try {
    const [rows, c, settings, shareCtx] = await Promise.all([
      getClientComplianceEvents(supabase, clientId, fy),
      supabase.from("clients").select("id, display_name, client_code").eq("id", clientId).maybeSingle(),
      supabase.from("firm_settings").select("compliance_reminder_days").eq("id", 1).maybeSingle(),
      getShareContextOrNull(supabase, user, clientId, { source: "client360:compliance:share" }),
    ])
    if (c.error) throw c.error
    events = rows
    client = c.data ? { id: c.data.id, display_name: c.data.display_name, client_code: String(c.data.client_code) } : null
    reminderDays = settings.data?.compliance_reminder_days ?? 7
    // The report's period is chosen in the dialog, which sets the attachment (ReportButton).
    share = shareCtx
      ? documentShare(shareCtx, {
          draft: (first) =>
            `${first ? `Hi ${first}` : "Hello"}, please find the compliance report for ${shareCtx.client.name}: every return and filing in the period, its status, the date it was filed, the acknowledgement number and whether it was on time.`,
          templateTypes: ["custom"],
          attachment: { href: `/api/pdf/compliance-report/${clientId}?download=1`, filename: "Compliance report.pdf" },
          related: { type: "compliance_report", id: clientId },
        })
      : null
  } catch (err) {
    unstable_rethrow(err)
    loadRef = logUnexpected(err, { source: "client360:compliance", userId: user.id, role: user.role, clientId })
  }
  try {
    const engine = await loadComplianceEngine(supabase, today)
    gaps = await clientCoverageGaps(supabase, engine, clientId, today)
  } catch (err) {
    unstable_rethrow(err)
    gapsRef = logUnexpected(err, { source: "client360:compliance:gaps", userId: user.id, role: user.role, clientId })
  }

  const sheet = <EventSheetSlot eventId={readParam(sp, "event")} user={user} supabase={supabase} closeHref={withParams(base, sp, {})} />
  const actions = (
    <div className="flex flex-none flex-wrap items-center gap-2 lg:justify-end">
      <GenerateButton clientIds={[clientId]} />
      {client ? <ReportButton clientId={clientId} clientCode={client.client_code} fy={fy} share={share} /> : null}
      {manager && client ? (
        <NewDeadlineButton
          variant="outline"
          fixedClient={{ id: client.id, name: client.display_name, code: client.client_code }}
          fyOptions={fyOptions(today)}
          defaultFy={fy}
          reminderDays={reminderDays}
          defaultOpen={readParam(sp, "new_deadline") === "1"}
        />
      ) : null}
    </div>
  )

  if (loadRef) {
    return (
      <div className="flex flex-col gap-4">
        {actions}
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this client's deadlines." errorRef={loadRef} />
        </div>
        {sheet}
      </div>
    )
  }

  const live = events.filter((e) => e.status !== "cancelled")
  const statutory = live.filter((e) => e.is_statutory)
  const upcoming = statutory.filter((e) => !isDone(e) && compareDates(e.due_date, today) >= 0)
  const next = upcoming[0] ?? null
  const overdue = statutory.filter((e) => eventDisplayStatus(e, today) === "overdue")
  const dueSoFar = statutory.filter((e) => compareDates(e.due_date, today) <= 0)
  const filedSoFar = dueSoFar.filter((e) => isDone(e))
  const late = filedSoFar.filter((e) => e.filed_on && compareDates(e.filed_on, e.due_date) > 0)

  const kpis: KpiItem[] = [
    {
      label: "Next deadline",
      value: next ? <DateText date={next.due_date} /> : <span className="text-text-muted">—</span>,
      sub: next ? next.title : "Nothing planned ahead in this FY",
      href: next ? withEvent(base, sp, next.id) : undefined,
    },
    {
      label: "Overdue",
      value: <span className={overdue.length ? "text-danger-text" : undefined}>{overdue.length}</span>,
      sub: overdue.length ? overdue.slice(0, 2).map((e) => e.form_code ?? e.title).join(", ") + (overdue.length > 2 ? ` and ${overdue.length - 2} more` : "") : "Nothing past its date",
    },
    {
      label: `Filed so far · FY ${fy}`,
      value: (
        <span>
          {filedSoFar.length}
          <span className="text-text-muted"> /{dueSoFar.length}</span>
        </span>
      ),
      sub: dueSoFar.length ? (late.length ? `${late.length} filed late` : "All on time") : "Nothing due yet",
    },
    { label: "Still to come", value: upcoming.length, sub: `Statutory deadlines from today to ${formatDate(fyEnd(fy))}` },
  ]

  // Status per period: returns with a monthly or quarterly rhythm across the FY's months; annual ones listed.
  const periodic = GRID_RETURN_TYPES.filter((t) => t.layout !== "form")
  const columns = gridColumns("month", fy, [])
  const rows = periodic
    .map((rt) => ({ rt, events: live.filter((e) => e.financial_year === fy && matchesReturnType(e, rt)) }))
    .filter((r) => r.events.length > 0)
  const annual = statutory.filter((e) => e.financial_year && !periodic.some((rt) => matchesReturnType(e, rt)))

  // The calendar by month, in due-date order.
  const months: Array<{ key: string; label: string; events: ClientEventRow[] }> = []
  for (const e of live) {
    const key = e.due_date.slice(0, 7)
    const m = months[months.length - 1]
    if (m && m.key === key) m.events.push(e)
    else months.push({ key, label: monthPeriodLabel(`${key}-01`), events: [e] })
  }
  const thisMonth = today.slice(0, 7)
  // This month and the next one with deadlines start open; earlier months are folded.
  const firstOpen = months.findIndex((m) => m.key >= thisMonth)
  const cancelled = events.length - live.length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <p className="min-w-0 max-w-prose text-sm text-text-muted">Deadlines due in FY {fy}, or for it. Planned from the statutory calendar, the ops templates and dates added by hand.</p>
        {actions}
      </div>

      {live.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={<CalendarClockIcon />}
            message={`No deadlines are planned for FY ${fy}. Generate them from the client's services, or add one by hand.`}
            action={<GenerateButton clientIds={[clientId]} variant="default" />}
          />
        </div>
      ) : (
        <KpiStrip items={kpis} aria-label="Compliance summary" />
      )}

      {gapsRef ? (
        <SectionCard title="Coverage gaps">
          <ErrorBlock message="Couldn't check the coverage gaps." errorRef={gapsRef} size="compact" />
        </SectionCard>
      ) : gaps.length > 0 ? (
        <SectionCard title="Coverage gaps" description="Active services with nothing planned ahead.">
          <ClientGapsList clientId={clientId} gaps={gaps} />
        </SectionCard>
      ) : null}

      {rows.length > 0 ? (
        <SectionCard title="Status per period" description={`FY ${fy}: each month, or the quarter a quarterly return covers.`} flush>
          <div className="overflow-x-auto [scrollbar-width:thin]">
            <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Status of each return by period, FY {fy}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 w-36 min-w-36 border-y border-border bg-surface-2 px-4 py-1.5 text-left text-xs font-normal text-text-muted">
                    Return
                  </th>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className="w-[4.25rem] min-w-[4.25rem] border-y border-border bg-surface-2 px-1 py-1.5 text-center text-xs font-normal text-text-muted">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ rt, events: list }) => (
                  <tr key={rt.key}>
                    <th scope="row" className="sticky left-0 z-10 border-b border-border bg-surface px-4 py-1.5 text-left text-sm font-medium text-text">
                      {rt.label}
                    </th>
                    {layoutRow("month", fy, columns, list, today).map((cell) =>
                      cell.kind === "empty" ? (
                        <td key={`e-${cell.start}`} className="border-b border-border px-1 py-1.5 text-center text-text-muted">
                          <span aria-label={`${rt.label} · ${columns[cell.start].name}: no return due`}>—</span>
                        </td>
                      ) : (
                        <td key={`c-${cell.start}`} colSpan={cell.span} className="border-b border-border px-1 py-1.5">
                          <Link
                            href={withEvent(base, sp, cell.events[0].id)}
                            scroll={false}
                            aria-label={`${rt.label} · ${columns[cell.start].name}${cell.span > 1 ? ` to ${columns[cell.start + cell.span - 1].name}` : ""}: ${displayLabel(cell.display)}, due ${formatDate(cell.events[0].due_date)}`}
                            title={`${cell.events.map((e) => e.title).join("; ")}: ${displayLabel(cell.display)}`}
                            className="block rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                          >
                            <StatusMark display={cell.display} showLabel={cell.span > 1} count={{ done: cell.done, total: cell.total }} />
                          </Link>
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border px-4 py-3 md:px-5">
            <StatusLegend />
          </div>
        </SectionCard>
      ) : null}

      {annual.length > 0 ? (
        <SectionCard title="Annual returns" description={`For FY ${fy} and due in it.`} flush>
          <ul className="divide-y divide-border">
            {annual.map((e) => (
              <EventLine key={e.id} e={e} href={withEvent(base, sp, e.id)} today={today} />
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {months.length > 0 ? (
        <SectionCard
          title="Calendar"
          description={cancelled ? `${cancelled} cancelled ${cancelled === 1 ? "deadline is" : "deadlines are"} left out.` : "By due month. Past months are folded."}
          action={
            <Link href={`/calendar?view=agenda&client=${clientId}`} className="text-sm font-medium text-primary hover:underline">
              Open in the calendar
            </Link>
          }
          flush
        >
          <div className="divide-y divide-border">
            {months.map((m, i) => {
              const s = summariseStatuses(m.events.filter((e) => e.is_statutory), today)
              const openByDefault = firstOpen >= 0 ? i === firstOpen || i === firstOpen + 1 : i === months.length - 1
              return (
                <details key={m.key} open={openByDefault} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
                    <span className="text-sm font-medium text-text">
                      {m.label}
                      {m.key === thisMonth ? <span className="font-normal text-text-muted"> · this month</span> : null}
                    </span>
                    <span className="num text-xs text-text-muted tabular-nums">
                      {m.events.length} {m.events.length === 1 ? "deadline" : "deadlines"}
                      {s.total ? ` · ${s.done} filed` : ""}
                    </span>
                  </summary>
                  <ul className="divide-y divide-border/70 border-t border-border">
                    {m.events.map((e) => (
                      <EventLine key={e.id} e={e} href={withEvent(base, sp, e.id)} today={today} />
                    ))}
                  </ul>
                </details>
              )
            })}
          </div>
        </SectionCard>
      ) : null}

      {sheet}
    </div>
  )
}

function EventLine({ e, href, today }: { e: ClientEventRow; href: string; today: DateString }) {
  const display = eventDisplayStatus(e, today)
  const extended = Boolean(e.original_due_date && e.original_due_date !== e.due_date)
  return (
    <li>
      <Link
        href={href}
        scroll={false}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:grid-cols-[minmax(0,1fr)_8.5rem_13.5rem] md:px-5"
      >
        <span className="flex min-w-0 items-center gap-2">
          <FamilyDot family={eventFamily(e.type, e.form_code, e.is_statutory)} />
          <span className="min-w-0">
            <span className="block truncate text-sm text-text">{e.title}</span>
            <span className="block truncate text-xs text-text-muted">
              {e.is_statutory ? "Statutory" : "Internal step"}
              {e.filed_on ? ` · filed ${formatDate(e.filed_on)}` : ""}
              {e.is_provisional && !isDone(e) ? " · provisional date" : ""}
            </span>
          </span>
        </span>
        <span className="w-28 justify-self-end md:w-full">
          <StatusMark display={display} />
        </span>
        <span className="col-span-2 flex items-center gap-2 text-xs md:col-span-1 md:justify-end">
          {extended ? <span className="rounded-full border border-info/25 bg-info-soft px-1.5 leading-5 font-medium text-info-text">Extended</span> : null}
          <DateText date={e.due_date} withRelative={!isDone(e)} today={today} className="text-xs" />
        </span>
      </Link>
    </li>
  )
}

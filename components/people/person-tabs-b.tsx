import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ActivityIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDate, formatDateTime, formatMinutes, formatPercent } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { TablePaginationLinks } from "@/components/people/pagination-links"
import { getPersonActivity, getPersonPerformance, getPersonTime } from "@/lib/data/people"
import { getWorkingCalendar } from "@/lib/data/capacity"
import type { PersonTabProps } from "@/components/people/person-tabs-a"

/**
 * Person detail tabs (§7.11.2), part two: Time, Activity and Performance. Shown to the person
 * themselves too.
 */

async function attempt<T>(source: string, viewer: CurrentUser, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/people/[id]:${source}`, userId: viewer.id, role: viewer.role }) }
  }
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—"
  return formatPercent(Math.round((part * 1000) / whole) / 10, { decimals: 1 })
}

function Failed({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Time: this week / month hours, billable %, utilisation (§7.11.2, §7.10)
// -------------------------------------------------------------------------------------------------

export async function PersonTimeTab({ person, viewer, supabase }: PersonTabProps) {
  const today = todayIST()
  const r = await attempt("time", viewer, async () => {
    const calendar = await getWorkingCalendar(supabase, today, today)
    return getPersonTime(supabase, person.id, today, calendar.weeklyHoursTarget)
  })
  if (!r.ok) return <Failed what="their time" errorRef={r.ref} />
  const t = r.data
  const weekVsTarget = t.weeklyTargetMinutes > 0 ? `of ${formatMinutes(t.weeklyTargetMinutes)} target` : "no weekly target set"
  return (
    <div className="flex flex-col gap-4">
      <KpiStrip
        aria-label="Time"
        items={[
          { label: "This week", value: formatMinutes(t.weekMinutes), sub: `${weekVsTarget} · since ${formatDate(t.weekStart)}` },
          { label: "Billable this week", value: pct(t.weekBillableMinutes, t.weekMinutes), sub: `${formatMinutes(t.weekBillableMinutes)} billable` },
          { label: "This month", value: formatMinutes(t.monthMinutes), sub: `since ${formatDate(t.monthStart)}` },
          { label: "Utilisation this month", value: pct(t.monthBillableMinutes, t.monthMinutes), sub: "billable ÷ total time logged" },
        ]}
      />
      <p className="text-sm text-text-muted">
        From the timesheet: logged and finished entries only.{" "}
        <Link href={viewer.employeeId === person.id ? "/timesheet" : `/timesheet?person=${person.id}`} className="font-medium text-primary hover:underline">
          Open the timesheet
        </Link>
      </p>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Activity timeline (§7.11.2)
// -------------------------------------------------------------------------------------------------

const PAGE_SIZE = 25

export async function PersonActivityTab({ person, viewer, supabase, searchParams }: PersonTabProps) {
  const raw = Array.isArray(searchParams.apage) ? searchParams.apage[0] : searchParams.apage
  const page = Math.max(1, Math.min(10_000, Number.parseInt(raw ?? "1", 10) || 1))
  const r = await attempt("activity", viewer, () => getPersonActivity(supabase, person.id, page, PAGE_SIZE))
  if (!r.ok) return <Failed what="their activity" errorRef={r.ref} />
  const { rows, total } = r.data
  return (
    <SectionCard title="Activity" description="What they did in the app, newest first" flush>
      {rows.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState icon={<ActivityIcon />} message={page > 1 ? "No more activity." : "No activity recorded yet. It fills in as they sign in, work on clients and tasks, and upload documents."} />
        </div>
      ) : (
        <>
          <ol className="divide-y divide-border/70 border-t border-border/70">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 md:px-5">
                <span className="min-w-0 text-base text-text">
                  {a.description}
                  {a.entity_name ? <span className="text-text-muted"> · {a.entity_name}</span> : null}
                </span>
                <span className="num flex-none text-sm text-text-muted">{formatDateTime(a.performed_at)}</span>
              </li>
            ))}
          </ol>
          <TablePaginationLinks page={page} pageSize={PAGE_SIZE} total={total} param="apage" />
        </>
      )}
    </SectionCard>
  )
}

// -------------------------------------------------------------------------------------------------
// Performance (§7.11.2): filed on time %, average days late, review send-back rate, hours vs target
// -------------------------------------------------------------------------------------------------

export async function PersonPerformanceTab({ person, viewer, supabase }: PersonTabProps) {
  const today = todayIST()
  const fy = await getSelectedFy()
  const r = await attempt("performance", viewer, async () => {
    const calendar = await getWorkingCalendar(supabase, today, today)
    return getPersonPerformance(supabase, person.id, fy, today, calendar.weeklyHoursTarget)
  })
  if (!r.ok) return <Failed what="their performance" errorRef={r.ref} />
  const p = r.data
  return (
    <div className="flex flex-col gap-4">
      <KpiStrip
        aria-label={`Performance in FY ${fy}`}
        lead
        items={[
          {
            label: "Filed on time",
            value: p.onTimePercent === null ? "—" : formatPercent(p.onTimePercent, { decimals: 1 }),
            sub: p.filed ? `${p.filedOnTime} of ${p.filed} filed tasks` : "nothing filed yet this year",
          },
          { label: "Average days late", value: p.averageDaysLate === null ? "0" : String(p.averageDaysLate), sub: p.filedLate ? `over ${p.filedLate} late ${p.filedLate === 1 ? "task" : "tasks"}` : "no late filings" },
          {
            label: "Sent back from review",
            value: p.sendBackPercent === null ? "—" : formatPercent(p.sendBackPercent, { decimals: 1 }),
            sub: p.submittedForReview ? `${p.sentBack} of ${p.submittedForReview} submissions` : "nothing submitted for review yet",
          },
          {
            label: "Hours vs target",
            value: formatMinutes(p.hoursMinutes),
            sub: p.targetMinutes ? `of ${formatMinutes(p.targetMinutes)} so far this year (${pct(p.hoursMinutes, p.targetMinutes)})` : "no weekly target set",
          },
        ]}
      />
      <p className="text-sm text-text-muted">
        FY {fy}, up to today. A task without a due date counts as on time. Change the year with the FY switcher at the top.
      </p>
    </div>
  )
}

import type { Metadata } from "next"
import Link from "next/link"
import { redirect, unstable_rethrow } from "next/navigation"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { getAttendanceToday, getTeamAttendance } from "@/lib/data/attendance"
import { getTeamCounts, getTeamPerformance } from "@/lib/data/people"
import { getWorkingCalendar } from "@/lib/data/capacity"
import { isMonth, monthLabel, shiftMonth } from "@/lib/schemas/leave"
import { TeamPerformanceTable } from "@/components/attendance/team-performance-table"
import { AttendanceExportMenu } from "@/components/attendance/export-menu"

export const metadata: Metadata = { title: "Performance & attendance" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/performance:${source}`, userId }) }
  }
}

/**
 * Performance & attendance (§7.11.2 Performance, §7.12): today's attendance, then each person's
 * month (present, late, half days, absent, leave, active time) beside their year (filed on time,
 * days late, sent back, hours vs target), with the attendance exports. Partners and Managers; an
 * Employee sees their own on their page.
 */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  if (!can.managePeople(user.role)) redirect(user.employeeId ? `/people/${user.employeeId}?tab=performance` : "/profile")

  const sp = await searchParams
  const today = todayIST()
  const current = today.slice(0, 7)
  const raw = Array.isArray(sp.month) ? sp.month[0] : sp.month
  const month = isMonth(raw) && raw <= current ? raw : current
  const fy = await getSelectedFy()

  const [todayCounts, team, counts] = await Promise.all([
    attempt("today", user.id, () => getAttendanceToday(supabase, today)),
    attempt("team", user.id, async () => {
      const attendance = await getTeamAttendance(supabase, month)
      const calendar = await getWorkingCalendar(supabase, today, today)
      const performance = await getTeamPerformance(supabase, attendance.rows.map((r) => r.employee_id), fy, today, calendar.weeklyHoursTarget)
      return { attendance, performance }
    }),
    attempt("counts", user.id, () => getTeamCounts(supabase)),
  ])

  const prev = shiftMonth(month, -1)
  const next = shiftMonth(month, 1)
  const nav = (
    <div className="flex items-center gap-1">
      <Button asChild variant="ghost" size="icon-sm" aria-label={`Previous month, ${monthLabel(prev)}`}>
        <Link href={`/performance?month=${prev}`} scroll={false}>
          <ChevronLeftIcon aria-hidden="true" />
        </Link>
      </Button>
      <span className="num min-w-20 text-center text-sm font-medium text-text">{monthLabel(month)}</span>
      {next <= current ? (
        <Button asChild variant="ghost" size="icon-sm" aria-label={`Next month, ${monthLabel(next)}`}>
          <Link href={`/performance?month=${next}`} scroll={false}>
            <ChevronRightIcon aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <span aria-hidden="true" className="size-8" />
      )}
    </div>
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageGuide title="Performance & attendance">
        <p>Attendance comes from the app&apos;s presence heartbeat: the first activity of the day against the start time and grace, active minutes against the half-day minimum, and approved leave.</p>
        <p className="mt-2">Performance is for the financial year in the FY switcher: tasks filed on or before their due date, the average days late for the rest, how often work came back from review, and hours logged against the weekly target.</p>
        <p className="mt-2">Open a person to see their calendar and correct a day, with a reason.</p>
      </PageGuide>
      <PageHeader title="Performance & attendance" className="pb-0 md:pb-0" description={`Attendance for ${monthLabel(month)} · performance for FY ${fy}`} actions={<AttendanceExportMenu month={month} />} />
      {todayCounts.ok ? (
        <KpiStrip
          aria-label="Attendance today"
          items={[
            { label: "Present today", value: todayCounts.data.present },
            { label: "Late login", value: todayCounts.data.late_login },
            { label: "On leave", value: todayCounts.data.on_leave, href: "/leave?tab=away" },
            { label: "Online now", value: counts.ok ? counts.data.onlineNow : "—", href: "/people" },
          ]}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load today's attendance." errorRef={todayCounts.ref} size="compact" />
        </div>
      )}
      <SectionCard title="The team" description="Month on the left, financial year on the right" action={nav} flush>
        {team.ok ? (
          <TeamPerformanceTable rows={team.data.attendance.rows} performance={team.data.performance} month={monthLabel(month)} fy={fy} />
        ) : (
          <ErrorBlock message={`Couldn't load the team's figures for ${monthLabel(month)}.`} errorRef={team.ref} />
        )}
      </SectionCard>
    </div>
  )
}

import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { formatMinutes } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { getAttendanceMonth } from "@/lib/data/attendance"
import { isMonth, monthLabel, shiftMonth } from "@/lib/schemas/leave"
import { canManagePerson, type StaffRole } from "@/lib/schemas/people"
import { AttendanceCalendar } from "@/components/attendance/attendance-calendar"

/**
 * A person's attendance month (§7.11.2, §7.12): the summary (present, late, half days, absent,
 * leave, hours) and the calendar. Partners and Managers correct days (Managers: Employees only).
 * `?month=YYYY-MM` picks the month; it never goes past the current one.
 */
export async function AttendanceTab({
  employeeId,
  employeeRole,
  viewer,
  supabase,
  searchParams,
  basePath,
}: {
  employeeId: string
  employeeRole: StaffRole
  viewer: CurrentUser
  supabase: ServerSupabase
  searchParams: Record<string, string | string[] | undefined>
  /** The page path with the tab param, e.g. /people/<id>?tab=attendance */
  basePath: string
}) {
  const today = todayIST()
  const current = today.slice(0, 7)
  const raw = Array.isArray(searchParams.month) ? searchParams.month[0] : searchParams.month
  const month = isMonth(raw) && raw <= current ? raw : current
  const canCorrect = canManagePerson(viewer.role, employeeRole) && (viewer.employeeId !== employeeId || viewer.role === "partner")

  let data: Awaited<ReturnType<typeof getAttendanceMonth>> | null = null
  let ref: string | null = null
  try {
    data = await getAttendanceMonth(supabase, employeeId, month)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:attendance-tab", userId: viewer.id, role: viewer.role })
  }

  const sep = basePath.includes("?") ? "&" : "?"
  const prev = shiftMonth(month, -1)
  const next = shiftMonth(month, 1)
  const nav = (
    <div className="flex items-center gap-1">
      <Button asChild variant="ghost" size="icon-sm" aria-label={`Previous month, ${monthLabel(prev)}`}>
        <Link href={`${basePath}${sep}month=${prev}`} scroll={false}>
          <ChevronLeftIcon aria-hidden="true" />
        </Link>
      </Button>
      <span className="num min-w-20 text-center text-sm font-medium text-text">{monthLabel(month)}</span>
      {next <= current ? (
        <Button asChild variant="ghost" size="icon-sm" aria-label={`Next month, ${monthLabel(next)}`}>
          <Link href={`${basePath}${sep}month=${next}`} scroll={false}>
            <ChevronRightIcon aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <span aria-hidden="true" className="size-8" />
      )}
    </div>
  )

  if (!data) {
    return (
      <SectionCard title="Attendance" action={nav}>
        <ErrorBlock message={`Couldn't load the attendance for ${monthLabel(month)}.`} errorRef={ref} />
      </SectionCard>
    )
  }

  const s = data.summary
  return (
    <div className="flex flex-col gap-4">
      <KpiStrip
        aria-label={`Attendance in ${monthLabel(month)}`}
        items={[
          { label: "Present", value: s.present },
          { label: "Late login", value: s.lateLogin },
          { label: "Half days", value: s.halfDay },
          { label: "Absent", value: s.absent },
          { label: "On leave", value: s.onLeave },
          { label: "Active time", value: formatMinutes(s.workMinutes) },
        ]}
      />
      <SectionCard
        title="Calendar"
        description={`Working day starts ${data.calendar.attendance.workDayStart.slice(0, 5)}, ${data.calendar.attendance.lateGraceMinutes} minutes' grace; under ${formatMinutes(data.calendar.attendance.halfDayMinutes)} active is a half day.${canCorrect ? " Click a day to correct it." : ""}`}
        action={nav}
      >
        <AttendanceCalendar employeeId={employeeId} days={data.days} today={today} canCorrect={canCorrect} />
      </SectionCard>
    </div>
  )
}

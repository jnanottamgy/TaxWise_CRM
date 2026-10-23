import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { UsersRoundIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { formatDayMonth } from "@/lib/domain/leave"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { DateText } from "@/components/app/date-text"
import { getAbsentWithoutCover } from "@/lib/data/covers"

const SHOWN = 6

/**
 * Manager dashboard → Absent today without cover (§7.2, §4.7 "Where a cover is created"): people on
 * leave today, or not signed in by the start of the day + grace + 30 minutes, whose clients have
 * open tasks due within 2 days and no cover in force. Each has Set up cover, which opens People →
 * person → Cover their clients. Partners and Managers only (renders nothing for anyone else).
 * Never throws: a failed load renders an ErrorBlock with its Ref inside the card.
 *
 *   <AbsentWithoutCover user={user} supabase={supabase} />
 */
export default async function AbsentWithoutCover({ user, supabase, headingLevel = 2 }: { user: CurrentUser; supabase: ServerSupabase; headingLevel?: 2 | 3 }) {
  if (!can.manageCovers(user.role)) return null
  const title = "Absent today without cover"
  let data: Awaited<ReturnType<typeof getAbsentWithoutCover>>
  try {
    data = await getAbsentWithoutCover(supabase)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "component:absent-without-cover", userId: user.id })
    return (
      <SectionCard title={title} headingLevel={headingLevel}>
        <ErrorBlock message="Couldn't check who is away without cover." errorRef={ref} size="compact" />
      </SectionCard>
    )
  }

  const today = todayIST()
  const description = data.workingDay
    ? `On leave, or not signed in by ${data.cutoff}, with tasks due by ${formatDayMonth(data.dueBy)} and no cover.`
    : "Today isn't a working day."
  const rows = data.rows.slice(0, SHOWN)
  const more = data.rows.length - rows.length

  return (
    <SectionCard title={title} description={description} headingLevel={headingLevel} flush={rows.length > 0}>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">
          {data.workingDay ? "Everyone away today has cover, or nothing is due on their clients in the next two days." : "Nobody is expected in, so there is nothing to cover."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/70">
          {rows.map((r) => (
            <li key={r.employee_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 md:px-5">
              <div className="min-w-0">
                <Link href={`/people/${r.employee_id}`} className="text-base font-medium text-text underline-offset-2 hover:underline">
                  {r.full_name}
                </Link>
                <p className="text-sm text-text-muted">
                  {r.why === "on_leave" ? `On leave${r.leave_until && r.leave_until !== today ? ` until ${formatDayMonth(r.leave_until)}` : " today"}` : "Not signed in"}
                  {" · "}
                  <span className="num">
                    {r.due_tasks} {r.due_tasks === 1 ? "task" : "tasks"} on {r.clients} {r.clients === 1 ? "client" : "clients"}
                  </span>
                  {r.next_due ? (
                    <>
                      {", next "}
                      <DateText date={r.next_due} withRelative today={today} />
                    </>
                  ) : null}
                </p>
              </div>
              <Button asChild size="sm" variant="outline" className="pointer-coarse:h-11">
                <Link href={`/people/${r.employee_id}?tab=work&cover=new`}>
                  <UsersRoundIcon aria-hidden="true" />
                  Set up cover
                </Link>
              </Button>
            </li>
          ))}
          {more > 0 ? (
            <li className="px-4 py-2.5 text-sm text-text-muted md:px-5">
              And {more} more. Open each person from{" "}
              <Link href="/people" className="font-medium text-text underline-offset-2 hover:underline">
                People
              </Link>
              .
            </li>
          ) : null}
        </ul>
      )}
    </SectionCard>
  )
}

import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { getMyCovers } from "@/lib/data/covers"
import { CoverList } from "@/components/covers/cover-list"

/**
 * My day → Covering (§7.2, §4.7) for the signed-in person:
 *   - covers they hold now or soon, with the handover note, and a link to the clients they cover;
 *   - covers for them while they're away, with "I'm back, end cover";
 *   - covers they held that ended in the last 14 days with no note back yet ("Leave a note back").
 * Renders nothing when there is none of these, so My day stays quiet. Never throws: a failed load
 * renders an ErrorBlock with its Ref.
 */
export default async function MyCovers({ user, supabase }: { user: CurrentUser; supabase: ServerSupabase }) {
  if (user.role === "client" || !user.employeeId) return null
  let data: Awaited<ReturnType<typeof getMyCovers>>
  try {
    data = await getMyCovers(supabase, user)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "component:my-covers", userId: user.id })
    return (
      <SectionCard title="Covering">
        <ErrorBlock message="Couldn't load your covers." errorRef={ref} size="compact" />
      </SectionCard>
    )
  }
  const { covering, coveredFor, awaitingReturnNote } = data
  if (covering.length + coveredFor.length + awaitingReturnNote.length === 0) return null

  const viewer = { role: user.role, employeeId: user.employeeId }
  const inForce = covering.filter((c) => c.state === "in_force").length
  return (
    <SectionCard
      title="Covering"
      description={
        covering.length
          ? `You hold ${covering.length === 1 ? "one cover" : `${covering.length} covers`}${inForce !== covering.length ? ` (${inForce} in force now)` : ""}.`
          : coveredFor.length
            ? "Someone is covering your clients."
            : "Covers you held that have ended."
      }
      viewAll={covering.length ? { href: "/clients?covering=1", label: "Clients I'm covering" } : undefined}
    >
      <div className="flex flex-col gap-5">
        {covering.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text-muted">You cover</h3>
            <CoverList covers={covering} viewer={viewer} emptyText="None." />
          </div>
        ) : null}
        {coveredFor.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text-muted">Covering for you</h3>
            <CoverList covers={coveredFor} viewer={viewer} emptyText="None." />
          </div>
        ) : null}
        {awaitingReturnNote.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text-muted">Ended: leave a note back</h3>
            <p className="text-sm text-text-muted">
              A line on what you did and what&apos;s left helps them pick up. It&apos;s optional.{" "}
              <Link href={`/people/${user.employeeId}?tab=work`} className="font-medium text-text underline-offset-2 hover:underline">
                See all your covers
              </Link>
            </p>
            <CoverList covers={awaitingReturnNote} viewer={viewer} emptyText="None." />
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}

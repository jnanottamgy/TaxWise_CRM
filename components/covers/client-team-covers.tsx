import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { ErrorBlock } from "@/components/app/error-block"
import { getCoversForClient } from "@/lib/data/covers"
import { getEmployeeNames } from "@/lib/data/people"
import { CoverList } from "@/components/covers/cover-list"
import { AddCoverButton } from "@/components/covers/add-cover-button"

/**
 * Client 360 → Profile & contacts → Team → cover access (§4.7). The covers that reach this client,
 * in force and scheduled: client covers for it, and person covers for its owner or anyone on its
 * team. Partners and Managers get Add cover, Extend and End now; the absent person "I'm back, end
 * cover"; a cover person whose cover ended leaves a note back. Covers that ended in the last 30
 * days are listed below, folded.
 *
 * Reads under the viewer's RLS (Employees see only covers they are part of). Never throws: a
 * failed load renders an ErrorBlock with its Ref.
 */
export default async function ClientTeamCovers({ clientId, user, supabase }: { clientId: string; user: CurrentUser; supabase: ServerSupabase }) {
  const manager = can.managePeople(user.role)
  let data: Awaited<ReturnType<typeof getCoversForClient>>
  let clientName = "this client"
  let ownerName: string | null = null
  try {
    const [covers, client] = await Promise.all([getCoversForClient(supabase, clientId), supabase.from("clients").select("display_name").eq("id", clientId).maybeSingle()])
    if (client.error) throw client.error
    data = covers
    clientName = client.data?.display_name ?? clientName
    if (covers.ownerEmployeeId) ownerName = (await getEmployeeNames(supabase, [covers.ownerEmployeeId])).get(covers.ownerEmployeeId) ?? null
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "component:client-team-covers", userId: user.id, clientId })
    return <ErrorBlock message="Couldn't load this client's covers." errorRef={ref} size="compact" />
  }

  const viewer = { role: user.role, employeeId: user.employeeId }
  const headingId = `client-covers-${clientId}`
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-base font-semibold text-text">
            Cover access
          </h3>
          <p className="text-sm text-text-muted">
            {manager
              ? "Let someone work on this client while the person on it is away. Access ends by itself at Until."
              : "Who works on this client while the person on it is away."}
          </p>
        </div>
        {manager ? (
          <AddCoverButton target={{ kind: "client", clientId, clientName, ownerEmployeeId: data.ownerEmployeeId, ownerName }} actorRole={user.role} />
        ) : null}
      </div>
      <CoverList
        covers={data.live}
        viewer={viewer}
        perspective="client"
        emptyText={manager ? "No cover in force or scheduled. Add one when someone on this client is away." : "No cover in force or scheduled."}
      />
      {data.recent.length ? (
        <details className="group rounded-md border border-border">
          <summary className="cursor-pointer list-none rounded-md px-3 py-2 text-sm font-medium text-text-muted select-none hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="mr-1.5 inline-block transition-transform group-open:rotate-90">
              ›
            </span>
            Ended in the last 30 days ({data.recent.length})
          </summary>
          <div className="border-t border-border px-3 py-3">
            <CoverList covers={data.recent} viewer={viewer} perspective="client" emptyText="None." />
          </div>
        </details>
      ) : null}
    </section>
  )
}

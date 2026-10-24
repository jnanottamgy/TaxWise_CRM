import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { PlusIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { isManagerOrPartner } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { parseTableParams } from "@/components/app/data-table/params"
import { listLetters, type LetterRow } from "@/lib/data/engagement-letters"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { LettersTable } from "@/components/engagement-letters/letters-table"

const LIMIT = 50

/**
 * A client's engagement letters (§7.15.3), for Client 360 → Engagement (owned by the quality
 * module, which renders this): every letter of the client, newest first, whether the FY in the top
 * bar has a letter Issued or Signed, and New letter (prefilled with the client's services). Partners
 * and Managers only: an Employee gets nothing (§4.1), and RLS returns no rows to them anyway.
 *
 *   <EngagementLettersList clientId={clientId} user={user} supabase={supabase} />
 */
export async function EngagementLettersList({ clientId, user, supabase }: { clientId: string; user: CurrentUser; supabase: ServerSupabase }) {
  if (!isManagerOrPartner(user.role)) return null
  const today = todayIST()
  const fy = await getSelectedFy()
  const t = parseTableParams({}, { defaultSort: { sort: "financial_year", dir: "desc" } })

  let rows: LetterRow[] = []
  let total = 0
  let services = 0
  let ref: string | null = null
  try {
    const [page, svc] = await Promise.all([
      listLetters(supabase, { ...t, sort: "financial_year", dir: "desc", page: 1, pageSize: LIMIT as 50, from: 0, to: LIMIT - 1 }, { fy: null, clientId }),
      supabase.from("client_services").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("is_active", true),
    ])
    if (svc.error) throw svc.error
    rows = page.rows
    total = page.total
    services = svc.count ?? 0
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "client360:engagement-letters", userId: user.id, role: user.role, clientId })
  }

  const covered = rows.some((r) => r.financial_year === fy && (r.status === "issued" || r.status === "signed"))
  const draft = rows.find((r) => r.financial_year === fy && r.status === "draft")
  const newHref = `/engagement-letters/new?client=${clientId}&fy=${fy}`

  return (
    <section aria-labelledby="client-letters-title" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="client-letters-title" className="text-md leading-6 font-semibold text-text">
            Engagement letters
          </h2>
          <p className="text-sm text-text-muted">The terms agreed for each FY: SA 210 for audits, a services schedule with fees for other work.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {total > rows.length ? (
            <Link href={`/engagement-letters?client=${clientId}&year=all`} className="text-sm text-primary hover:underline">
              All {total} letters
            </Link>
          ) : null}
          <Button asChild variant="outline">
            <Link href={newHref}>
              <PlusIcon aria-hidden="true" />
              New letter
            </Link>
          </Button>
        </div>
      </div>
      {!ref && services > 0 && !covered ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-text">
          {draft ? (
            <>
              The FY {fy} letter is still a draft.{" "}
              <Link href={`/engagement-letters/${draft.id}`} className="text-primary hover:underline">
                Issue it
              </Link>
              .
            </>
          ) : (
            <>
              No letter issued or signed for FY {fy}, and the client has active services.{" "}
              <Link href={newHref} className="text-primary hover:underline">
                Draft the letter
              </Link>
              .
            </>
          )}
        </p>
      ) : null}
      {ref ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this client's engagement letters." errorRef={ref} />
        </div>
      ) : (
        <LettersTable
          rows={rows}
          total={rows.length}
          page={1}
          pageSize={LIMIT}
          sort={null}
          dir="desc"
          today={today}
          showClient={false}
          compact
          emptyMessage="No engagement letters for this client yet."
          emptyAction={null}
        />
      )}
    </section>
  )
}

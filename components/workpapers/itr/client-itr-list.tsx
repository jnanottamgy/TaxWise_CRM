import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { CalculatorIcon, PlusIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { taxYearLabel } from "@/lib/domain/fy"
import { REGIME_LABEL } from "@/lib/schemas/itr"
import { isItrEligible, listClientItrComputations, type ItrListRow } from "@/lib/data/itr"
import { formatCount } from "@/components/app/data-table/params"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { BalanceText, ItrStatusChip, TaxFigure } from "@/components/workpapers/itr/itr-ui"

/**
 * Client 360 → Workpapers → ITR computations (§7.3.3, §7.8.2): the client's computations, newest
 * year first (at most six), with the status, the recommended regime and the saving, and the
 * balance. Only individuals and HUFs get a "New computation". Under the viewer's RLS (Employees:
 * their own clients, §4.1). Never throws: a failed load shows its Ref inside the card.
 */
export async function ClientItrList({ clientId, user, supabase, limit = 6 }: { clientId: string; user: CurrentUser; supabase: ServerSupabase; limit?: number }) {
  let page: { rows: ItrListRow[]; total: number } | null = null
  let eligible = false
  let ref: string | null = null
  try {
    const [list, client] = await Promise.all([
      listClientItrComputations(supabase, clientId, limit),
      supabase.from("clients").select("entity_type, pan").eq("id", clientId).maybeSingle(),
    ])
    if (client.error) throw client.error
    page = list
    eligible = client.data ? isItrEligible(client.data.entity_type, client.data.pan) : false
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "client360:workpapers:itr", userId: user.id })
  }
  const newHref = `/workpapers/itr/new?client=${clientId}`
  return (
    <SectionCard
      title="ITR computations"
      description={eligible ? "Both regimes compared, by year." : "For individuals and HUFs."}
      action={
        eligible ? (
          <Button asChild size="sm" variant="outline">
            <Link href={newHref}>
              <PlusIcon aria-hidden="true" />
              New computation
            </Link>
          </Button>
        ) : null
      }
      viewAll={page && page.total > page.rows.length ? { href: `/workpapers/itr?client=${clientId}&fy=all`, label: `View all ${formatCount(page.total)}` } : undefined}
      flush
    >
      {ref ? (
        <ErrorBlock message="Couldn't load this client's ITR computations." errorRef={ref} size="compact" />
      ) : !page || page.rows.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState
            size="compact"
            icon={<CalculatorIcon />}
            message={eligible ? "No computations yet. Start one to compare the regimes for this client." : "This client isn't an individual or a HUF, so it has no ITR computation here."}
          />
        </div>
      ) : (
        <ul>
          {page.rows.map((r) => (
            <li key={r.id} className="border-t border-border first:border-t-0">
              <Link
                href={`/workpapers/itr/${r.id}`}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
              >
                <span className="flex min-w-0 flex-col leading-5">
                  <span className="text-base text-text">
                    {r.year_label ?? taxYearLabel(r.financial_year)}
                    {r.label ? <span className="text-text-muted"> · {r.label}</span> : null}
                  </span>
                  <span className="text-xs text-text-muted">
                    {r.recommended_regime ? (
                      <>
                        {REGIME_LABEL[r.recommended_regime]} recommended
                        {r.saving_paise ? (
                          <>
                            {", saves "}
                            <TaxFigure value={r.saving_paise} />
                          </>
                        ) : null}
                      </>
                    ) : (
                      "Not computed"
                    )}
                    {r.regime_chosen ? ` · chosen: ${REGIME_LABEL[r.regime_chosen].toLowerCase()}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-4">
                  <BalanceText balance={r.balance_paise} />
                  <ItrStatusChip status={r.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { GitCompareArrowsIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { defaultPeriod, periodLongLabel } from "@/lib/schemas/gst-recon"
import { listClientRuns, type Page, type RunListRow } from "@/lib/data/gst-recon"
import { formatCount } from "@/components/app/data-table/params"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { RunStateChip } from "@/components/workpapers/recon/runs-table"

/**
 * Client 360 → Workpapers → GST reconciliation (§7.3.3, §7.8.1): the client's latest run of each
 * month, newest first (at most six), with what is open and at risk, and "Reconcile" for the next
 * month. Under the viewer's RLS (Employees: their own clients, §4.1). Never throws: a failed load
 * shows its Ref inside the card.
 */
export async function ClientReconList({ clientId, user, supabase, limit = 6 }: { clientId: string; user: CurrentUser; supabase: ServerSupabase; limit?: number }) {
  let page: Page<RunListRow> | null = null
  let ref: string | null = null
  try {
    page = await listClientRuns(supabase, clientId, limit)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "client360:workpapers:gst-recon", userId: user.id })
  }
  const next = defaultPeriod(todayIST())
  const newHref = `/workpapers/gst-recon?new=1&client=${clientId}&period=${next}`
  return (
    <SectionCard
      title="GST reconciliation"
      description="GSTR-2B against the purchase register, month by month."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href={newHref}>
            <GitCompareArrowsIcon aria-hidden="true" />
            Reconcile
          </Link>
        </Button>
      }
      viewAll={page && page.total > page.rows.length ? { href: `/workpapers/gst-recon?client=${clientId}`, label: `View all ${formatCount(page.total)}` } : undefined}
      flush
    >
      {ref ? (
        <ErrorBlock message="Couldn't load this client's reconciliations." errorRef={ref} size="compact" />
      ) : !page || page.rows.length === 0 ? (
        <EmptyState size="compact" icon={<GitCompareArrowsIcon />} message={`No reconciliations for this client yet. Start with ${periodLongLabel(next)}.`} />
      ) : (
        <ul>
          {page.rows.map((r) => (
            <li key={r.id} className="border-t border-border first:border-t-0">
              <Link
                href={`/workpapers/gst-recon/${r.id}`}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
              >
                <span className="flex min-w-0 flex-col leading-5">
                  <span className="text-base text-text">{periodLongLabel(r.period)}</span>
                  <span className="text-xs text-text-muted">
                    {formatCount(r.matched_count)} matched · {formatCount(r.open_count)} open
                  </span>
                </span>
                <span className="flex items-center gap-4">
                  <span className="flex flex-col items-end leading-5">
                    <PaiseAmount value={r.itc_at_risk_paise} />
                    <span className="text-xs text-text-muted">at risk</span>
                  </span>
                  <RunStateChip row={r} plain />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

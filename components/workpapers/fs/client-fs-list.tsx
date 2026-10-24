import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FileSpreadsheetIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { financialYearOf, previousFinancialYear, todayIST } from "@/lib/domain/fy"
import { listClientStatements, type Page, type StatementListRow } from "@/lib/data/financial-statements"
import { formatCount } from "@/components/app/data-table/params"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { ChecksCell, FsStatusChip } from "@/components/workpapers/fs/statements-table"

/**
 * Client 360 → Workpapers → Financial statements (§7.3.3, §7.8.3): the client's statements, latest
 * year first (at most six), with the status, the checks and the profit, and "New statement" for the
 * year being prepared. Under the viewer's RLS (Employees: their own clients, §4.1). Never throws: a
 * failed load shows its Ref inside the card.
 */
export async function ClientFsList({ clientId, user, supabase, limit = 6 }: { clientId: string; user: CurrentUser; supabase: ServerSupabase; limit?: number }) {
  let page: Page<StatementListRow> | null = null
  let ref: string | null = null
  try {
    page = await listClientStatements(supabase, clientId, limit)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "client360:workpapers:financial-statements", userId: user.id })
  }
  const preparing = previousFinancialYear(financialYearOf(todayIST()))
  const hasPreparing = page?.rows.some((r) => r.financial_year === preparing) ?? false
  return (
    <SectionCard
      title="Financial statements"
      description="Schedule III balance sheet and profit and loss from the trial balance."
      action={
        !hasPreparing ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/workpapers/financial-statements?new=1&client=${clientId}`}>
              <FileSpreadsheetIcon aria-hidden="true" />
              New statement
            </Link>
          </Button>
        ) : undefined
      }
      viewAll={page && page.total > page.rows.length ? { href: `/workpapers/financial-statements?client=${clientId}`, label: `View all ${formatCount(page.total)}` } : undefined}
      flush
    >
      {ref ? (
        <ErrorBlock message="Couldn't load this client's financial statements." errorRef={ref} size="compact" />
      ) : !page || page.rows.length === 0 ? (
        <EmptyState size="compact" icon={<FileSpreadsheetIcon />} message={`No financial statements for this client yet. Start with FY ${preparing} from its trial balance.`} />
      ) : (
        <ul>
          {page.rows.map((r) => (
            <li key={r.id} className="border-t border-border first:border-t-0">
              <Link
                href={`/workpapers/financial-statements/${r.id}`}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
              >
                <span className="flex min-w-0 flex-col leading-5">
                  <span className="num text-base text-text">FY {r.financial_year}</span>
                  <ChecksCell row={r} plain />
                </span>
                <span className="flex items-center gap-4">
                  <span className="flex flex-col items-end leading-5">
                    <PaiseAmount value={r.profit_paise} brackets compact />
                    <span className="text-xs text-text-muted">{r.profit_paise !== null && r.profit_paise < 0 ? "loss" : "profit"}</span>
                  </span>
                  <FsStatusChip status={r.status} plain />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

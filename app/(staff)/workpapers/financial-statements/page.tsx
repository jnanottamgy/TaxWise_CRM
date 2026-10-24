import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { XIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { financialYearOf, isFinancialYear, previousFinancialYear, recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { FS_LIST_DEFAULT_SORT, FS_LIST_FILTERS, FS_LIST_SORTABLE, FS_STATUSES, FS_STATUS_META, yearEndedLabel } from "@/lib/schemas/financial-statements"
import { listStatements, statementCounts } from "@/lib/data/financial-statements"
import { getReconClient } from "@/lib/data/gst-recon"
import { formatCount, parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { PageGuide } from "@/components/shell/page-slots"
import { StatementsTable } from "@/components/workpapers/fs/statements-table"
import { NewStatementButton } from "@/components/workpapers/fs/new-statement-wizard"

export const metadata: Metadata = { title: "Financial statements" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALL_YEARS = "all"

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/workpapers/financial-statements:${source}`, userId }) }
  }
}

/**
 * Financial statements (§6.13, §7.8.3): "Whose accounts are ready, and whose checks still fail?"
 * The year's counts lead (by default the year whose accounts are being prepared now: the last
 * completed FY), then every statement, searched, filtered and sorted in SQL. Any staff member;
 * Employees see their own clients only (§4.1, RLS). `?new=1&client=…` opens the new-statement
 * wizard (Client 360 links here).
 */
export default async function FinancialStatementsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const today = todayIST()
  const t = parseTableParams(sp, { sortable: FS_LIST_SORTABLE, defaultSort: FS_LIST_DEFAULT_SORT, filters: FS_LIST_FILTERS })
  const fyParam = readParam(sp, "fy")
  const preparing = previousFinancialYear(financialYearOf(today))
  const listFy = fyParam && isFinancialYear(fyParam) ? fyParam : null
  const countsFy = listFy ?? preparing
  const clientId = t.filters.client?.[0] && UUID.test(t.filters.client[0]) ? t.filters.client[0] : null
  const newParam = readParam(sp, "new") === "1"
  const newClient = readParam(sp, "client")

  const [list, counts, client] = await Promise.all([
    attempt("list", user.id, () => listStatements(supabase, t, { fy: listFy, clientId })),
    attempt("counts", user.id, () => statementCounts(supabase, countsFy)),
    clientId || (newParam && newClient && UUID.test(newClient)) ? attempt("client", user.id, () => getReconClient(supabase, (clientId ?? newClient) as string)) : Promise.resolve(null),
  ])
  const scopedClient = client && client.ok ? client.data : null
  const years = recentFinancialYears(today, 8)

  const filters: FilterDef[] = [
    { id: "fy", label: "FY", multi: false, options: [...years.map((y) => ({ value: y, label: `FY ${y}` })), { value: ALL_YEARS, label: "All years" }] },
    { id: "status", label: "Status", options: FS_STATUSES.map((s) => ({ value: s, label: FS_STATUS_META[s].label, tone: FS_STATUS_META[s].tone })) },
    { id: "checks", label: "Checks", multi: false, options: [{ value: "failing", label: "Checks fail" }, { value: "passing", label: "Checks pass" }] },
  ]
  const c = counts.ok ? counts.data : null
  const scope = listFy ? `FY ${listFy}` : "All years"
  const description = list.ok
    ? `${scope} · ${formatCount(list.data.total)} ${list.data.total === 1 ? "statement" : "statements"}${scopedClient && clientId ? ` for ${scopedClient.name}` : ""}`
    : "Schedule III balance sheets and profit and loss statements from each client's trial balance."
  const fyHref = (extra: Record<string, string[]>) => tableHref("/workpapers/financial-statements", { filters: extra }, { fy: countsFy })

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Financial statements">
        <p>Upload the client&apos;s trial balance, map its columns once, and every ledger is mapped to a Schedule III line: what this client chose before first, then keywords in the ledger name, then the TB group. Fix the unmapped ones and clear the checks.</p>
        <p className="mt-2">Comparatives come from last year&apos;s saved statement. Draft, then Reviewed by someone other than the preparer, then Final (a Manager or Partner, every check passing). A final statement is locked.</p>
      </PageGuide>
      <PageHeader
        title="Financial statements"
        description={description}
        actions={
          <NewStatementButton
            years={years}
            defaultFy={preparing}
            autoOpen={newParam}
            initialClient={scopedClient ? { id: scopedClient.id, label: `${scopedClient.name} · ${scopedClient.code}` } : null}
          />
        }
      />

      <KpiStrip
        lead
        className="mb-4"
        aria-label={`FY ${countsFy}`}
        items={[
          { label: `FY ${countsFy} statements`, value: c ? formatCount(c.total) : "—", sub: c ? `Year ended ${yearEndedLabel(countsFy)}` : "Couldn't load", href: fyHref({}) },
          { label: "Final", value: c ? formatCount(c.final) : "—", sub: c ? (c.total ? `${formatCount(c.total - c.final)} not final yet` : "None yet") : "Couldn't load", href: fyHref({ status: ["final"] }) },
          { label: "Reviewed", value: c ? formatCount(c.reviewed) : "—", sub: c ? "Waiting for a Manager or Partner" : "Couldn't load", href: fyHref({ status: ["reviewed"] }) },
          { label: "Checks failing", value: c ? formatCount(c.failing) : "—", sub: c ? (c.failing ? "Not final, a check fails" : "Every open statement passes") : "Couldn't load", href: fyHref({ checks: ["failing"] }) },
        ]}
      />

      <FilterBar searchLabel="Search statements" searchPlaceholder="Client name or code" filters={filters} />

      {scopedClient && clientId ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-muted">Client</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-text">
            {scopedClient.name}
            <Link
              href={tableHref("/workpapers/financial-statements", { filters: { client: null } }, sp)}
              aria-label="Show every client's statements"
              className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </span>
        </div>
      ) : null}

      {list.ok ? (
        <StatementsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the financial statements." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

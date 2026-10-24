import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { isFinancialYear, previousFinancialYear, taxYearLabel, todayIST } from "@/lib/domain/fy"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { ITR_LIST_FILTERS, ITR_LIST_SORTABLE, ITR_STATUSES, ITR_STATUS_INFO, REGIME_LABEL } from "@/lib/schemas/itr"
import { getItrStatusCounts, listItrComputations } from "@/lib/data/itr"
import { formatCount, parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Button } from "@/components/ui/button"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { ClientScopeChip } from "@/components/workpapers/notices/client-scope-chip"
import { ItrTable } from "@/components/workpapers/itr/itr-table"

export const metadata: Metadata = { title: "ITR computation" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/workpapers/itr:${source}`, userId }) }
  }
}

const ALL_YEARS = "all"

/**
 * ITR computations (§7.8.2): "Which computations need a review or a final sign-off?" The figures
 * lead (drafts, reviewed and waiting for a Manager or Partner, final), then the register: searched,
 * filtered and sorted in SQL. Every staff member who can see the client (Employees: their own
 * clients, §4.1, RLS); a client's tax is not the firm's fee, so nothing here is money-side.
 */
export default async function ItrListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: ITR_LIST_SORTABLE, defaultSort: { sort: "updated_at", dir: "desc" }, filters: ITR_LIST_FILTERS })
  const today = todayIST()
  const selectedFy = await getSelectedFy()
  const fyParam = readParam(sp, "fy")
  const fy = fyParam === ALL_YEARS ? null : fyParam && isFinancialYear(fyParam) ? fyParam : selectedFy
  const clientId = t.filters.client?.[0] ?? null

  const [list, counts, client] = await Promise.all([
    attempt("list", user.id, () => listItrComputations(supabase, t, { fy, viewerId: user.id })),
    attempt("counts", user.id, () => getItrStatusCounts(supabase, fy)),
    clientId
      ? attempt("client", user.id, async () => {
          const { data, error } = await supabase.from("clients").select("display_name, client_code").eq("id", clientId).maybeSingle()
          if (error) throw error
          return data ? `${data.client_code} · ${data.display_name}` : null
        })
      : Promise.resolve(null),
  ])

  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: ITR_STATUSES.map((s) => ({ value: s, label: ITR_STATUS_INFO[s].label, tone: ITR_STATUS_INFO[s].tone })) },
    {
      id: "fy",
      label: "Year",
      multi: false,
      options: [...fyOptions(today).map((y) => ({ value: y, label: `FY ${y} · ${taxYearLabel(y)}` })), { value: ALL_YEARS, label: "All years" }],
    },
    { id: "regime", label: "Regime", options: (["new", "old"] as const).map((r) => ({ value: r, label: REGIME_LABEL[r] })) },
    { id: "mine", label: "Prepared by me", multi: false, options: [{ value: "1", label: "Prepared by me" }] },
  ]

  const scope = fy ? `FY ${fy} (${taxYearLabel(fy)})` : "All years"
  const description = list.ok ? `${scope} · ${formatCount(list.data.total)} ${list.data.total === 1 ? "computation" : "computations"}` : "Both regimes side by side for individuals and HUFs."
  const newHref = clientId ? `/workpapers/itr/new?client=${clientId}` : "/workpapers/itr/new"
  // Nothing in this year: say so, and offer the year before (the returns being filed now).
  const earlier = fy ? previousFinancialYear(fy) : null
  const emptyYear = fy && earlier ? { label: scope, other: { label: `FY ${earlier} (${taxYearLabel(earlier)})`, href: tableHref("/workpapers/itr", { page: 1 }, { ...sp, fy: earlier }) } } : null
  const href = (status: string) => tableHref("/workpapers/itr", { filters: { status: [status] }, page: 1 }, sp)
  const c = counts.ok ? counts.data : null

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={[{ label: "Workpapers", href: "/workpapers" }, { label: "ITR computation" }]} />
      <PageGuide title="ITR computation">
        <p>
          Each computation works out the tax under both regimes from the same inputs and recommends the cheaper one. The figures are computed on the server with the rule set for the year on the Law &amp; rules
          page, every time you save.
        </p>
        <p className="mt-2">
          A draft is reviewed by someone other than the preparer, who records the regime chosen; a Manager or Partner then marks it Final, which locks it. Years up to FY 2025-26 show the assessment year (AY);
          from FY 2026-27 they show the tax year under the Income-tax Act, 2025.
        </p>
      </PageGuide>
      <PageHeader
        title="ITR computation"
        description={description}
        actions={
          <Button asChild>
            <Link href={newHref}>
              <PlusIcon aria-hidden="true" />
              New computation
            </Link>
          </Button>
        }
      />

      <KpiStrip
        className="mb-4"
        items={[
          { label: "Drafts", value: c ? formatCount(c.draft) : "—", sub: c ? (c.draft ? "Being prepared" : "None open") : "Couldn't load", href: href("draft") },
          {
            label: "Reviewed",
            value: c ? formatCount(c.reviewed) : "—",
            sub: c ? (c.reviewed ? "Waiting for a Manager or Partner to mark final" : "Nothing waiting") : "Couldn't load",
            href: href("reviewed"),
          },
          { label: "Final", value: c ? formatCount(c.final) : "—", sub: c ? scope : "Couldn't load", href: href("final") },
        ]}
      />

      <FilterBar searchLabel="Search computations" searchPlaceholder="Client, code, PAN or name" filters={filters} />

      {clientId ? (
        <ClientScopeChip name={client && client.ok && client.data ? client.data : "This client"} clearHref={tableHref("/workpapers/itr", { filters: { client: null } }, sp)} />
      ) : null}

      {list.ok ? (
        <ItrTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} newHref={newHref} emptyYear={emptyYear} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the computations." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

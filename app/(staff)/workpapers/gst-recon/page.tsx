import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { XIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { RUN_LIST_DEFAULT_SORT, RUN_LIST_FILTERS, RUN_LIST_SORTABLE, defaultPeriod, isPeriod, periodChoices, periodLongLabel } from "@/lib/schemas/gst-recon"
import { getReconClient, listRuns, monthTotals } from "@/lib/data/gst-recon"
import { formatCount, parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { PageGuide } from "@/components/shell/page-slots"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { RunsTable } from "@/components/workpapers/recon/runs-table"
import { NewReconButton } from "@/components/workpapers/recon/new-recon-wizard"

export const metadata: Metadata = { title: "GST reconciliation" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/workpapers/gst-recon:${source}`, userId }) }
  }
}

/**
 * GST reconciliation (§6.12, §7.8.1): "Whose ITC is at risk this month, and who isn't reconciled
 * yet?" The month's figures lead (over the latest run of each client), then every run, searched,
 * filtered and sorted in SQL: the latest run of each client and month, or the whole history. Any
 * staff member; Employees see their own clients only (§4.1, RLS). `?new=1&client=…&period=…`
 * opens the new-reconciliation wizard (Client 360 and a run's "Reconcile next month" link here).
 */
export default async function GstReconPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const today = todayIST()
  const t = parseTableParams(sp, { sortable: RUN_LIST_SORTABLE, defaultSort: RUN_LIST_DEFAULT_SORT, filters: RUN_LIST_FILTERS })
  const periodFilter = t.filters.period?.[0]
  const month = periodFilter && isPeriod(periodFilter) ? periodFilter : defaultPeriod(today)
  const clientId = t.filters.client?.[0] && UUID.test(t.filters.client[0]) ? t.filters.client[0] : null
  const newParam = readParam(sp, "new") === "1"
  const newClient = readParam(sp, "client")
  const newPeriod = readParam(sp, "period")

  const [list, totals, client] = await Promise.all([
    attempt("list", user.id, () => listRuns(supabase, t, { clientId })),
    attempt("totals", user.id, () => monthTotals(supabase, month)),
    clientId ? attempt("client", user.id, () => getReconClient(supabase, clientId)) : Promise.resolve(null),
  ])
  const scopedClient = client && client.ok ? client.data : null

  const filters: FilterDef[] = [
    { id: "period", label: "Month", multi: false, options: periodChoices(today) },
    { id: "open", label: "Open lines", multi: false, options: [{ value: "1", label: "Has open lines" }] },
    { id: "gstin", label: "GSTIN", multi: false, options: [{ value: "mismatch", label: "2B GSTIN differs from the client's" }] },
    { id: "history", label: "Runs", multi: false, options: [{ value: "1", label: "Include earlier runs" }] },
  ]

  const m = totals.ok ? totals.data : null
  const description = list.ok
    ? `${formatCount(list.data.total)} ${list.data.total === 1 ? "reconciliation" : "reconciliations"}${scopedClient ? ` for ${scopedClient.name}` : ""}${t.filters.history ? ", with earlier runs" : ""}`
    : "GSTR-2B against each client's purchase register, month by month."

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="GST reconciliation">
        <p>Upload the client&apos;s GSTR-2B JSON and purchase register, map the register&apos;s columns once, and run. Documents are matched per supplier on the number, then the number written differently, then amount and date.</p>
        <p className="mt-2">Not in 2B is ITC at risk: the supplier hasn&apos;t reported it, so follow up. Not in books is unclaimed ITC: book it, or reject it on the IMS. Open lines carry into the next month until they are settled, ignored or cleared by a later GSTR-2B.</p>
        <p className="mt-2">The figures at the top are for one month, over each client&apos;s latest run. Running a month again keeps the earlier run in the history.</p>
      </PageGuide>
      <PageHeader
        title="GST reconciliation"
        description={description}
        actions={
          <NewReconButton
            today={today}
            autoOpen={newParam}
            initial={{
              clientId: newParam && newClient && UUID.test(newClient) ? newClient : (scopedClient?.id ?? null),
              clientLabel: newParam && newClient && UUID.test(newClient) ? null : scopedClient ? `${scopedClient.name} · ${scopedClient.code}` : null,
              period: newParam && newPeriod && isPeriod(newPeriod) ? newPeriod : month,
            }}
          />
        }
      />

      <KpiStrip
        lead
        className="mb-4"
        aria-label={`Figures for ${periodLongLabel(month)}`}
        items={[
          {
            label: `ITC at risk · ${periodLongLabel(month)}`,
            value: m ? <PaiseAmount value={m.itcAtRisk} compact /> : "—",
            sub: m ? (m.itcAtRisk > 0 ? "Booked, not yet in suppliers' returns" : "Nothing at risk") : "Couldn't load",
            href: tableHref("/workpapers/gst-recon", { filters: { period: [month], open: ["1"] }, sort: "itc_at_risk_paise", dir: "desc" }),
          },
          {
            label: "Unclaimed ITC",
            value: m ? <PaiseAmount value={m.unclaimedItc} compact /> : "—",
            sub: m ? "In GSTR-2B, not yet booked" : "Couldn't load",
            href: tableHref("/workpapers/gst-recon", { filters: { period: [month] }, sort: "unclaimed_itc_paise", dir: "desc" }),
          },
          {
            label: "Clients reconciled",
            value: m ? `${formatCount(m.reconciled)}${m.gstClients ? ` /${formatCount(m.gstClients)}` : ""}` : "—",
            sub: m ? (m.gstClients > m.reconciled ? `${formatCount(m.gstClients - m.reconciled)} GST clients still to do` : m.gstClients ? "Every GST client is done" : "No GST-registered clients") : "Couldn't load",
            href: tableHref("/workpapers/gst-recon", { filters: { period: [month] } }),
          },
          {
            label: "Open lines",
            value: m ? formatCount(m.openLines) : "—",
            sub: m ? (m.gstinMismatch ? `${m.gstinMismatch} with a GSTIN that differs` : "Carried into next month if not settled") : "Couldn't load",
            href: tableHref("/workpapers/gst-recon", { filters: { period: [month], open: ["1"] } }),
          },
        ]}
      />

      <FilterBar searchLabel="Search reconciliations" searchPlaceholder="Client, code or GSTIN" filters={filters} />

      {scopedClient ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-muted">Client</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-text">
            {scopedClient.name}
            <Link
              href={tableHref("/workpapers/gst-recon", { filters: { client: null } }, sp)}
              aria-label="Show every client's reconciliations"
              className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </span>
        </div>
      ) : null}

      {list.ok ? (
        <RunsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the reconciliations." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

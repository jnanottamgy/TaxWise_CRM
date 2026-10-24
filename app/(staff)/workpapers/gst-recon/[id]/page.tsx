import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { AlertTriangleIcon, FileDownIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDate } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import {
  ENTRY_DEFAULT_SORT,
  ENTRY_FILTERS,
  ENTRY_SORTABLE,
  IMS_ACTIONS,
  IMS_META,
  RESOLUTION_META,
  RECON_RESOLUTIONS,
  SUPPLIER_DEFAULT_SORT,
  SUPPLIER_FILTERS,
  SUPPLIER_SORTABLE,
  isRunTab,
  periodLabel,
  periodLongLabel,
  periodOf,
  shiftPeriod,
  periodSortKey,
  type RunTab,
} from "@/lib/schemas/gst-recon"
import { IMS_DEEMED_ACCEPTANCE_NOTE } from "@/lib/domain/recon"
import { getFollowUpContext, getRunDetail, listClearedLines, listRunLines, listRunSuppliers, type LineScope, type RunDetail } from "@/lib/data/gst-recon"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { Button } from "@/components/ui/button"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { RunTabs } from "@/components/workpapers/recon/run-tabs"
import { RunFigures, RunSummary } from "@/components/workpapers/recon/run-summary"
import { LinesTable, type LinesKind } from "@/components/workpapers/recon/lines-table"
import { SuppliersTable } from "@/components/workpapers/recon/suppliers-table"
import { RunStateChip } from "@/components/workpapers/recon/runs-table"
import { NewReconButton } from "@/components/workpapers/recon/new-recon-wizard"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { readEntryData } from "@/lib/schemas/gst-recon"

type Params = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "GST reconciliation" }
    const s = await getSession()
    if (s.status !== "ok" || s.user.role === "client") return { title: "GST reconciliation" }
    const { data } = await s.supabase.from("gst_recon_runs_list").select("client_name, period").eq("id", id).maybeSingle()
    return { title: data ? `${data.client_name} · ${periodLabel(String(data.period))}` : "GST reconciliation" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "GST reconciliation" }
  }
}

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/workpapers/gst-recon/[id]:${source}`, userId }) }
  }
}

function Failed({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

const LINE_TABS: Partial<Record<RunTab, { kind: LinesKind; scope: LineScope; label: string }>> = {
  mismatch: { kind: "mismatch", scope: { kind: "bucket", bucket: "mismatch" }, label: "mismatched documents" },
  missing_in_2b: { kind: "missing_in_2b", scope: { kind: "bucket", bucket: "missing_in_2b" }, label: "documents not in GSTR-2B" },
  missing_in_books: { kind: "missing_in_books", scope: { kind: "bucket", bucket: "missing_in_books" }, label: "documents not in the books" },
  matched: { kind: "matched", scope: { kind: "bucket", bucket: "matched" }, label: "matched documents" },
  ims: { kind: "ims", scope: { kind: "ims" }, label: "the IMS action list" },
  carried: { kind: "carried", scope: { kind: "carried" }, label: "the lines carried forward" },
}

/**
 * One GST reconciliation run (§7.8.1): "What's at risk, and whom do we chase?" The ITC figures
 * lead, then the tabs: the summary, each bucket's lines (sortable, paged in SQL, resolved with
 * notes), the supplier roll-up with the follow-up hand-off, the IMS action list and what carried
 * forward. Export to Excel, run the month again, or reconcile the next month. Any staff member who
 * can see the client (Employees: their own, §4.1); a run of another client is a 404 (RLS).
 */
export default async function GstReconRunPage({ params, searchParams }: Params) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const sp = await searchParams
  const today = todayIST()
  const tabParam = readParam(sp, "tab")
  const tab: RunTab = isRunTab(tabParam) ? tabParam : "summary"

  let detail: RunDetail | null
  try {
    detail = await getRunDetail(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/workpapers/gst-recon/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={[{ label: "GST reconciliation", href: "/workpapers/gst-recon" }, { label: "Reconciliation" }]} />
        <PageHeader breadcrumbs={[{ label: "GST reconciliation", href: "/workpapers/gst-recon" }, { label: "Reconciliation" }]} title="GST reconciliation" />
        <Failed what="this reconciliation" errorRef={ref} />
      </div>
    )
  }
  if (!detail) notFound()

  const run = detail.run
  const crumbs = [
    { label: "GST reconciliation", href: "/workpapers/gst-recon" },
    { label: detail.client.name, href: `/workpapers/gst-recon?client=${detail.client.id}` },
    { label: periodLabel(run.period) },
  ]
  const nextPeriod = shiftPeriod(run.period, 1)
  const canNext = periodSortKey(nextPeriod) <= periodSortKey(periodOf(today))
  const gstinWarnings = detail.summary.warnings.filter((w) => w.code === "gstin_mismatch" || w.code === "no_client_gstin" || w.code === "no_portal_gstin")

  const lineTab = LINE_TABS[tab]
  const lineT = lineTab ? parseTableParams(sp, { sortable: ENTRY_SORTABLE, defaultSort: ENTRY_DEFAULT_SORT, filters: ENTRY_FILTERS }) : null
  const supplierT = tab === "suppliers" ? parseTableParams(sp, { sortable: SUPPLIER_SORTABLE, defaultSort: SUPPLIER_DEFAULT_SORT, filters: SUPPLIER_FILTERS }) : null

  const [lines, cleared, suppliers, followUp] = await Promise.all([
    lineTab && lineT ? attempt("lines", user.id, () => listRunLines(supabase, id, lineTab.scope, lineT)) : Promise.resolve(null),
    tab === "carried" ? attempt("cleared", user.id, () => listClearedLines(supabase, id)) : Promise.resolve(null),
    supplierT ? attempt("suppliers", user.id, () => listRunSuppliers(supabase, id, supplierT)) : Promise.resolve(null),
    tab === "suppliers" ? attempt("follow-up", user.id, () => getFollowUpContext(supabase, user, detail.client)) : Promise.resolve(null),
  ])

  const counts: Partial<Record<RunTab, number>> = {
    mismatch: run.mismatch_count,
    missing_in_2b: run.missing_in_2b_count,
    missing_in_books: run.missing_in_books_count,
    matched: run.matched_count,
    ims: run.ims_pending_count,
    carried: run.carried_count,
  }

  const lineFilters: FilterDef[] =
    tab === "ims"
      ? [
          { id: "ims", label: "Action", options: IMS_ACTIONS.map((a) => ({ value: a, label: IMS_META[a].label, tone: IMS_META[a].tone })) },
          { id: "decided", label: "Decided", multi: false, options: [{ value: "no", label: "Suggested, not decided" }, { value: "yes", label: "Decided by a person" }] },
        ]
      : tab === "matched"
        ? []
        : [{ id: "resolution", label: "Resolution", options: RECON_RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_META[r].label, tone: RESOLUTION_META[r].tone })) }]

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="GST reconciliation">
        <p>Not in 2B: booked by the client but the supplier hasn&apos;t reported it, so the ITC is at risk. Follow up from Suppliers. Not in books: the supplier reported it but it isn&apos;t booked; book it or reject it on the IMS.</p>
        <p className="mt-2">Resolve a line with a note when it is dealt with. Open and following-up lines carry into next month&apos;s reconciliation until a later GSTR-2B or register clears them.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={crumbs}
        title={`${detail.client.name} · ${periodLongLabel(run.period)}`}
        description={`GSTIN ${detail.client.gstin ?? "not on file"} · run ${run.created_by_name ? `by ${run.created_by_name} ` : ""}on ${formatDate(run.created_at)}`}
        meta={<RunStateChip row={run} />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <a href={`/api/exports/gst-recon/${run.id}`}>
                <FileDownIcon aria-hidden="true" />
                Export Excel
              </a>
            </Button>
            {canNext ? <NewReconButton today={today} label={`Reconcile ${periodLabel(nextPeriod)}`} initial={{ clientId: detail.client.id, clientLabel: `${detail.client.name} · ${detail.client.code}`, period: nextPeriod }} /> : null}
          </div>
        }
      />

      {!run.is_latest ? (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-base text-text">
          <span>A later run of {periodLongLabel(run.period)} replaced this one. It stays here for the history; resolve lines on the latest run.</span>
          {detail.history[0] && detail.history[0].id !== run.id ? (
            <Link href={`/workpapers/gst-recon/${detail.history[0].id}`} className="text-sm text-primary hover:underline">
              Open the latest run
            </Link>
          ) : null}
        </div>
      ) : null}
      {gstinWarnings.map((w, i) => (
        <div key={i} role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-base text-text">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
          <span>{w.message}</span>
        </div>
      ))}

      <RunFigures detail={detail} />
      <RunTabs runId={run.id} active={tab} counts={counts} />

      {tab === "summary" ? (
        <RunSummary
          detail={detail}
          rerun={<NewReconButton today={today} variant="outline" label="Run this month again" initial={{ clientId: detail.client.id, clientLabel: `${detail.client.name} · ${detail.client.code}`, period: run.period }} />}
        />
      ) : null}

      {lineTab && lines ? (
        <div className="flex min-w-0 flex-col">
          {tab === "ims" ? <p className="mb-3 text-sm text-text-muted">{IMS_DEEMED_ACCEPTANCE_NOTE} The suggested action comes from the match; record what the client does on the IMS.</p> : null}
          {tab === "carried" && cleared && cleared.ok && cleared.data.length > 0 ? (
            <SectionCard className="mb-4" title="Cleared this month" description="Lines open last time that this month's files close: the supplier has reported them, or they have been booked." flush>
              <ul>
                {cleared.data.map((l) => {
                  const d = readEntryData(l.data)
                  return (
                    <li key={l.id} className="flex flex-col gap-0.5 border-t border-border px-4 py-2.5 first:border-t-0 md:flex-row md:items-center md:justify-between md:gap-4 md:px-5">
                      <span className="min-w-0">
                        <span className="text-base text-text">{l.supplier_name ?? l.supplier_gstin}</span>
                        <span className="text-sm text-text-muted"> · {l.doc_number}</span>
                        <span className="block text-sm text-text-muted">{d.cleared?.message}</span>
                      </span>
                      <PaiseAmount value={l.itc_paise} />
                    </li>
                  )
                })}
              </ul>
            </SectionCard>
          ) : null}
          <FilterBar searchLabel="Search lines" searchPlaceholder="Supplier, GSTIN or document number" filters={lineFilters} />
          {lines.ok && lineT ? (
            <LinesTable kind={lineTab.kind} runId={run.id} rows={lines.data.rows} total={lines.data.total} page={lineT.page} pageSize={lineT.pageSize} sort={lineT.sort} dir={lineT.dir} />
          ) : !lines.ok ? (
            <Failed what={lineTab.label} errorRef={lines.ref} />
          ) : null}
        </div>
      ) : null}

      {tab === "suppliers" && suppliers && supplierT ? (
        <div className="flex min-w-0 flex-col">
          <FilterBar searchLabel="Search suppliers" searchPlaceholder="Supplier name or GSTIN" filters={[{ id: "chase", label: "To chase", multi: false, options: [{ value: "1", label: "Suppliers to chase" }] }]} />
          {suppliers.ok && followUp && followUp.ok ? (
            <SuppliersTable
              target={{ runId: run.id, clientId: detail.client.id, clientName: detail.client.name, clientCode: detail.client.code, periodText: periodLongLabel(run.period), context: followUp.data }}
              rows={suppliers.data.rows}
              total={suppliers.data.total}
              page={supplierT.page}
              pageSize={supplierT.pageSize}
              sort={supplierT.sort}
              dir={supplierT.dir}
            />
          ) : !suppliers.ok ? (
            <Failed what="the suppliers" errorRef={suppliers.ref} />
          ) : followUp && !followUp.ok ? (
            <Failed what="the client's contacts" errorRef={followUp.ref} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

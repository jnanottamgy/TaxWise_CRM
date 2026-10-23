import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { PlusIcon, XIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import {
  INVOICE_DATE_PRESETS,
  INVOICE_DATE_PRESET_LABEL,
  INVOICE_KINDS,
  INVOICE_KIND_LABEL,
  INVOICE_LIST_FILTERS,
  INVOICE_LIST_SORTABLE,
  listFinancialYear,
} from "@/lib/schemas/invoices"
import { getClientLabel, getInvoiceStatusTotals, listInvoiceRaisers, listInvoices } from "@/lib/data/invoices"
import { formatCount, parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { InvoicesTable } from "@/components/invoices/invoices-table"
import { InvoiceTotalsRow } from "@/components/invoices/invoice-totals"
import { InvoiceExportMenu } from "@/components/invoices/invoice-export-menu"
import { invoiceStatusFilterOptions } from "@/components/invoices/invoice-ui"

export const metadata: Metadata = { title: "Invoices" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/invoices:${source}`, userId }) }
  }
}

const ALL_YEARS = "all"

/**
 * Invoices (§7.9.1): "What's outstanding, and what's overdue?" The answer leads (outstanding and
 * overdue over every year, as the dashboards count them), then the list: searched, filtered and
 * sorted in SQL with its totals for the whole filtered set. Partners and Managers only (§4.1); an
 * Employee is refused here and by RLS. The dashboards link here with ?status=awaiting_approval,
 * ?status=sent,partially_paid,disputed and ?status=overdue, which show every year.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: INVOICE_LIST_SORTABLE, defaultSort: { sort: "issue_date", dir: "desc" }, filters: INVOICE_LIST_FILTERS })
  const today = todayIST()
  const selectedFy = await getSelectedFy()
  const fy = listFinancialYear(readParam(sp, "fy"), t.filters.status, selectedFy)
  const clientId = t.filters.client?.[0] ?? null

  const [list, raisers, client, open, overdue, awaiting] = await Promise.all([
    attempt("list", user.id, () => listInvoices(supabase, t, { fy, today })),
    attempt("raisers", user.id, () => listInvoiceRaisers(supabase)),
    clientId ? attempt("client", user.id, () => getClientLabel(supabase, clientId)) : Promise.resolve(null),
    attempt("open", user.id, () => getInvoiceStatusTotals(supabase, ["sent", "partially_paid", "disputed"])),
    attempt("overdue", user.id, () => getInvoiceStatusTotals(supabase, ["overdue"])),
    attempt("awaiting", user.id, () => getInvoiceStatusTotals(supabase, ["awaiting_approval"])),
  ])

  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: invoiceStatusFilterOptions() },
    {
      id: "fy",
      label: "FY",
      multi: false,
      options: [...fyOptions(today).map((y) => ({ value: y, label: `FY ${y}` })), { value: ALL_YEARS, label: "All years" }],
    },
    { id: "period", label: "Invoice date", multi: false, options: INVOICE_DATE_PRESETS.map((p) => ({ value: p, label: INVOICE_DATE_PRESET_LABEL[p] })) },
    ...(raisers.ok && raisers.data.length ? [{ id: "created_by", label: "Created by", multi: false, options: raisers.data, searchable: raisers.data.length > 7 }] : []),
    { id: "kind", label: "Type", multi: false, options: INVOICE_KINDS.map((k) => ({ value: k, label: INVOICE_KIND_LABEL[k] })) },
  ]

  const scope = fy ? `FY ${fy}` : "All years"
  const description = list.ok
    ? `${scope} · ${formatCount(list.data.total)} ${list.data.total === 1 ? "invoice" : "invoices"}${client && client.ok && client.data ? ` for ${client.data}` : ""}`
    : "Every invoice with what's received, deducted and still outstanding."

  const totals = (r: typeof open): { amount: number; count: number } | null => (r.ok ? { amount: r.data.totals.outstanding, count: r.data.count } : null)
  const o = totals(open)
  const ov = totals(overdue)

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Invoices">
        <p>Outstanding and Overdue at the top count every year, as the dashboard does. The list follows the FY in the top bar unless you pick another year or All years under FY; a link from the dashboard shows every year.</p>
        <p className="mt-2">A draft gets its number when it is issued. An issued invoice is never edited: cancel and reissue it before its month is in TaxWise&apos;s GSTR-1, or raise a credit or debit note after. Paid and Partially paid come only from receipts; Overdue is worked out from the due date.</p>
        <p className="mt-2">The totals under the list are for every invoice the filters match, not just this page. Cancelled invoices are left out, and Outstanding counts only issued invoices still to collect.</p>
      </PageGuide>
      <PageHeader
        title="Invoices"
        description={description}
        actions={
          <Button asChild>
            <Link href={clientId ? `/invoices/new?client=${clientId}` : "/invoices/new"}>
              <PlusIcon aria-hidden="true" />
              New invoice
            </Link>
          </Button>
        }
      />

      <KpiStrip
        lead
        className="mb-4"
        items={[
          {
            label: "Outstanding",
            value: o ? <Money value={o.amount} compact /> : "—",
            sub: o ? `${formatCount(o.count)} ${o.count === 1 ? "invoice" : "invoices"}, every year` : "Couldn't load",
            href: "/invoices?status=sent,partially_paid,disputed",
          },
          {
            label: "Overdue",
            value: ov ? <Money value={ov.amount} compact /> : "—",
            sub: ov ? (ov.count ? `${formatCount(ov.count)} past the due date` : "Nothing past its due date") : "Couldn't load",
            href: "/invoices?status=overdue",
          },
          {
            label: "Awaiting approval",
            value: awaiting.ok ? formatCount(awaiting.data.count) : "—",
            sub: awaiting.ok ? (awaiting.data.count ? "Held for a Partner" : "Nothing held") : "Couldn't load",
            href: "/invoices?status=awaiting_approval",
          },
        ]}
      />

      <FilterBar searchLabel="Search invoices" searchPlaceholder="Number, client, code or period" filters={filters} exportSlot={<InvoiceExportMenu />} />

      {clientId ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-muted">Client</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-text">
            {client && client.ok && client.data ? client.data : "This client"}
            <Link
              href={tableHref("/invoices", { filters: { client: null } }, sp)}
              aria-label="Show every client's invoices"
              className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </span>
        </div>
      ) : null}

      {list.ok ? (
        <>
          <InvoicesTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} />
          <InvoiceTotalsRow totals={list.data.totals} count={list.data.total} />
        </>
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the invoices." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

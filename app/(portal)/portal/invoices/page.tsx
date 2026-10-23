import type { Metadata } from "next"
import Link from "next/link"
import { DownloadIcon } from "lucide-react"
import { requireClient } from "@/lib/auth/guards"
import { isFinancialYear, recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { formatDate, relativeDue } from "@/lib/format"
import { fromPaise } from "@/lib/domain/money"
import { INVOICE_SHOW, INVOICE_SORTS, type InvoiceShow, type InvoiceSort } from "@/lib/schemas/portal"
import { getFirmContact, getInvoiceSummary, getPortalClient, listCreditNotes, listInvoices, listReceipts, payDetailsOf, withUpi } from "@/lib/data/portal"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { Button } from "@/components/ui/button"
import { attempt } from "@/components/portal/load"
import { NotLinked, PortalBlockError } from "@/components/portal/portal-ui"
import { ViewTabs } from "@/components/portal/view-tabs"
import { UrlSelect } from "@/components/portal/url-select"
import { InvoicesTable } from "@/components/portal/invoices-table"
import { ReceiptsTable } from "@/components/portal/tables"

export const metadata: Metadata = { title: "Invoices & payments" }

type View = "invoices" | "receipts" | "credit-notes"
const VIEWS: View[] = ["invoices", "receipts", "credit-notes"]
const SHOW_LABEL: Record<InvoiceShow, string> = { due: "Due", paid: "Paid", all: "All" }

/**
 * Invoices & payments (§7.22): "What do I owe, and how do I pay it?" What is due and overdue; the
 * invoices (PDF download through the portal-checked route, Pay while something is due: UPI QR, deep
 * link, bank details and "I've paid"); the receipts for payments the firm recorded; credit notes.
 * Read through portal_invoices, portal_payment_receipts and portal_credit_notes only. A reported
 * payment never marks an invoice paid: only a recorded receipt does.
 */
export default async function PortalInvoicesPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireClient()
  const sp = await props.searchParams
  const today = todayIST()
  const rawView = readParam(sp, "view")
  const view: View = VIEWS.includes(rawView as View) ? (rawView as View) : "invoices"
  const t = parseTableParams(sp, { sortable: INVOICE_SORTS, defaultSort: { sort: "issue_date", dir: "desc" }, filters: { show: INVOICE_SHOW } })
  const show: InvoiceShow = (t.filters.show?.[0] as InvoiceShow | undefined) ?? "due"
  const fyRaw = readParam(sp, "fy")
  const fy = fyRaw && isFinancialYear(fyRaw) ? fyRaw : null

  const client = await attempt("invoices:client", user.id, () => getPortalClient(supabase))
  if (client.ok && !client.data) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Invoices & payments" />
        <NotLinked />
      </div>
    )
  }
  const clientId = client.ok && client.data ? client.data.id : null

  const [summary, firm, list] = await Promise.all([
    attempt("invoices:summary", user.id, () => getInvoiceSummary(supabase, 0)),
    attempt("invoices:firm", user.id, () => getFirmContact(supabase)),
    view === "invoices"
      ? attempt("invoices:list", user.id, () => listInvoices(supabase, { show, fy, sort: (t.sort ?? "issue_date") as InvoiceSort, dir: t.dir, from: t.from, to: t.to }))
      : Promise.resolve(null),
  ])
  const [receipts, credits] = await Promise.all([
    view === "receipts" ? attempt("invoices:receipts", user.id, () => listReceipts(supabase, { from: t.from, to: t.to })) : Promise.resolve(null),
    view === "credit-notes" ? attempt("invoices:credit-notes", user.id, () => listCreditNotes(supabase, 50)) : Promise.resolve(null),
  ])

  const details = firm.ok ? payDetailsOf(firm.data) : null
  const rows = list?.ok && details ? await withUpi(details, list.data.rows) : list?.ok ? list.data.rows.map((r) => ({ ...r, upi: null })) : []
  const s = summary.ok ? summary.data : null

  const tabHref = (v: View) => (v === "invoices" ? "/portal/invoices" : `/portal/invoices?view=${v}`)
  const showHref = (x: InvoiceShow) => {
    const next = new URLSearchParams()
    if (x !== "due") next.set("show", x)
    if (fy) next.set("fy", fy)
    const qs = next.toString()
    return qs ? `/portal/invoices?${qs}` : "/portal/invoices"
  }

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Invoices & payments"
        description={
          s
            ? s.dueCount === 0
              ? "Nothing is due. Thank you."
              : `${s.dueCount} ${s.dueCount === 1 ? "invoice" : "invoices"} due${s.overdueCount ? `, ${s.overdueCount} overdue` : ""}${s.nextDue ? `. The earliest was due ${formatDate(s.nextDue)}.` : "."}`
            : "Your invoices, receipts and how to pay."
        }
      />

      {s ? (
        <KpiStrip
          aria-label="What you owe"
          lead
          className="mb-4 md:mb-6"
          items={[
            { label: "Amount due", value: <Money value={fromPaise(s.outstandingPaise)} />, sub: s.dueCount ? `${s.dueCount} ${s.dueCount === 1 ? "invoice" : "invoices"}` : "All paid" },
            { label: "Overdue", value: <Money value={fromPaise(s.overduePaise)} />, sub: s.overdueCount ? `${s.overdueCount} past the due date` : "None" },
            { label: "Earliest due date", value: s.nextDue ? <DateText date={s.nextDue} /> : <span className="text-text-muted">—</span>, sub: s.nextDue ? relativeDue(s.nextDue, today).text : "Nothing due" },
          ]}
        />
      ) : summary.ok ? null : (
        <PortalBlockError title="What you owe" message="Couldn't work out what is due." errorRef={summary.ref} className="mb-4 md:mb-6" />
      )}

      <ViewTabs
        label="Invoices, receipts or credit notes"
        className="mb-4"
        items={[
          { href: tabHref("invoices"), label: "Invoices", active: view === "invoices" },
          { href: tabHref("receipts"), label: "Receipts", active: view === "receipts" },
          { href: tabHref("credit-notes"), label: "Credit notes", active: view === "credit-notes" },
        ]}
      />

      {view === "invoices" ? (
        <>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <ViewTabs label="Which invoices" items={INVOICE_SHOW.map((x) => ({ href: showHref(x), label: SHOW_LABEL[x], active: show === x }))} />
            <UrlSelect
              param="fy"
              value={fy ?? ""}
              emptyLabel="Every year"
              options={recentFinancialYears(today, 6).map((y) => ({ value: y, label: `FY ${y}` }))}
              label="Financial year"
            />
          </div>
          {list && !list.ok ? (
            <PortalBlockError title="Invoices" message="Couldn't load your invoices." errorRef={list.ref} />
          ) : list && list.ok ? (
            <>
              {!details ? <p className="mb-2 text-sm text-text-muted">Pay isn&apos;t available right now: the firm&apos;s payment details didn&apos;t load. Reload the page, or send us a message.</p> : null}
              <InvoicesTable
                rows={rows}
                total={list.data.total}
                page={t.page}
                pageSize={t.pageSize}
                sort={t.sort}
                dir={t.dir}
                details={details}
                clientId={clientId}
                today={today}
                isFiltered={show !== "all" || Boolean(fy)}
                filteredEmpty={
                  show === "due" && !fy ? (
                    <EmptyState
                      message="Nothing is due right now. Thank you."
                      action={
                        <Button asChild variant="outline" size="sm">
                          <Link href="/portal/invoices?show=all">See all invoices</Link>
                        </Button>
                      }
                    />
                  ) : undefined
                }
              />
            </>
          ) : null}
        </>
      ) : null}

      {view === "receipts" && receipts ? (
        receipts.ok ? (
          <ReceiptsTable rows={receipts.data.rows} total={receipts.data.total} page={t.page} pageSize={t.pageSize} />
        ) : (
          <PortalBlockError title="Receipts" message="Couldn't load your receipts." errorRef={receipts.ref} />
        )
      ) : null}

      {view === "credit-notes" && credits ? (
        credits.ok ? (
          <SectionCard title="Credit notes" description="Reductions we made to an invoice after it was issued." flush>
            {credits.data.length === 0 ? (
              <EmptyState size="compact" message="No credit notes." className="mx-4 mb-4 md:mx-5" />
            ) : (
              <ul className="divide-y divide-border/70 px-4 pb-2 md:px-5">
                {credits.data.map((c) => (
                  <li key={c.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <p className="num text-base font-medium text-text tabular-nums">{c.number}</p>
                      <p className="text-sm text-text-muted">
                        Against invoice {c.invoiceNumber ?? "—"} · {formatDate(c.issueDate)}
                        {c.reason ? ` · ${c.reason}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-none items-center justify-between gap-3 sm:justify-end">
                      <Money value={c.total} className="text-base text-text" />
                      <Button asChild variant="ghost" size="sm">
                        <a href={`/api/pdf/credit-note/${c.id}?download=1`} aria-label={`Download credit note ${c.number} as a PDF`}>
                          <DownloadIcon aria-hidden="true" />
                          PDF
                        </a>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : (
          <PortalBlockError title="Credit notes" message="Couldn't load your credit notes." errorRef={credits.ref} />
        )
      ) : null}
    </div>
  )
}

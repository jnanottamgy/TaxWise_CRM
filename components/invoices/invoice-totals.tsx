import { Money } from "@/components/app/money"
import { formatCount } from "@/components/app/data-table/params"
import type { InvoiceListTotals } from "@/lib/data/invoices"

/**
 * The totals row for the filtered set (§7.9.1), under the list: every invoice the filters match, not
 * just this page. Cancelled invoices are left out, and Outstanding counts only issued invoices still
 * to collect (Sent, Partially paid, Disputed), as the dashboards do. Server-safe.
 */
export function InvoiceTotalsRow({ totals, count }: { totals: InvoiceListTotals; count: number }) {
  if (count === 0) return null
  const items: Array<{ label: string; value: number; hint?: string }> = [
    { label: "Taxable", value: totals.taxable },
    { label: "GST", value: totals.gst },
    ...(totals.reimbursement ? [{ label: "Reimbursements", value: totals.reimbursement }] : []),
    { label: "Total", value: totals.total },
    { label: "Received", value: totals.received },
    { label: "TDS", value: totals.tds },
    ...(totals.credited ? [{ label: "Credit notes", value: totals.credited }] : []),
    { label: "Outstanding", value: totals.outstanding, hint: "Issued invoices still to collect: Sent, Partially paid and Disputed." },
  ]
  const notes = [
    totals.cancelled ? `${formatCount(totals.cancelled)} cancelled not counted` : null,
    totals.drafts ? `${formatCount(totals.drafts)} ${totals.drafts === 1 ? "draft" : "drafts"} in the totals, not in Outstanding` : null,
  ].filter(Boolean)
  return (
    <section aria-label="Totals for these filters" className="mt-3 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2">
        <h2 className="text-sm font-medium text-text">
          Totals for {formatCount(count)} {count === 1 ? "invoice" : "invoices"}
        </h2>
        {notes.length ? <p className="text-xs text-text-muted">{notes.join(" · ")}</p> : null}
      </div>
      {/* 1px dividers between cells whatever the wrap: each cell draws its top and left rule, and the
          frame clips the ones on its outer edge. */}
      <dl className="grid grid-cols-2 overflow-hidden rounded-b-lg sm:grid-cols-4 xl:flex">
        {items.map((i) => (
          <div key={i.label} className="-mt-px -ml-px flex flex-col gap-0.5 border-t border-l border-border px-4 py-2.5 xl:flex-1">
            <dt className="text-xs text-text-muted" title={i.hint}>
              {i.label}
            </dt>
            <dd className={`num text-base tabular-nums ${i.label === "Outstanding" ? "font-semibold text-text" : "text-text"}`}>
              <Money value={i.value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

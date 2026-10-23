"use client"

import * as React from "react"
import { DownloadIcon, FileTextIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { StatusChip } from "@/components/app/status-chip"
import type { SortDir } from "@/components/app/data-table/params"
import { claimStatus, invoiceStatus } from "@/lib/domain/portal-copy"
import { formatDate } from "@/lib/format"
import type { PayDetails, PortalInvoice, UpiForInvoice } from "@/lib/data/portal"
import { PayButton } from "@/components/portal/pay-dialog"

/**
 * The client's invoices (§7.22 Invoices & payments): number and period, dates, total and what is
 * still due, the status in the client's words, the PDF, and Pay while something is due. Paged and
 * sorted on the server; below 768px each row is a card with the number, the amount due and the
 * status (§3.3).
 */

export interface InvoiceTableRow extends PortalInvoice {
  upi: UpiForInvoice | null
}

function Actions({ r, details, clientId, today }: { r: InvoiceTableRow; details: PayDetails | null; clientId: string | null; today: string }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button asChild variant="ghost" size="sm">
        <a href={`/api/portal/invoices/${r.id}/pdf?download=1`} aria-label={`Download invoice ${r.invoiceNumber} as a PDF`}>
          <DownloadIcon aria-hidden="true" />
          PDF
        </a>
      </Button>
      {r.payable && details && clientId ? (
        <PayButton
          invoice={{ id: r.id, invoiceNumber: r.invoiceNumber, outstanding: r.outstanding, dueDate: r.dueDate, isOverdue: r.isOverdue, pendingClaim: r.pendingClaim }}
          details={details}
          upi={r.upi}
          clientId={clientId}
          today={today}
          variant="outline"
        />
      ) : null}
    </div>
  )
}

export function InvoicesTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  details,
  clientId,
  today,
  isFiltered,
  filteredEmpty,
}: {
  rows: InvoiceTableRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  /** Null when the firm's payment details couldn't load: Pay is left out, the PDF still downloads. */
  details: PayDetails | null
  clientId: string | null
  today: string
  isFiltered: boolean
  /** Replaces the default "No invoices match this view" (e.g. "Nothing is due" on the Due view). */
  filteredEmpty?: React.ReactNode
}) {
  const columns = React.useMemo<DataTableColumn<InvoiceTableRow>[]>(
    () => [
      {
        id: "invoice_number",
        header: "Invoice",
        sortable: true,
        hideable: false,
        width: "28%",
        mobile: "primary",
        cell: (r) => (
          <div className="min-w-0">
            <a href={`/api/portal/invoices/${r.id}/pdf`} target="_blank" rel="noopener" className="num font-medium text-text tabular-nums hover:underline">
              {r.invoiceNumber}
            </a>
            <p className="truncate text-sm text-text-muted">{r.periodLabel ?? (r.kind === "debit_note" ? "Debit note" : "Tax invoice")}</p>
          </div>
        ),
      },
      { id: "issue_date", header: "Date", sortable: true, align: "right", mobile: "secondary", cell: (r) => <DateText date={r.issueDate} /> },
      {
        id: "due_date",
        header: "Due",
        sortable: true,
        align: "right",
        hideBelow: "lg",
        cell: (r) => <DateText date={r.dueDate} withRelative={r.payable} stacked today={today} />,
        mobileCell: (r) => (
          <span>
            due <DateText date={r.dueDate} withRelative={r.payable} today={today} />
          </span>
        ),
      },
      { id: "total_amount", header: "Total", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <Money value={r.totalAmount} /> },
      {
        id: "outstanding_amount",
        header: "Due now",
        sortable: true,
        align: "right",
        mobile: "trailing",
        cell: (r) => (r.cancelledAt ? <span className="text-text-muted">—</span> : <Money value={r.outstanding} className={r.outstanding > 0 ? "font-medium" : "text-text-muted"} />),
      },
      {
        id: "status",
        header: "Status",
        mobile: "secondary",
        cell: (r) => {
          const s = invoiceStatus(r.displayStatus)
          return (
            <div className="flex flex-col items-start gap-0.5">
              <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
              {r.pendingClaim ? (
                <span className="text-xs text-text-muted" title={claimStatus("pending").meaning}>
                  You reported paying on {formatDate(r.pendingClaim.paidOn ?? r.pendingClaim.reportedAt)}
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "actions",
        header: "Actions",
        align: "right",
        hideable: false,
        mobile: "secondary",
        cell: (r) => <Actions r={r} details={details} clientId={clientId} today={today} />,
      },
    ],
    [details, clientId, today]
  )

  return (
    <DataTable
      id="portal-invoices"
      caption="Your invoices"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "issue_date", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "invoice" : "invoices"}`}
      isFiltered={isFiltered}
      maxHeight="none"
      empty={<EmptyState icon={<FileTextIcon />} message="No invoices yet. When we bill you, the invoice and its PDF appear here." />}
      filteredEmpty={filteredEmpty ?? <FilteredEmpty message="No invoices match this view." preserve={["sort", "dir", "size"]} />}
    />
  )
}

"use client"

import * as React from "react"
import { ReceiptTextIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { CREDIT_NOTE_REASON_LABELS, PAYMENT_METHOD_LABELS, type CreditNoteReason, type PaymentMethod } from "@/lib/domain/enums"
import type { LedgerCreditNoteRow, LedgerInvoiceRow, LedgerReceiptRow } from "@/lib/data/revenue"

/**
 * The revenue ledger's three views (§7.9.10): invoices (taxable, GST, total, received, outstanding),
 * receipts (amount, TDS, method) and credit notes (taxable, GST, total, reason). Searched, sorted,
 * paged and totalled in SQL (revenue_ledger, 0163); a row opens the invoice. Cancelled invoices and
 * reversed receipts are shown and marked, and left out of the totals.
 */

type Common = { total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string; periodLabel: string }

const clientCell = (name: string, code: string) => (
  <span className="inline-flex min-w-0 flex-col leading-5" title={`${code} · ${name}`}>
    <span className="truncate">{name}</span>
    <span className="text-xs text-text-muted">{code}</span>
  </span>
)

const empty = (what: string, periodLabel: string) => <EmptyState icon={<ReceiptTextIcon />} message={`No ${what} in ${periodLabel}. Choose another period above.`} />

export function RevenueInvoicesTable({ rows, ...p }: Common & { rows: LedgerInvoiceRow[] }) {
  const columns = React.useMemo<DataTableColumn<LedgerInvoiceRow>[]>(
    () => [
      { id: "number", header: "Invoice", sortable: true, rowLink: true, hideable: false, mobile: "secondary", cell: (r) => <MonoId value={r.invoice_number} />, mobileCell: (r) => r.invoice_number },
      { id: "date", header: "Date", sortable: true, align: "right", cell: (r) => <DateText date={r.issue_date} /> },
      { id: "client", header: "Client", sortable: true, mobile: "primary", width: "24%", cell: (r) => clientCell(r.client_name, r.client_code), mobileCell: (r) => r.client_name },
      { id: "taxable_amount", header: "Taxable", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <Money value={r.taxable_amount} /> },
      { id: "gst_amount", header: "GST", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <Money value={r.gst_amount} /> },
      { id: "total_amount", header: "Total", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.total_amount} /> },
      { id: "received", header: "Received", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <Money value={r.amount_received + r.tds_credited} /> },
      { id: "outstanding_amount", header: "Outstanding", sortable: true, align: "right", cell: (r) => (r.cancelled_at ? <span className="text-text-muted">—</span> : <Money value={r.outstanding_amount} />) },
      {
        id: "status",
        header: "Status",
        mobile: "trailing",
        cell: (r) =>
          r.cancelled_at ? (
            <StatusChip label="Cancelled" tone="neutral" meaning="Cancelled: kept in the register with its number, left out of the totals." />
          ) : (
            <StatusChip kind="invoice_status" value={r.display_status} />
          ),
      },
    ],
    [],
  )
  return (
    <DataTable
      id="revenue-invoices"
      caption="Invoices"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/invoices/${r.id}`}
      total={p.total}
      page={p.page}
      pageSize={p.pageSize}
      sort={p.sort}
      dir={p.dir}
      defaultSort={{ sort: "date", dir: "desc" }}
      columnChooser
      countLabel={(n, t) => `${n} ${t === 1 ? "invoice" : "invoices"}`}
      empty={empty("invoices issued", p.periodLabel)}
    />
  )
}

export function RevenueReceiptsTable({ rows, ...p }: Common & { rows: LedgerReceiptRow[] }) {
  const columns = React.useMemo<DataTableColumn<LedgerReceiptRow>[]>(
    () => [
      { id: "number", header: "Receipt", sortable: true, rowLink: true, hideable: false, mobile: "secondary", cell: (r) => <MonoId value={r.receipt_number} />, mobileCell: (r) => r.receipt_number },
      { id: "date", header: "Paid on", sortable: true, align: "right", cell: (r) => <DateText date={r.payment_date} today={p.today} /> },
      { id: "client", header: "Client", sortable: true, mobile: "primary", width: "24%", cell: (r) => clientCell(r.client_name, r.client_code), mobileCell: (r) => r.client_name },
      { id: "invoice", header: "Invoice", hideBelow: "lg", cell: (r) => (r.invoice_number ? <MonoId value={r.invoice_number} /> : <span className="text-text-muted">—</span>) },
      { id: "method", header: "Method", hideBelow: "xl", cell: (r) => <span className="whitespace-nowrap">{PAYMENT_METHOD_LABELS[r.method as PaymentMethod] ?? r.method}</span> },
      { id: "amount_received", header: "Received", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.amount_received} /> },
      { id: "tds_amount", header: "TDS", sortable: true, align: "right", cell: (r) => (r.tds_amount ? <Money value={r.tds_amount} /> : <span className="text-text-muted">—</span>) },
      {
        id: "state",
        header: "",
       
        cell: (r) =>
          r.reversed_at ? <StatusChip label="Reversed" tone="danger" meaning={`Reversed${r.reversal_reason ? `: ${r.reversal_reason}` : ""}. Kept in the register, left out of the totals.`} /> : null,
      },
    ],
    [p.today],
  )
  return (
    <DataTable
      id="revenue-receipts"
      caption="Receipts"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/invoices/${r.invoice_id}`}
      total={p.total}
      page={p.page}
      pageSize={p.pageSize}
      sort={p.sort}
      dir={p.dir}
      defaultSort={{ sort: "date", dir: "desc" }}
      columnChooser
      countLabel={(n, t) => `${n} ${t === 1 ? "receipt" : "receipts"}`}
      empty={empty("receipts", p.periodLabel)}
    />
  )
}

export function RevenueCreditNotesTable({ rows, ...p }: Common & { rows: LedgerCreditNoteRow[] }) {
  const columns = React.useMemo<DataTableColumn<LedgerCreditNoteRow>[]>(
    () => [
      { id: "number", header: "Credit note", sortable: true, rowLink: true, hideable: false, mobile: "secondary", cell: (r) => <MonoId value={r.credit_note_number} />, mobileCell: (r) => r.credit_note_number },
      { id: "date", header: "Date", sortable: true, align: "right", cell: (r) => <DateText date={r.issue_date} /> },
      { id: "client", header: "Client", sortable: true, mobile: "primary", width: "24%", cell: (r) => clientCell(r.client_name, r.client_code), mobileCell: (r) => r.client_name },
      { id: "invoice", header: "Against", hideBelow: "lg", cell: (r) => (r.invoice_number ? <MonoId value={r.invoice_number} /> : <span className="text-text-muted">—</span>) },
      {
        id: "reason",
        header: "Reason",
        hideBelow: "xl",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span>{CREDIT_NOTE_REASON_LABELS[r.reason_code as CreditNoteReason] ?? r.reason_code}</span>
            {!r.reduces_gst ? <span className="text-xs text-text-muted">GST not reduced</span> : null}
          </span>
        ),
      },
      { id: "taxable_amount", header: "Taxable", sortable: true, align: "right", cell: (r) => <Money value={r.taxable_amount} /> },
      { id: "gst", header: "GST", align: "right", hideBelow: "lg", cell: (r) => <Money value={r.gst_amount} /> },
      { id: "total_amount", header: "Total", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.total_amount} /> },
    ],
    [],
  )
  return (
    <DataTable
      id="revenue-credit-notes"
      caption="Credit notes"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/invoices/${r.invoice_id}`}
      total={p.total}
      page={p.page}
      pageSize={p.pageSize}
      sort={p.sort}
      dir={p.dir}
      defaultSort={{ sort: "date", dir: "desc" }}
      columnChooser
      countLabel={(n, t) => `${n} ${t === 1 ? "credit note" : "credit notes"}`}
      empty={empty("credit notes", p.periodLabel)}
    />
  )
}

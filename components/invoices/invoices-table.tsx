"use client"

import * as React from "react"
import Link from "next/link"
import { PlusIcon, ReceiptTextIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { EMPTY } from "@/lib/format"
import { sentViaLabel } from "@/lib/schemas/invoices"
import type { InvoiceListRow } from "@/lib/data/invoices"
import { CANCELLED_CHIP, invoiceChipValue } from "@/components/invoices/invoice-ui"

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

export function InvoiceStatusCell({ row }: { row: Pick<InvoiceListRow, "status" | "is_overdue" | "cancelled_at" | "display_status" | "days_overdue" | "requires_approval" | "approved_at"> }) {
  const chip = invoiceChipValue(row)
  if (chip.cancelled) return <StatusChip label={CANCELLED_CHIP.label} tone={CANCELLED_CHIP.tone} meaning={CANCELLED_CHIP.meaning} />
  return (
    <span className="inline-flex flex-col items-start leading-5">
      <StatusChip kind="invoice_status" value={chip.value} />
      {chip.value === "overdue" && row.days_overdue > 0 ? (
        <span className="text-xs text-danger-text">
          {row.days_overdue} {row.days_overdue === 1 ? "day" : "days"} overdue
        </span>
      ) : row.status === "draft" && row.requires_approval && row.approved_at ? (
        <span className="text-xs text-success-text">Approved</span>
      ) : null}
    </span>
  )
}

function NumberCell({ r }: { r: InvoiceListRow }) {
  if (!r.invoice_number) {
    return <span className="text-text-muted">{r.invoice_kind === "debit_note" ? "Draft debit note" : "Draft"}</span>
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <MonoId value={r.invoice_number} />
      {r.invoice_kind === "debit_note" ? <span className="flex-none rounded-full border border-border px-1.5 text-xs leading-5 font-normal text-text-muted">Debit note</span> : null}
    </span>
  )
}

/**
 * The invoice list (§7.9.1): number, date, client, period, taxable amount, GST, total, received, TDS,
 * outstanding, due date, status (with the derived Overdue and its days) and how it was sent. Server-
 * paged and sorted; a row opens the invoice. Below 768px each row is a card: client, number, status,
 * total, due.
 */
export function InvoicesTable(props: {
  rows: InvoiceListRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  showClient?: boolean
}) {
  const { rows, total, page, pageSize, sort, dir, today, showClient = true } = props
  const columns = React.useMemo<DataTableColumn<InvoiceListRow>[]>(() => {
    // The list answers "what's outstanding, and what's overdue?": at 1366px (1,060px of table beside
    // the sidebar) Number, Date, Client, Total, Outstanding, Due and Status fit without scrolling;
    // period, taxable value, GST, received, TDS and channel join from 1536px. The totals band below
    // the table always carries every sum.
    const cols: DataTableColumn<InvoiceListRow>[] = [
      { id: "invoice_number", header: "Number", sortable: true, hideable: false, mobile: "secondary", width: "9.5rem", cell: (r) => <NumberCell r={r} />, mobileCell: (r) => r.invoice_number ?? "Draft" },
      { id: "issue_date", header: "Date", sortable: true, align: "right", cell: (r) => <DateText date={r.issue_date} /> },
    ]
    if (showClient) {
      cols.push({
        id: "client",
        header: "Client",
        sortable: true,
        mobile: "primary",
        rowLink: true,
        width: "22%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            {/* Capped, so one long company name can't push the amounts out of view; the title has it whole. */}
            <span className="max-w-60 truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      })
    }
    cols.push(
      { id: "billing_period_label", header: "Period", sortable: true, hideBelow: "2xl", cell: (r) => (r.billing_period_label ? <span className="text-text-muted">{r.billing_period_label}</span> : <Muted />) },
      { id: "taxable_amount", header: "Taxable", sortable: true, align: "right", hideBelow: "2xl", cell: (r) => <Money value={r.taxable_amount} /> },
      { id: "gst_amount", header: "GST", sortable: true, align: "right", hideBelow: "2xl", cell: (r) => <Money value={r.gst_amount} /> },
      { id: "total_amount", header: "Total", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.total_amount} /> },
      { id: "amount_received", header: "Received", sortable: true, align: "right", hideBelow: "2xl", cell: (r) => <Money value={r.amount_received} /> },
      { id: "tds_credited", header: "TDS", sortable: true, align: "right", hideBelow: "2xl", cell: (r) => <Money value={r.tds_credited} /> },
      {
        id: "outstanding_amount",
        header: "Outstanding",
        sortable: true,
        align: "right",
        cell: (r) =>
          r.cancelled_at || r.status === "draft" || r.status === "awaiting_approval" ? (
            <Muted />
          ) : r.status === "waived" ? (
            <span className="text-text-muted" title="Written off when the invoice was waived">
              Waived
            </span>
          ) : (
            <Money value={r.outstanding_amount} />
          ),
      },
      {
        id: "due_date",
        header: "Due",
        sortable: true,
        align: "right",
        mobile: "secondary",
        // Status already reads "Overdue · 5 days overdue"; the due date adds "in 3 days" only while it's still ahead.
        cell: (r) => <DateText date={r.due_date} withRelative={!r.cancelled_at && !r.is_overdue && (r.status === "sent" || r.status === "partially_paid")} stacked today={today} />,
        // On a phone card the status already says "5 days overdue"; the date line says what the date is.
        mobileCell: (r) => (
          <span>
            Due <DateText date={r.due_date} withRelative={!r.cancelled_at && !r.is_overdue && (r.status === "sent" || r.status === "partially_paid")} today={today} />
          </span>
        ),
      },
      { id: "status", header: "Status", sortable: true, mobile: "trailing", cell: (r) => <InvoiceStatusCell row={r} /> },
      {
        id: "sent_via",
        header: "Sent via",
        hideBelow: "2xl",
        cell: (r) => {
          if (!r.invoice_number) return <Muted />
          const via = sentViaLabel(r.sent_channels)
          return via ? <span className="text-text-muted">{via}</span> : <span className="text-warning-text">Not sent yet</span>
        },
      },
      { id: "created_by_name", header: "Created by", defaultHidden: true, cell: (r) => (r.created_by_name ? <span className="text-text-muted">{r.created_by_name}</span> : <Muted />) },
    )
    return cols
  }, [showClient, today])

  return (
    <DataTable
      id={showClient ? "invoices" : "client-invoices"}
      caption="Invoices"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/invoices/${r.id}`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "issue_date", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "invoice" : "invoices"}`}
      columnChooser
      rowClassName={(r) => (r.cancelled_at ? "text-text-muted" : undefined)}
      empty={
        <EmptyState
          icon={<ReceiptTextIcon />}
          message="No invoices yet. Raise the first one for a client's engagement or completed work."
          action={
            <Button asChild>
              <Link href="/invoices/new">
                <PlusIcon aria-hidden="true" />
                New invoice
              </Link>
            </Button>
          }
        />
      }
    />
  )
}

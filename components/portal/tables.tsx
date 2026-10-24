"use client"

import * as React from "react"
import { ClipboardCheckIcon, DownloadIcon, EyeIcon, FileTextIcon, FolderOpenIcon, ReceiptIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { CopyButton } from "@/components/app/copy-button"
import { StatusChip } from "@/components/app/status-chip"
import type { SortDir } from "@/components/app/data-table/params"
import { DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from "@/lib/domain/enums"
import { formatFileSize, previewKind } from "@/lib/domain/files"
import { deadlineStatus, explainDeadline, periodShort } from "@/lib/domain/portal-copy"
import type { FilingRecordRow, PortalDeadline, PortalReceipt, SharedDocument } from "@/lib/data/portal"
import { FileTypeMark } from "@/components/documents/file-type-mark"

/**
 * The portal's server-paged lists (§2.3, §7.22): receipts, filings by period, other filings on
 * record and the documents the firm shared. Columns live here because they hold render functions.
 */

interface Paged<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
  sort?: string | null
  dir?: SortDir
  isFiltered?: boolean
}

const METHOD_LABEL: Record<string, string> = {
  bank_transfer: "Bank transfer",
  upi: "UPI",
  cheque: "Cheque",
  cash: "Cash",
  card: "Card",
  other: "Other",
}

function AckDownload({ documentId, label }: { documentId: string | null; label: string }) {
  if (!documentId) return <span className="text-sm text-text-muted">—</span>
  return (
    <Button asChild variant="ghost" size="sm">
      <a href={`/api/files/documents/${documentId}`} aria-label={`Download the acknowledgement for ${label}`}>
        <DownloadIcon aria-hidden="true" />
        Acknowledgement
      </a>
    </Button>
  )
}

function AckNumber({ value }: { value: string | null }) {
  if (!value) return <span className="text-text-muted">—</span>
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="num truncate tabular-nums">{value}</span>
      <CopyButton value={value} label="acknowledgement number" />
    </span>
  )
}

// -------------------------------------------------------------------------------------------------
// Receipts
// -------------------------------------------------------------------------------------------------

export function ReceiptsTable(p: Paged<PortalReceipt>) {
  const columns = React.useMemo<DataTableColumn<PortalReceipt>[]>(
    () => [
      {
        id: "receipt",
        header: "Receipt",
        hideable: false,
        width: "28%",
        mobile: "primary",
        cell: (r) => (
          <div className="min-w-0">
            <span className="num font-medium text-text tabular-nums">{r.receiptNumber}</span>
            <p className="truncate text-sm text-text-muted">For invoice {r.invoiceNumber ?? "—"}</p>
          </div>
        ),
      },
      { id: "payment_date", header: "Paid on", align: "right", mobile: "secondary", cell: (r) => <DateText date={r.paymentDate} /> },
      { id: "method", header: "Method", hideBelow: "lg", cell: (r) => <span className="text-text">{METHOD_LABEL[r.method] ?? r.method}</span> },
      { id: "reference", header: "Reference", hideBelow: "xl", cell: (r) => (r.reference ? <span className="num tabular-nums">{r.reference}</span> : <span className="text-text-muted">—</span>) },
      { id: "tds", header: "TDS", align: "right", hideBelow: "lg", cell: (r) => <Money value={r.tdsAmount} className={r.tdsAmount ? "" : "text-text-muted"} /> },
      {
        id: "amount",
        header: "Received",
        align: "right",
        mobile: "trailing",
        cell: (r) =>
          r.reversed ? (
            <span className="inline-flex items-center gap-2">
              <StatusChip label="Reversed" tone="muted" meaning="Reversed: this receipt was cancelled by the firm, for example a bounced cheque. It no longer counts towards the invoice." />
              <Money value={r.amountReceived} className="text-text-muted line-through" />
            </span>
          ) : (
            <Money value={r.amountReceived} />
          ),
      },
      {
        id: "pdf",
        header: "Download",
        align: "right",
        hideable: false,
        mobile: "secondary",
        cell: (r) => (
          <Button asChild variant="ghost" size="sm">
            <a href={`/api/pdf/receipt/${r.id}?download=1`} aria-label={`Download receipt ${r.receiptNumber} as a PDF`}>
              <DownloadIcon aria-hidden="true" />
              PDF
            </a>
          </Button>
        ),
      },
    ],
    []
  )
  return (
    <DataTable
      id="portal-receipts"
      caption="Your payment receipts"
      columns={columns}
      getRowId={(r) => r.id}
      countLabel={(n, t) => `${n} ${t === 1 ? "receipt" : "receipts"}`}
      maxHeight="none"
      isFiltered={false}
      empty={<EmptyState icon={<ReceiptIcon />} message="No receipts yet. When we record a payment from you, its receipt appears here." />}
      {...p}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Filings by period (portal_compliance_events)
// -------------------------------------------------------------------------------------------------

export function FilingsTable(p: Paged<PortalDeadline> & { today: string }) {
  const { today, ...paged } = p
  const columns = React.useMemo<DataTableColumn<PortalDeadline>[]>(
    () => [
      {
        id: "form_code",
        header: "Return",
        sortable: true,
        hideable: false,
        width: "32%",
        // The explanation truncates: cap the column so it gives way to the acknowledgement column.
        className: "max-w-[18rem]",
        mobile: "primary",
        cell: (d) => {
          const e = explainDeadline({ formCode: d.formCode, type: d.type, filingPeriod: d.filingPeriod, title: d.title })
          return (
            <div className="min-w-0">
              <span className="font-medium text-text">{e.name}</span>
              {e.explanation ? <p className="truncate text-sm text-text-muted first-letter:uppercase" title={e.explanation}>{e.explanation}</p> : null}
            </div>
          )
        },
      },
      {
        id: "period",
        header: "Period",
        mobile: "secondary",
        cell: (d) => <span className="text-text">{periodShort(d.filingPeriod) ?? "—"}</span>,
        // Phones: the period, then the acknowledgement and its download when there is one.
        mobileCell: (d) => (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span>{periodShort(d.filingPeriod) ?? "—"}</span>
            {d.acknowledgementNo ? <AckNumber value={d.acknowledgementNo} /> : null}
            {d.acknowledgementDocumentId ? <AckDownload documentId={d.acknowledgementDocumentId} label={`${d.formCode ?? d.title} ${d.filingPeriod ?? ""}`.trim()} /> : null}
          </span>
        ),
      },
      { id: "due_date", header: "Due", sortable: true, align: "right", mobile: "secondary", cell: (d) => <DateText date={d.dueDate} withRelative={d.status === "pending"} stacked today={today} />, mobileCell: (d) => <span>due <DateText date={d.dueDate} /></span> },
      {
        // The filing date sits under the status: seven columns don't fit the portal's 976px frame,
        // and a horizontal scroll hid the acknowledgement numbers the page exists for.
        id: "status",
        header: "Status",
        mobile: "trailing",
        cell: (d) => {
          const s = deadlineStatus(d.progress, d.isOverdue)
          return (
            <span className="inline-flex flex-col items-start gap-0.5">
              <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
              {d.filedOn ? (
                <span className="text-sm text-text-muted">
                  on <DateText date={d.filedOn} />
                </span>
              ) : null}
            </span>
          )
        },
        mobileCell: (d) => {
          const s = deadlineStatus(d.progress, d.isOverdue)
          return <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
        },
      },
      {
        id: "ack",
        header: "Acknowledgement",
        hideable: false,
        cell: (d) => {
          const label = `${d.formCode ?? d.title} ${d.filingPeriod ?? ""}`.trim()
          if (!d.acknowledgementNo && !d.acknowledgementDocumentId) return <span className="text-text-muted">—</span>
          return (
            <span className="inline-flex max-w-full items-center gap-1">
              {d.acknowledgementNo ? <AckNumber value={d.acknowledgementNo} /> : null}
              {d.acknowledgementDocumentId ? (
                <Button asChild variant="ghost" size="icon-sm">
                  <a href={`/api/files/documents/${d.acknowledgementDocumentId}`} aria-label={`Download the acknowledgement for ${label}`} title="Download the acknowledgement">
                    <DownloadIcon aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </span>
          )
        },
      },
    ],
    [today]
  )
  return (
    <DataTable
      id="portal-filings"
      caption="Filing status by period"
      columns={columns}
      getRowId={(r) => r.id}
      defaultSort={{ sort: "due_date", dir: "asc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "return or deadline" : "returns and deadlines"}`}
      maxHeight="none"
      empty={<EmptyState icon={<ClipboardCheckIcon />} message="No returns are planned for this year yet. Your accountant adds them as your services start." />}
      filteredEmpty={<FilteredEmpty message="No returns match these filters for this year." />}
      {...paged}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Other filings on record (portal_filing_records without a deadline)
// -------------------------------------------------------------------------------------------------

export function OtherFilingsTable(p: Paged<FilingRecordRow>) {
  const columns = React.useMemo<DataTableColumn<FilingRecordRow>[]>(
    () => [
      {
        id: "filing_type",
        header: "Return",
        hideable: false,
        width: "30%",
        mobile: "primary",
        cell: (r) => (
          <div className="min-w-0">
            <span className="font-medium text-text">{r.filingType}</span>
            <p className="truncate text-sm text-text-muted">{r.isExternal ? `Filed by ${r.filedByExternal ?? "your previous accountant"}` : "Filed by us"}</p>
          </div>
        ),
      },
      { id: "period", header: "Period", mobile: "secondary", cell: (r) => <span className="text-text">{periodShort(r.period) ?? r.financialYear}</span> },
      { id: "filed_on", header: "Filed on", align: "right", mobile: "trailing", cell: (r) => <DateText date={r.filedOn} /> },
      { id: "ack", header: "Acknowledgement no.", mobile: "secondary", cell: (r) => <AckNumber value={r.acknowledgementNo} /> },
      { id: "download", header: "Download", align: "right", hideable: false, mobile: "secondary", cell: (r) => <AckDownload documentId={r.acknowledgementDocumentId} label={`${r.filingType} ${r.period ?? ""}`.trim()} /> },
    ],
    []
  )
  return (
    <DataTable
      id="portal-other-filings"
      caption="Other filings on record"
      columns={columns}
      getRowId={(r) => r.id}
      countLabel={(n, t) => `${n} ${t === 1 ? "filing" : "filings"}`}
      maxHeight="none"
      isFiltered={false}
      empty={<EmptyState icon={<FileTextIcon />} message="No other filings on record for this year." size="compact" />}
      {...p}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Documents the firm shared
// -------------------------------------------------------------------------------------------------

export function SharedDocumentsTable(p: Paged<SharedDocument>) {
  const columns = React.useMemo<DataTableColumn<SharedDocument>[]>(
    () => [
      {
        id: "title",
        header: "Document",
        sortable: true,
        hideable: false,
        width: "44%",
        mobile: "primary",
        cell: (d) => (
          <div className="flex min-w-0 items-center gap-3">
            <FileTypeMark mimeType={d.mimeType} fileName={d.fileName} className="max-md:hidden" />
            <div className="min-w-0">
              <span className="block truncate font-medium text-text">{d.title}</span>
              <span className="num block truncate text-sm text-text-muted tabular-nums">
                {d.fileName} · {formatFileSize(d.fileSize)}
              </span>
            </div>
          </div>
        ),
      },
      { id: "category", header: "Type", mobile: "secondary", cell: (d) => <span className="text-text">{DOCUMENT_CATEGORY_LABELS[d.category as DocumentCategory] ?? "Other"}</span> },
      { id: "financial_year", header: "Year", hideBelow: "lg", cell: (d) => (d.financialYear ? <span className="num tabular-nums">{d.financialYear}</span> : <span className="text-text-muted">—</span>) },
      { id: "created_at", header: "Shared on", sortable: true, align: "right", mobile: "secondary", cell: (d) => <DateText date={d.sharedAt} /> },
      {
        id: "open",
        header: "Open",
        align: "right",
        hideable: false,
        mobile: "trailing",
        cell: (d) => (
          <div className="flex items-center justify-end gap-1">
            {previewKind(d.mimeType) ? (
              <Button asChild variant="ghost" size="sm" className="max-md:hidden">
                <a href={`/api/files/documents/${d.id}?mode=preview`} target="_blank" rel="noopener" aria-label={`View ${d.title}`}>
                  <EyeIcon aria-hidden="true" />
                  View
                </a>
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <a href={`/api/files/documents/${d.id}`} aria-label={`Download ${d.title}`}>
                <DownloadIcon aria-hidden="true" />
                Download
              </a>
            </Button>
          </div>
        ),
      },
    ],
    []
  )
  return (
    <DataTable
      id="portal-shared"
      caption="Documents shared with you"
      columns={columns}
      getRowId={(r) => r.id}
      defaultSort={{ sort: "created_at", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "document" : "documents"}`}
      maxHeight="none"
      empty={<EmptyState icon={<FolderOpenIcon />} message="Nothing shared yet. Returns, computations, financial statements and your engagement letter appear here when we share them." />}
      filteredEmpty={<FilteredEmpty message="No shared documents match these filters." />}
      {...p}
    />
  )
}

"use client"

import * as React from "react"
import { CheckCheckIcon, InboxIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { EMPTY, formatDateTime } from "@/lib/format"
import { AMOUNT_FIELDS, AMOUNT_FIELD_LABELS, GSTR2B_SECTION_LABELS, totalTax, type GstDocRow, type Gstr2bSection } from "@/lib/domain/gstr2b"
import {
  BUCKET_META,
  ENTRY_DEFAULT_SORT,
  IMS_META,
  RESOLUTION_META,
  TIER_LABELS,
  docTypeLabel,
  periodLabel,
  readEntryData,
  type ImsAction,
  type ReconBucket,
  type ReconResolution,
} from "@/lib/schemas/gst-recon"
import type { MatchTier } from "@/lib/domain/recon"
import type { LineRow } from "@/lib/data/gst-recon"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { ImsDialog, ResolveDialog } from "@/components/workpapers/recon/line-dialogs"

export type LinesKind = ReconBucket | "carried" | "ims"

function ResolutionCell({ row }: { row: LineRow }) {
  if (row.bucket === "matched") return <span className="text-text-muted">{EMPTY}</span>
  const meta = RESOLUTION_META[(row.resolution as ReconResolution) in RESOLUTION_META ? (row.resolution as ReconResolution) : "open"]
  return (
    <span className="inline-flex min-w-0 flex-col items-start leading-5">
      <StatusChip label={meta.label} tone={meta.tone} meaning={meta.meaning} />
      {row.resolution_note ? (
        <span className="max-w-[16rem] truncate text-xs text-text-muted" title={row.resolution_note}>
          {row.resolution_note}
        </span>
      ) : null}
    </span>
  )
}

function ImsCell({ row }: { row: LineRow }) {
  if (!row.ims_action) return <span className="text-text-muted">{EMPTY}</span>
  const meta = IMS_META[row.ims_action as ImsAction]
  if (!meta) return <span className="text-text-muted">{row.ims_action}</span>
  return (
    <span className="inline-flex flex-col items-start leading-5">
      <StatusChip label={meta.label} tone={meta.tone} meaning={meta.meaning} />
      <span className="text-xs text-text-muted">{row.ims_decided_by ? `Decided by ${row.ims_decided_by_name ?? "staff"}` : "Suggested"}</span>
    </span>
  )
}

function DocCell({ row, onOpen }: { row: LineRow; onOpen: () => void }) {
  const portal = row.portal_doc_number
  const books = row.books_doc_number
  const differs = portal && books && portal !== books
  return (
    <button type="button" onClick={onOpen} className="inline-flex min-w-0 flex-col items-start rounded-sm text-left leading-5 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <span className="truncate font-medium text-text">{portal ?? books ?? "No number"}</span>
      <span className="text-xs text-text-muted">
        {docTypeLabel(row.doc_type)}
        {differs ? ` · books ${books}` : ""}
      </span>
    </button>
  )
}

function SupplierCell({ row }: { row: LineRow }) {
  return (
    <span className="inline-flex min-w-0 flex-col leading-5" title={row.supplier_name ?? row.supplier_gstin}>
      <span className="truncate">{row.supplier_name ?? (row.supplier_gstin || "Import (no GSTIN)")}</span>
      <span className="num text-xs text-text-muted">{row.supplier_gstin || "No GSTIN"}</span>
    </span>
  )
}

const EMPTY_TEXT: Record<LinesKind, string> = {
  matched: "Nothing matched this month.",
  mismatch: "No mismatches: every matched pair agrees within ₹1 on each tax head.",
  missing_in_books: "Nothing in GSTR-2B is missing from the books.",
  missing_in_2b: "Every booked document is in GSTR-2B. No ITC at risk.",
  carried: "Nothing carried forward: no open lines from earlier months.",
  ims: "No documents for the IMS this month.",
}

/**
 * One tab of a run's lines (§7.8.1 "tabs per bucket with sortable tables"): supplier, document
 * (both numbers when they differ), date, the taxable value and GST on each side, the difference,
 * and the resolution or IMS action. Server-paged and sorted. A document opens its detail sheet
 * (both sides, every tax head, the notes); selected lines can be resolved together with a note.
 */
export function LinesTable({
  kind,
  runId,
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
}: {
  kind: LinesKind
  runId: string
  rows: LineRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
}) {
  const [open, setOpen] = React.useState<LineRow | null>(null)
  const [resolving, setResolving] = React.useState<{ lines: Array<{ id: string; updatedAt: string }>; initial: ReconResolution; clear?: () => void } | null>(null)
  const [deciding, setDeciding] = React.useState<LineRow | null>(null)

  const columns = React.useMemo<DataTableColumn<LineRow>[]>(() => {
    const cols: DataTableColumn<LineRow>[] = []
    if (kind === "carried") {
      cols.push({ id: "first_seen_period", header: "Since", sortable: true, mobile: "secondary", cell: (r) => <span className="whitespace-nowrap">{periodLabel(r.first_seen_period ?? "")}</span> })
      cols.push({ id: "bucket", header: "Kind", cell: (r) => <StatusChip label={BUCKET_META[r.bucket as ReconBucket]?.label ?? r.bucket} tone={BUCKET_META[r.bucket as ReconBucket]?.tone ?? "neutral"} meaning={BUCKET_META[r.bucket as ReconBucket]?.meaning} /> })
    }
    cols.push(
      { id: "supplier_name", header: "Supplier", sortable: true, hideable: false, mobile: "primary", width: "24%", cell: (r) => <SupplierCell row={r} />, mobileCell: (r) => r.supplier_name ?? (r.supplier_gstin || "Import (no GSTIN)") },
      { id: "doc_number", header: "Document", sortable: true, mobile: "secondary", width: "16%", cell: (r) => <DocCell row={r} onOpen={() => setOpen(r)} />, mobileCell: (r) => <DocCell row={r} onOpen={() => setOpen(r)} /> },
      { id: "doc_date", header: "Date", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <DateText date={r.doc_date} /> },
    )
    if (kind === "ims") {
      cols.push(
        { id: "section", header: "Section", hideBelow: "2xl", cell: (r) => <span className="text-text-muted">{r.portal_section && r.portal_section in GSTR2B_SECTION_LABELS ? GSTR2B_SECTION_LABELS[r.portal_section as Gstr2bSection] : EMPTY}</span> },
        { id: "itc_paise", header: "GST", sortable: true, align: "right", mobile: "trailing", cell: (r) => <PaiseAmount value={r.itc_portal_paise} /> },
        { id: "bucket", header: "In books", cell: (r) => <span className="text-text-muted">{r.bucket === "missing_in_books" ? "No" : r.bucket === "mismatch" ? "Differs" : "Yes"}</span> },
        { id: "ims", header: "IMS action", mobile: "trailing", cell: (r) => <ImsCell row={r} /> },
        {
          id: "ims_reason",
          header: "Reason",
          hideBelow: "xl",
          width: "22%",
          // A sentence: it wraps (DataTable cells stay on one line otherwise, and a line clamp
          // offers its whole line as its narrowest width), within a readable minimum.
          className: "whitespace-normal min-w-[12rem]",
          cell: (r) => (
            <span className="text-sm text-text-muted" title={r.ims_reason ?? undefined}>
              {r.ims_reason ?? EMPTY}
            </span>
          ),
        },
        {
          id: "decide",
          header: "",
          hideable: false,
          cell: (r) =>
            r.origin === "current" ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setDeciding(r)}>
                {r.ims_decided_by ? "Change" : "Decide"}
              </Button>
            ) : null,
        },
      )
      return cols
    }
    if (kind === "mismatch") {
      cols.push(
        { id: "portal_taxable_paise", header: "Taxable (2B)", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <PaiseAmount value={r.portal_taxable_paise} /> },
        { id: "itc_paise", header: "GST (2B)", sortable: true, align: "right", cell: (r) => <PaiseAmount value={r.itc_portal_paise} /> },
        { id: "itc_books", header: "GST (books)", align: "right", cell: (r) => <PaiseAmount value={r.itc_books_paise} /> },
        { id: "itc_difference_paise", header: "Difference", sortable: true, align: "right", mobile: "trailing", cell: (r) => <PaiseAmount value={r.itc_difference_paise} signed className={r.itc_difference_paise < 0 ? "text-danger-text" : undefined} /> },
      )
    } else if (kind === "matched") {
      cols.push(
        { id: "portal_taxable_paise", header: "Taxable", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <PaiseAmount value={r.portal_taxable_paise} /> },
        { id: "itc_paise", header: "GST", sortable: true, align: "right", mobile: "trailing", cell: (r) => <PaiseAmount value={r.itc_portal_paise} /> },
        { id: "tier", header: "Matched on", hideBelow: "lg", cell: (r) => <span className="text-text-muted">{r.match_tier ? TIER_LABELS[r.match_tier as MatchTier] : EMPTY}</span> },
      )
    } else {
      const books = kind === "missing_in_2b" || (kind === "carried")
      cols.push(
        { id: books ? "books_taxable_paise" : "portal_taxable_paise", header: "Taxable", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <PaiseAmount value={r.bucket === "missing_in_2b" ? r.books_taxable_paise : r.portal_taxable_paise} /> },
        { id: "itc_paise", header: "GST", sortable: true, align: "right", mobile: "trailing", cell: (r) => <PaiseAmount value={r.itc_paise} /> },
      )
      if (kind === "missing_in_books") cols.push({ id: "ims", header: "IMS", hideBelow: "2xl", cell: (r) => <ImsCell row={r} /> })
    }
    if (kind !== "matched") cols.push({ id: "resolution", header: "Resolution", sortable: true, mobile: "trailing", width: "18%", cell: (r) => <ResolutionCell row={r} /> })
    return cols
  }, [kind])

  const selectable = kind !== "matched" && kind !== "ims"
  return (
    <>
      <DataTable
        id={`gst-recon-lines-${kind}`}
        caption={kind === "carried" ? "Carried forward" : kind === "ims" ? "IMS actions" : BUCKET_META[kind].label}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={ENTRY_DEFAULT_SORT}
        countLabel={(n, t) => `${n} ${t === 1 ? "line" : "lines"}`}
        columnChooser
        selectable={selectable}
        bulkActions={({ selectedRows, clear }) => (
          <>
            <Button size="sm" onClick={() => setResolving({ lines: selectedRows.map((r) => ({ id: r.id, updatedAt: r.updated_at })), initial: "accepted", clear })}>
              <CheckCheckIcon aria-hidden="true" />
              Resolve
            </Button>
            {kind === "missing_in_2b" || kind === "mismatch" ? (
              <Button size="sm" variant="outline" onClick={() => setResolving({ lines: selectedRows.map((r) => ({ id: r.id, updatedAt: r.updated_at })), initial: "follow_up_supplier", clear })}>
                Following up supplier
              </Button>
            ) : null}
          </>
        )}
        rowClassName={(r) => (r.bucket !== "matched" && !r.is_open ? "text-text-muted" : undefined)}
        empty={<EmptyState icon={<InboxIcon />} message={EMPTY_TEXT[kind]} />}
      />
      <LineSheet
        line={open}
        onClose={() => setOpen(null)}
        onResolve={(l) => setResolving({ lines: [{ id: l.id, updatedAt: l.updated_at }], initial: l.resolution === "open" ? "accepted" : "open" })}
        onDecide={(l) => setDeciding(l)}
      />
      {resolving ? (
        <ResolveDialog
          runId={runId}
          lines={resolving.lines}
          initial={resolving.initial}
          onClose={() => setResolving(null)}
          onDone={() => {
            resolving.clear?.()
            setOpen(null)
          }}
        />
      ) : null}
      {deciding ? (
        <ImsDialog
          runId={runId}
          line={{
            id: deciding.id,
            updatedAt: deciding.updated_at,
            action: (deciding.ims_action as ImsAction | null) ?? null,
            reason: deciding.ims_reason,
            label: `${docTypeLabel(deciding.doc_type)} ${deciding.portal_doc_number ?? ""} from ${deciding.supplier_name ?? (deciding.supplier_gstin || "an import (no GSTIN)")}`,
          }}
          onClose={() => {
            setDeciding(null)
            setOpen(null)
          }}
        />
      ) : null}
    </>
  )
}

function DocColumn({ title, doc }: { title: string; doc: GstDocRow | null }) {
  if (!doc) {
    return (
      <div className="min-w-0 flex-1 rounded-md border border-dashed border-border px-3 py-2.5">
        <p className="text-sm font-medium text-text">{title}</p>
        <p className="mt-1 text-sm text-text-muted">Not there</p>
      </div>
    )
  }
  return (
    <div className="min-w-0 flex-1 rounded-md border border-border px-3 py-2.5">
      <p className="text-sm font-medium text-text">{title}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-text-muted">Number</dt>
        <dd className="min-w-0 truncate text-text">{doc.docNumber || EMPTY}</dd>
        <dt className="text-text-muted">Date</dt>
        <dd className="text-right">
          <DateText date={doc.docDate} />
        </dd>
        <dt className="text-text-muted">Type</dt>
        <dd className="text-right text-text">{docTypeLabel(doc.docType)}</dd>
        {doc.section !== "register" ? (
          <>
            <dt className="text-text-muted">Section</dt>
            <dd className="text-right text-text">{GSTR2B_SECTION_LABELS[doc.section as Gstr2bSection] ?? doc.section}</dd>
          </>
        ) : (
          <>
            <dt className="text-text-muted">Register</dt>
            <dd className="text-right text-text-muted">{doc.ref}</dd>
          </>
        )}
      </dl>
    </div>
  )
}

/** One line in full: both documents, every tax head and the difference, the notes, the resolution. */
function LineSheet({ line, onClose, onResolve, onDecide }: { line: LineRow | null; onClose: () => void; onResolve: (l: LineRow) => void; onDecide: (l: LineRow) => void }) {
  const d = line ? readEntryData(line.data) : null
  const meta = line ? BUCKET_META[line.bucket as ReconBucket] : null
  return (
    <Sheet open={line !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="w-[min(100%,36rem)] overflow-y-auto">
        {line && d && meta ? (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle>{line.supplier_name ?? (line.supplier_gstin || "Import (no GSTIN)")}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                {line.supplier_gstin ? <MonoId value={line.supplier_gstin} copy label="Supplier GSTIN" /> : null}
                <StatusChip label={meta.label} tone={meta.tone} meaning={meta.meaning} />
                {line.match_tier ? <span className="text-sm text-text-muted">{TIER_LABELS[line.match_tier as MatchTier]}</span> : null}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 px-4 pb-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <DocColumn title="GSTR-2B" doc={d.portal} />
                <DocColumn title="Books" doc={d.books} />
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <caption className="sr-only">Amounts on each side</caption>
                  <thead className="bg-surface-2">
                    <tr>
                      <th scope="col" className="h-8 px-3 text-left font-normal text-text-muted">
                        Head
                      </th>
                      <th scope="col" className="h-8 px-3 text-right font-normal text-text-muted">
                        GSTR-2B
                      </th>
                      <th scope="col" className="h-8 px-3 text-right font-normal text-text-muted">
                        Books
                      </th>
                      <th scope="col" className="h-8 px-3 text-right font-normal text-text-muted">
                        Difference
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...AMOUNT_FIELDS, "itc" as const].map((f) => {
                      const p = f === "itc" ? (d.portal ? totalTax(d.portal) : null) : (d.portal?.[f] ?? null)
                      const b = f === "itc" ? (d.books ? totalTax(d.books) : null) : (d.books?.[f] ?? null)
                      const diff = p !== null && b !== null ? p - b : null
                      return (
                        <tr key={f} className="border-t border-border">
                          <th scope="row" className={f === "itc" ? "h-8 px-3 text-left font-medium text-text" : "h-8 px-3 text-left font-normal text-text"}>
                            {f === "itc" ? "Total GST" : AMOUNT_FIELD_LABELS[f]}
                          </th>
                          <td className="px-3 text-right">
                            <PaiseAmount value={p} />
                          </td>
                          <td className="px-3 text-right">
                            <PaiseAmount value={b} />
                          </td>
                          <td className="px-3 text-right">
                            {diff === null ? <span className="text-text-muted">{EMPTY}</span> : <PaiseAmount value={diff} signed muted={diff === 0} />}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {d.notes.length || d.cleared ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text">
                  {d.cleared ? <li>{d.cleared.message}</li> : null}
                  {d.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {line.bucket !== "matched" ? (
                <section className="flex flex-col gap-2 border-t border-border pt-4">
                  <h3 className="text-md font-semibold text-text">Resolution</h3>
                  <ResolutionCell row={line} />
                  {line.resolved_at ? (
                    <p className="text-sm text-text-muted">
                      {line.resolved_by_name ?? "Staff"} · {formatDateTime(line.resolved_at)}
                    </p>
                  ) : null}
                  <div>
                    <Button type="button" size="sm" variant={line.is_open ? "default" : "outline"} onClick={() => onResolve(line)}>
                      {line.is_open && line.resolution === "open" ? "Resolve" : "Change resolution"}
                    </Button>
                  </div>
                </section>
              ) : null}
              {line.ims_action ? (
                <section className="flex flex-col gap-2 border-t border-border pt-4">
                  <h3 className="text-md font-semibold text-text">IMS</h3>
                  <ImsCell row={line} />
                  {line.ims_reason ? <p className="text-sm text-text-muted">{line.ims_reason}</p> : null}
                  {line.origin === "current" ? (
                    <div>
                      <Button type="button" size="sm" variant="outline" onClick={() => onDecide(line)}>
                        {line.ims_decided_by ? "Change the IMS decision" : "Decide on the IMS"}
                      </Button>
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { FileTextIcon, PlusIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { EMPTY, formatDate, formatTimeAgo } from "@/lib/format"
import type { QuotationListRow } from "@/lib/data/quotations"

/** Statuses whose valid-until is still ahead of the client (relative time beside it). */
const OPEN_FOR_DATE: readonly string[] = ["draft", "pending_approval", "approved", "sent", "viewed"]

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

/**
 * Quotations (§7.5.3 tracking): number, who it's for, status (Sent or Viewed past its date shows
 * Expired), total incl. GST, issue date, valid until (with how long is left), sent, opened (views),
 * and who prepared it. Sorted, filtered and paged in SQL; row click opens the quotation.
 */
export function QuotationsTable(props: { rows: QuotationListRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string; now: string }) {
  const { rows, total, page, pageSize, sort, dir, today, now } = props
  const nowDate = React.useMemo(() => new Date(now), [now])
  const columns = React.useMemo<DataTableColumn<QuotationListRow>[]>(
    () => [
      {
        id: "quotation_number",
        header: "Quotation",
        sortable: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <MonoId value={r.quotation_number} copy label="quotation number" />
            {r.revision_number ? <span className="text-xs text-text-muted">Revision {r.revision_number}</span> : null}
          </span>
        ),
        mobileCell: (r) => r.quotation_number,
      },
      {
        id: "client_name",
        header: "For",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "26%",
        rowLink: true,
        cell: (r) => (
          <span className="flex min-w-0 flex-col leading-5">
            <span className="truncate font-medium">{r.client_company || r.client_name}</span>
            <span className="truncate text-xs text-text-muted">
              {r.client_code ? `${r.client_code} · ` : r.lead_number ? `${r.lead_number} · ` : ""}
              {r.client_company ? r.client_name : r.client_email}
            </span>
          </span>
        ),
        mobileCell: (r) => r.client_company || r.client_name,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        mobile: "trailing",
        cell: (r) => (
          <span className="flex flex-col items-start leading-5">
            <StatusChip kind="quotation_status" value={r.display_status} />
            {r.superseded_by_number ? <span className="text-xs text-text-muted">By {r.superseded_by_number}</span> : null}
            {r.status === "accepted" && !r.converted_client_id && !r.client_id ? <span className="text-xs text-success-text">Create the client</span> : null}
            {r.follow_ups_to_hand_off > 0 && (r.status === "sent" || r.status === "viewed") ? <span className="text-xs text-warning-text">Follow-up to hand off</span> : null}
          </span>
        ),
      },
      { id: "total", header: "Total", sortable: true, align: "right", mobile: "secondary", cell: (r) => <Money value={r.total} /> },
      { id: "issue_date", header: "Issued", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <span className="num tabular-nums">{formatDate(r.issue_date)}</span> },
      {
        id: "valid_until",
        header: "Valid until",
        sortable: true,
        align: "right",
        hideBelow: "lg",
        cell: (r) => <DateText date={r.valid_until} withRelative={OPEN_FOR_DATE.includes(r.display_status)} stacked today={today} />,
      },
      { id: "sent_at", header: "Sent", sortable: true, align: "right", hideBelow: "xl", cell: (r) => (r.sent_at ? <span className="num tabular-nums">{formatDate(r.sent_at)}</span> : <Muted />) },
      {
        id: "last_viewed_at",
        header: "Opened",
        sortable: true,
        align: "right",
        hideBelow: "lg",
        cell: (r) =>
          r.last_viewed_at ? (
            <span className="inline-flex flex-col items-end leading-5">
              <span>{formatTimeAgo(r.last_viewed_at, nowDate)}</span>
              <span className="num text-xs text-text-muted tabular-nums">{r.view_count === 1 ? "1 view" : `${r.view_count} views`}</span>
            </span>
          ) : r.sent_at ? (
            <Muted>Not yet</Muted>
          ) : (
            <Muted />
          ),
      },
      { id: "created_by_name", header: "Prepared by", hideBelow: "2xl", cell: (r) => <span className="text-text-muted">{r.created_by_name ?? EMPTY}</span> },
    ],
    [today, nowDate],
  )

  return (
    <DataTable
      id="quotations"
      caption="Quotations"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/quotations/${r.id}`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "created_at", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "quotation" : "quotations"}`}
      columnChooser
      empty={
        <EmptyState
          icon={<FileTextIcon />}
          message="No quotations yet. Prepare one for a lead or a client."
          action={
            <Button asChild size="sm">
              <Link href="/quotations/new">
                <PlusIcon aria-hidden="true" />
                New quotation
              </Link>
            </Button>
          }
        />
      }
    />
  )
}

"use client"

import * as React from "react"
import { FileWarningIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { formatTimeAgo, EMPTY } from "@/lib/format"
import type { NoticeListRow } from "@/lib/data/notices"
import { NextActionCell, NoticeStatusChip, areaLabel, noticeSubline } from "@/components/workpapers/notices/notice-ui"

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

/**
 * The notices and litigation register (§7.8.4): client, the notice (type, section, year, reference),
 * area, status, the next date someone acts on (reply due, hearing or appeal limitation, red when
 * overdue), the demand, who it is assigned to and when it changed. Server-paged and sorted; a row
 * opens the notice. Below 768px each row is a card: client, notice, status, next date.
 */
export function NoticesTable(props: {
  rows: NoticeListRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  showClient?: boolean
  emptyAction?: React.ReactNode
}) {
  const { rows, total, page, pageSize, sort, dir, today, showClient = true, emptyAction } = props
  const columns = React.useMemo<DataTableColumn<NoticeListRow>[]>(() => {
    const cols: DataTableColumn<NoticeListRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "22%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      })
    }
    cols.push(
      {
        id: "notice_type",
        header: "Notice",
        hideable: false,
        rowLink: true,
        mobile: showClient ? "secondary" : "primary",
        width: showClient ? "24%" : "34%",
        cell: (r) => {
          const sub = noticeSubline(r)
          return (
            <span className="inline-flex min-w-0 flex-col leading-5">
              <span className="truncate font-medium">{r.notice_type}</span>
              {sub ? <span className="truncate text-xs text-text-muted">{sub}</span> : null}
            </span>
          )
        },
        mobileCell: (r) => r.notice_type,
      },
      { id: "tax_area", header: "Area", hideBelow: "xl", cell: (r) => <span className="text-text-muted">{areaLabel(r.tax_area)}</span> },
      { id: "status", header: "Status", mobile: "trailing", cell: (r) => <NoticeStatusChip status={r.status} /> },
      {
        id: "next_action_date",
        header: "Next date",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => <NextActionCell row={r} today={today} />,
        mobileCell: (r) => <NextActionCell row={r} today={today} stacked={false} />,
      },
      { id: "demand_amount", header: "Demand", sortable: true, align: "right", hideBelow: "lg", cell: (r) => (r.demand_amount === null ? <Muted /> : <Money value={r.demand_amount} />) },
      { id: "assigned", header: "Assigned to", hideBelow: "lg", cell: (r) => (r.assigned_name ? <span className="text-text-muted">{r.assigned_name}</span> : <Muted>Unassigned</Muted>) },
      { id: "notice_date", header: "Notice date", sortable: true, align: "right", defaultHidden: true, cell: (r) => <DateText date={r.notice_date} /> },
      {
        id: "updated_at",
        header: "Updated",
        sortable: true,
        align: "right",
        hideBelow: "xl",
        cell: (r) => (
          <span className="num text-text-muted" title={r.updated_by_name ? `By ${r.updated_by_name}` : undefined}>
            {formatTimeAgo(r.updated_at)}
          </span>
        ),
      },
    )
    return cols
  }, [showClient, today])

  return (
    <DataTable
      id={showClient ? "tax-notices" : "client-tax-notices"}
      caption="Notices"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/workpapers/notices/${r.id}`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "next_action_date", dir: "asc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "notice" : "notices"}`}
      columnChooser
      rowClassName={(r) => (r.is_closed ? "text-text-muted" : undefined)}
      empty={<EmptyState icon={<FileWarningIcon />} message="No notices logged yet. Log a notice when a client receives one, to track the reply, hearings and any appeal." action={emptyAction} />}
    />
  )
}

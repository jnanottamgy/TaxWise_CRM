"use client"

import * as React from "react"
import { FolderTreeIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { EmptyState } from "@/components/app/empty-state"
import { EMPTY, formatTimeAgo } from "@/lib/format"
import type { GroupListRow } from "@/lib/data/client-groups"
import { NewGroupDialog } from "@/components/clients/groups/group-form-dialog"

/**
 * Client groups (§7.4): name and notes, members (active of all), combined open tasks, the next
 * deadline across members and, for Partners and Managers, the outstanding across members. A row
 * opens the group's page.
 */
export function GroupsTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  today,
  seesMoney,
}: {
  rows: GroupListRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  seesMoney: boolean
}) {
  const columns = React.useMemo<DataTableColumn<GroupListRow>[]>(() => {
    const cols: DataTableColumn<GroupListRow>[] = [
      {
        id: "name",
        header: "Group",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "32%",
        cell: (r) => (
          <span className="flex min-w-0 flex-col leading-5">
            <span className="truncate">{r.name}</span>
            {r.notes ? <span className="truncate text-xs text-text-muted">{r.notes}</span> : null}
          </span>
        ),
        mobileCell: (r) => r.name,
      },
      {
        id: "members",
        header: "Clients",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <span>{r.members}</span>
            {r.members !== r.active_members ? <span className="text-xs text-text-muted">{r.active_members} active</span> : null}
          </span>
        ),
        mobileCell: (r) => `${r.members} ${r.members === 1 ? "client" : "clients"}`,
      },
      {
        id: "open_tasks",
        header: "Open tasks",
        sortable: true,
        align: "right",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <span>{r.open_tasks}</span>
            {r.overdue_tasks ? <span className="text-xs text-danger-text">{r.overdue_tasks} overdue</span> : null}
          </span>
        ),
      },
      {
        id: "next_due_date",
        header: "Next deadline",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => (r.next_due_date ? <DateText date={r.next_due_date} withRelative today={today} /> : <span className="text-text-muted">{EMPTY}</span>),
        mobileCell: (r) => (r.next_due_date ? <DateText date={r.next_due_date} withRelative today={today} /> : "No deadline"),
      },
    ]
    if (seesMoney) {
      cols.push({ id: "outstanding", header: "Outstanding", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.outstanding} /> })
    }
    cols.push({
      id: "updated_at",
      header: "Updated",
      sortable: true,
      align: "right",
      hideBelow: "lg",
      cell: (r) => <span className="text-text-muted">{formatTimeAgo(r.updated_at)}</span>,
    })
    return cols
  }, [seesMoney, today])

  return (
    <DataTable
      id="client-groups"
      caption="Client groups"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/clients/groups/${r.id}`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "name", dir: "asc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "group" : "groups"}`}
      empty={
        <EmptyState
          icon={<FolderTreeIcon />}
          message="No groups yet. Group a family or a set of group companies to see their work and dues together."
          action={<NewGroupDialog />}
        />
      }
    />
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MessageCircleIcon, UserMinusIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Button } from "@/components/ui/button"
import { EMPTY, formatDate, formatTimeAgo } from "@/lib/format"
import { firstNameOf } from "@/lib/domain/messaging"
import { CHECKLIST_TOTAL, REGISTER_STATUS_LABEL } from "@/lib/domain/whatsapp"
import type { RegisterRow } from "@/lib/data/whatsapp"
import { removeNumberFromGroups } from "@/server/actions/whatsapp-groups"

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-text-muted">{children}</span>
}

function StatusCell({ status }: { status: RegisterRow["status"] }) {
  if (status === "none") {
    return <StatusChip label={REGISTER_STATUS_LABEL.none} tone="warning" meaning="No group yet: this client has no WhatsApp group. Set one up from the client's WhatsApp group tab." />
  }
  return <StatusChip kind="whatsapp_group_status" value={status} />
}

/**
 * The WhatsApp groups register (§7.25.1): every group with its status, members and when it was
 * last opened, and every active client with no group yet. Rows open the client's WhatsApp group
 * tab. When the list is filtered to one firm number, the selected groups can be recorded as no
 * longer holding it (house rule 7, a Partner leaving).
 */
export function RegisterTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  numberFilter,
}: {
  rows: RegisterRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  /** The firm number the list is filtered to, if one. */
  numberFilter: { id: string; label: string } | null
}) {
  const router = useRouter()
  const [now] = React.useState(() => new Date())
  const [confirm, setConfirm] = React.useState<{ ids: string[]; clear: () => void } | null>(null)

  const columns: DataTableColumn<RegisterRow>[] = [
    {
      id: "client_name",
      header: "Client",
      sortable: true,
      hideable: false,
      mobile: "primary",
      width: "34%",
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-text">{r.client_name}</span>
          <span className="truncate text-sm text-text-muted">
            <span className="font-mono text-[12px]">{r.client_code}</span>
            {r.group_name ? (
              <>
                {" · "}
                {r.group_name}
                {r.is_primary && r.status !== "closed" ? " · primary" : ""}
              </>
            ) : null}
          </span>
        </div>
      ),
    },
    { id: "status_rank", header: "Status", sortable: true, mobile: "trailing", cell: (r) => <StatusCell status={r.status} /> },
    {
      id: "member_count",
      header: "Members",
      sortable: true,
      align: "right",
      mobile: "secondary",
      cell: (r) =>
        r.group_id && r.member_count > 0 ? (
          <span className="flex flex-col items-end" title={r.member_names.join(", ")}>
            <span className="num">{r.member_count}</span>
            <span className="num text-xs text-text-muted">
              {r.admin_count} {r.admin_count === 1 ? "admin" : "admins"}
            </span>
          </span>
        ) : (
          <Muted>{EMPTY}</Muted>
        ),
      mobileCell: (r) => (r.group_id && r.member_count > 0 ? `${r.member_count} members` : null),
    },
    {
      id: "checklist",
      header: "Checklist",
      align: "right",
      hideBelow: "lg",
      cell: (r) =>
        r.status === "to_create" ? (
          <span className="num">
            {r.checklist_done}/{CHECKLIST_TOTAL}
          </span>
        ) : r.status === "active" ? (
          <span className="num text-text-muted">
            {CHECKLIST_TOTAL}/{CHECKLIST_TOTAL}
          </span>
        ) : (
          <Muted>{EMPTY}</Muted>
        ),
    },
    {
      id: "last_opened_at",
      header: "Last opened",
      sortable: true,
      align: "right",
      mobile: "secondary",
      cell: (r) =>
        r.last_opened_at ? (
          <span className="flex flex-col items-end">
            <span className="num" suppressHydrationWarning>{formatTimeAgo(r.last_opened_at, now)}</span>
            {r.last_opened_by_name ? <span className="text-xs text-text-muted">by {firstNameOf(r.last_opened_by_name) || r.last_opened_by_name}</span> : null}
          </span>
        ) : r.status === "active" ? (
          <Muted>Not yet</Muted>
        ) : (
          <Muted>{EMPTY}</Muted>
        ),
      mobileCell: (r) => (r.last_opened_at ? `Opened ${formatTimeAgo(r.last_opened_at, now)}` : null),
    },
    {
      id: "created_on",
      header: "Created",
      sortable: true,
      align: "right",
      hideBelow: "xl",
      cell: (r) =>
        r.status === "closed" && r.closed_at ? (
          <span className="flex flex-col items-end">
            <span className="num">{formatDate(r.created_on)}</span>
            <span className="num text-xs text-text-muted">closed {formatDate(r.closed_at)}</span>
          </span>
        ) : r.created_on ? (
          <span className="num">{formatDate(r.created_on)}</span>
        ) : (
          <Muted>{EMPTY}</Muted>
        ),
    },
    {
      id: "engagement_partner",
      header: "Engagement partner",
      hideBelow: "2xl",
      cell: (r) => (r.engagement_partner_name ? r.engagement_partner_name : <Muted>{EMPTY}</Muted>),
    },
  ]

  const record = async () => {
    if (!confirm || !numberFilter) return false
    const r = await removeNumberFromGroups({ numberId: numberFilter.id, groupIds: confirm.ids })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    toast.success(`${numberFilter.label} recorded as removed from ${r.data.removed} ${r.data.removed === 1 ? "group" : "groups"}.`)
    confirm.clear()
    router.refresh()
  }

  return (
    <>
      <DataTable
        id="whatsapp-groups"
        caption="WhatsApp groups"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.row_id}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "status_rank", dir: "asc" }}
        getRowHref={(r) => `/clients/${r.client_id}?tab=whatsapp`}
        countLabel={(n, t) => `${n} ${t === 1 ? "row" : "rows"}`}
        columnChooser
        selectable={!!numberFilter}
        bulkActions={
          numberFilter
            ? ({ selectedRows, clear }) => {
                const ids = selectedRows.filter((r) => r.group_id && r.status !== "closed").map((r) => r.group_id!)
                return (
                  <Button type="button" size="sm" variant="outline" disabled={ids.length === 0} onClick={() => setConfirm({ ids, clear })}>
                    <UserMinusIcon aria-hidden="true" />
                    Record {numberFilter.label} removed
                  </Button>
                )
              }
            : undefined
        }
        empty={
          <EmptyState
            icon={<MessageCircleIcon />}
            message="No clients to show yet. Once a client is onboarded, its WhatsApp group is set up from its Client 360 page."
            action={
              <Button asChild variant="outline">
                <Link href="/clients">Open clients</Link>
              </Button>
            }
          />
        }
      />
      {confirm && numberFilter ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirm(null)
          }}
          title={`Record ${numberFilter.label} as removed?`}
          description={`Remove the number from ${confirm.ids.length === 1 ? "this group" : `these ${confirm.ids.length} groups`} in WhatsApp first. This records it here as removed today; the groups and their other members don't change.`}
          confirmLabel={`Record removed from ${confirm.ids.length} ${confirm.ids.length === 1 ? "group" : "groups"}`}
          onConfirm={record}
        />
      ) : null}
    </>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { KeyRoundIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { EmptyState } from "@/components/app/empty-state"
import { RoleBadge } from "@/components/app/role-badge"
import type { SortDir } from "@/components/app/data-table/params"
import { formatDateTime, formatTimeAgo } from "@/lib/format"
import type { PersonListRow } from "@/lib/data/people"
import { issueLogins, type LoginHandout } from "@/server/actions/people"
import { CapacityChip, LoginStatusChip, PersonInitials, PresenceChip } from "@/components/people/people-bits"
import { LoginCreatedDialog } from "@/components/people/login-created-dialog"

function peopleColumns(now: Date): DataTableColumn<PersonListRow>[] {
  return [
  {
    id: "full_name",
    header: "Name",
    sortable: true,
    hideable: false,
    mobile: "primary",
    width: "22%",
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2.5">
        <PersonInitials name={r.full_name} />
        <span className="min-w-0 truncate">{r.full_name}</span>
      </span>
    ),
    mobileCell: (r) => r.full_name,
  },
  { id: "role", header: "Role", sortable: true, mobile: "secondary", cell: (r) => <RoleBadge role={r.role} /> },
  {
    id: "designation",
    header: "Designation",
    sortable: true,
    width: "18%",
    // A one-track grid has no min-content width, so a long designation truncates at the column's share.
    cell: (r) =>
      r.designation ? (
        <span className="grid grid-cols-[minmax(0,1fr)]">
          <span className="truncate" title={r.designation}>
            {r.designation}
          </span>
        </span>
      ) : (
        <span className="text-text-muted">—</span>
      ),
    mobile: "secondary",
  },
  // Department and email give way first on a 1366px laptop, so status, open tasks, capacity, online
  // now and last seen (the columns a Manager scans) stay on screen (§7.11.1, §0.1 rule 4).
  { id: "department", header: "Department", sortable: true, hideBelow: "2xl", cell: (r) => r.department ?? <span className="text-text-muted">—</span> },
  { id: "email", header: "Email", hideBelow: "2xl", cell: (r) => <span className="text-text-muted">{r.email}</span> },
  { id: "phone", header: "Phone", hideBelow: "2xl", cell: (r) => (r.phone ? <span className="num">{r.phone}</span> : <span className="text-text-muted">—</span>) },
  { id: "status", header: "Status", mobile: "trailing", cell: (r) => <LoginStatusChip status={r.login_status} onLeave={r.on_leave_today} /> },
  { id: "open_tasks", header: "Open tasks", sortable: true, align: "right", cell: (r) => r.open_tasks },
  { id: "capacity", header: "Capacity", cell: (r) => (r.login_status === "disabled" ? <span className="text-text-muted">—</span> : <CapacityChip capacity={r.capacity} />) },
  {
    id: "presence",
    header: "Online now",
    cell: (r) => (r.login_status === "active" ? <PresenceChip status={r.presence} /> : <span className="text-text-muted">—</span>),
  },
  {
    id: "last_seen_at",
    header: "Last seen",
    sortable: true,
    align: "right",
    hideBelow: "lg",
    cell: (r) => (r.last_seen_at ? <span title={formatDateTime(r.last_seen_at)}>{formatTimeAgo(r.last_seen_at, now)}</span> : <span className="text-text-muted">Never</span>),
  },
  ]
}

/**
 * The team list (§7.11.1): name, role badge, designation, department, email, phone, status
 * (active / disabled / no login yet), open tasks, capacity band, online now, last seen. Row click
 * opens the person. Select people without a login to "Issue logins for N people" (§4.5 point 8).
 */
export function PeopleTable(props: {
  rows: PersonListRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  canAdd: boolean
  /** The server's render time (ISO), so "27 minutes ago" hydrates to the same text. */
  now?: string
}) {
  const { canAdd, now: serverNow, ...tableProps } = props
  const [now] = React.useState(() => (serverNow ? new Date(serverNow) : new Date()))
  const columns = React.useMemo(() => peopleColumns(now), [now])
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [result, setResult] = React.useState<{ created: LoginHandout[]; failed: Array<{ name: string; error: string }> } | null>(null)

  const issue = (ids: string[], clear: () => void) =>
    startTransition(async () => {
      const r = await issueLogins({ ids })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      clear()
      setResult({ created: r.data.created, failed: r.data.failed })
      router.refresh()
    })

  return (
    <>
      <DataTable
        id="people"
        caption="Team members"
        columns={columns}
        getRowId={(r) => r.id}
        getRowHref={(r) => `/people/${r.id}`}
        countLabel={(n, total) => `${n} ${total === 1 ? "person" : "people"}`}
        columnChooser
        selectable={canAdd}
        defaultSort={{ sort: "full_name", dir: "asc" }}
        bulkActions={({ selectedRows, clear }) => {
          const noLogin = selectedRows.filter((r) => r.login_status === "no_login")
          return noLogin.length ? (
            <Button size="sm" onClick={() => issue(noLogin.map((r) => r.id), clear)} disabled={pending}>
              {pending ? <Spinner /> : <KeyRoundIcon aria-hidden="true" />}
              Issue logins for {noLogin.length} {noLogin.length === 1 ? "person" : "people"}
            </Button>
          ) : (
            <span className="text-sm text-text-muted">Everyone selected already has a login.</span>
          )
        }}
        empty={<EmptyState icon={<UsersIcon />} message="No team members yet. Add the first one, or import your team from a CSV file." />}
        {...tableProps}
      />
      {result ? (
        <LoginCreatedDialog logins={result.created} failed={result.failed} open={!!result} onOpenChange={(o) => !o && setResult(null)} />
      ) : null}
    </>
  )
}

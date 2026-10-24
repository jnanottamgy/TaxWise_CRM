"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { ScrollTextIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { EMPTY, formatDate, formatTime } from "@/lib/format"
import { AuditEntrySheet, type AuditEntryView } from "@/components/audit-log/audit-entry-sheet"
import { auditEventLabel, humanise, roleLabel } from "@/components/audit-log/audit-format"

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

/**
 * The audit log (§7.20): every event, newest first, server-paged and sorted. Open an entry for its
 * before/after; the drawer's address (`?entry=`) can be shared. Below 768px each row is a card: the
 * event and its time, who, and the record.
 */
export function AuditLogTable(props: {
  rows: AuditEntryView[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  exportHref: string
  /** An entry opened from the URL (`?entry=`), loaded on the server. */
  initialEntry: AuditEntryView | null
}) {
  const { rows } = props
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = React.useState<AuditEntryView | null>(props.initialEntry)
  const [seenInitial, setSeenInitial] = React.useState(props.initialEntry?.id ?? null)
  if ((props.initialEntry?.id ?? null) !== seenInitial) {
    setSeenInitial(props.initialEntry?.id ?? null)
    if (props.initialEntry) setOpen(props.initialEntry)
  }

  const show = React.useCallback(
    (entry: AuditEntryView | null) => {
      setOpen(entry)
      // Keep the address in step without a server round trip, so the entry can be shared.
      try {
        const p = new URLSearchParams(searchParams.toString())
        if (entry) p.set("entry", entry.id)
        else p.delete("entry")
        const qs = p.toString()
        window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname)
      } catch {
        // History can be unavailable (embedded views); the drawer still works.
      }
    },
    [pathname, searchParams]
  )

  const columns = React.useMemo<DataTableColumn<AuditEntryView>[]>(
    () => [
      {
        id: "at",
        header: "When (IST)",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "11rem",
        cell: (r) => (
          <button
            type="button"
            onClick={() => show(r)}
            className="num inline-flex flex-col items-start rounded-sm text-left leading-5 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={`Open the entry: ${auditEventLabel(r.event)} on ${formatDate(r.at)} at ${formatTime(r.at)}`}
          >
            <span className="font-medium text-text">{formatDate(r.at)}</span>
            <span className="text-xs text-text-muted">{formatTime(r.at)}</span>
          </button>
        ),
        mobileCell: (r) => (
          <button type="button" onClick={() => show(r)} className="text-left outline-none focus-visible:outline-2 focus-visible:outline-ring">
            {auditEventLabel(r.event)}
          </button>
        ),
      },
      {
        id: "event",
        header: "Event",
        mobile: "trailing",
        cell: (r) => (
          <span className="inline-flex items-center gap-2">
            <span className="text-text">{auditEventLabel(r.event)}</span>
            {r.success ? null : <StatusChip label="Failed" tone="danger" meaning="The action was refused or didn't complete. Open the entry for the reason." />}
          </span>
        ),
        mobileCell: (r) => <span className="num text-sm text-text-muted">{`${formatDate(r.at)}, ${formatTime(r.at)}`}</span>,
      },
      {
        id: "who",
        header: "Who",
        mobile: "secondary",
        width: "20%",
        cell: (r) =>
          r.userId ? (
            <span className="inline-flex min-w-0 flex-col leading-5" title={r.userEmail ?? undefined}>
              <span className="truncate">{r.userName ?? r.userEmail ?? "Removed account"}</span>
              <span className="truncate text-xs text-text-muted">{roleLabel(r.userRole) || EMPTY}</span>
            </span>
          ) : (
            <span className="text-text-muted">System</span>
          ),
        mobileCell: (r) => <span>{r.userId ? (r.userName ?? r.userEmail ?? "Removed account") : "System"}</span>,
      },
      {
        id: "resource",
        header: "Record",
        mobile: "secondary",
        cell: (r) =>
          r.resourceType ? (
            <span className="inline-flex min-w-0 flex-col leading-5">
              <span className="truncate">{humanise(r.resourceType)}</span>
              {r.resourceId ? <span className="truncate font-mono text-xs text-text-muted" title={r.resourceId}>{shortId(r.resourceId)}</span> : null}
            </span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
        mobileCell: (r) => <span>{r.resourceType ? humanise(r.resourceType) : EMPTY}</span>,
      },
      { id: "action", header: "Action", hideBelow: "lg", cell: (r) => (r.action ? <span className="font-mono text-xs text-text-muted">{r.action}</span> : <span className="text-text-muted">{EMPTY}</span>) },
      { id: "ip", header: "IP address", hideBelow: "xl", cell: (r) => <span className="num text-text-muted">{r.ip ?? EMPTY}</span> },
    ],
    [show]
  )

  return (
    <>
      <DataTable
        id="audit-log"
        caption="Audit log"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "at", dir: "desc" }}
        columnChooser
        exportCsv={{ href: props.exportHref, label: "Export CSV" }}
        countLabel={(n, total) => `${n} ${total === 1 ? "entry" : "entries"}`}
        empty={<EmptyState icon={<ScrollTextIcon />} message="Nothing has been recorded yet. Every sign-in, change, export and password reveal will be listed here." />}
      />
      <AuditEntrySheet entry={open} onClose={() => show(null)} />
    </>
  )
}

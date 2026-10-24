"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArchiveIcon, ArchiveRestoreIcon, BellIcon, MailIcon, MailOpenIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { TablePagination } from "@/components/app/data-table/pagination"
import { useTableUrlState } from "@/hooks/use-table-url-state"
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format"
import { NOTIFICATION_GROUP_SLUGS, notificationGroupOf, safeInboxLink, type InboxShow, type NotificationAction } from "@/lib/schemas/inbox"
import type { UpdateRow } from "@/lib/data/inbox"
import { deleteNotifications, markNotifications } from "@/server/actions/inbox"
import { announceInboxChanged, runAction } from "@/components/comms/comms-ui"

/**
 * Updates (§7.17): everything else that happened, newest first. Each notification has a deep link
 * to the exact record, and can be marked read or unread, archived (or moved back) and deleted, one
 * at a time or in bulk. Changes show at once and are confirmed by the server; a failure puts the
 * row back and says why. Opening a notification reads it.
 */

type Override = { read_at?: string | null; archived_at?: string | null; gone?: boolean }

export function UpdatesList({
  rows,
  total,
  page,
  pageSize,
  show,
  filtered,
  now: serverNow,
}: {
  rows: UpdateRow[]
  total: number
  page: number
  pageSize: number
  show: InboxShow
  filtered: boolean
  /** The server's render time (ISO), so "3 hours ago" hydrates to the same text. */
  now?: string
}) {
  const router = useRouter()
  const url = useTableUrlState()
  const [overrides, setOverrides] = React.useState<Record<string, Override>>({})
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [confirmDelete, setConfirmDelete] = React.useState<string[] | null>(null)
  const [now] = React.useState(() => (serverNow ? new Date(serverNow) : new Date()))
  const [seenRows, setSeenRows] = React.useState(rows)

  // New rows from the server replace what the optimistic overrides were standing in for.
  if (seenRows !== rows) {
    setSeenRows(rows)
    setOverrides({})
    setSelected(new Set())
  }

  const items = rows.map((r) => ({ ...r, ...overrides[r.id] })).filter((r) => !r.gone)
  const ids = items.map((r) => r.id)
  const chosen = ids.filter((id) => selected.has(id))
  const allChosen = items.length > 0 && chosen.length === items.length

  const apply = async (target: string[], action: NotificationAction) => {
    if (target.length === 0) return
    const stamp = new Date().toISOString()
    const patch: Override =
      action === "read" ? { read_at: stamp } : action === "unread" ? { read_at: null } : action === "archived" ? { archived_at: stamp } : { archived_at: null }
    const leaves = (action === "archived" && show !== "archived") || (action === "unarchived" && show === "archived") || (action === "read" && show === "unread")
    const before = overrides
    setOverrides((o) => {
      const next = { ...o }
      for (const id of target) next[id] = { ...next[id], ...patch, ...(leaves ? { gone: true } : {}) }
      return next
    })
    const done = await runAction(() => markNotifications({ ids: target, action }), (d) => (target.length > 1 ? d.message : ""))
    if (!done) {
      setOverrides(before)
      return
    }
    setSelected(new Set())
    announceInboxChanged()
    router.refresh()
  }

  const remove = async (target: string[]) => {
    const before = overrides
    setOverrides((o) => {
      const next = { ...o }
      for (const id of target) next[id] = { ...next[id], gone: true }
      return next
    })
    const done = await runAction(() => deleteNotifications({ ids: target }), (d) => `${formatNumber(d.count)} ${d.count === 1 ? "notification" : "notifications"} deleted.`)
    if (!done) {
      setOverrides(before)
      return false
    }
    setSelected(new Set())
    announceInboxChanged()
    router.refresh()
  }

  const openOne = (r: UpdateRow) => {
    if (r.read_at) return
    setOverrides((o) => ({ ...o, [r.id]: { ...o[r.id], read_at: new Date().toISOString() } }))
    void markNotifications({ ids: [r.id], action: "read" })
      .then((res) => {
        if (res.ok) announceInboxChanged()
      })
      .catch(() => undefined)
  }

  const chosenRows = items.filter((r) => selected.has(r.id))
  const anyUnread = chosenRows.some((r) => !r.read_at)
  const anyRead = chosenRows.some((r) => r.read_at)

  return (
    <div className="flex flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 md:px-4">
        <Checkbox
          checked={allChosen ? true : chosen.length > 0 ? "indeterminate" : false}
          onCheckedChange={(v) => setSelected(v ? new Set(ids) : new Set())}
          aria-label={allChosen ? "Clear the selection" : "Select every notification on this page"}
          disabled={items.length === 0}
          className="mr-1"
        />
        {chosen.length > 0 ? (
          <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-1.5">
            <span className="num mr-1 text-sm font-medium text-text tabular-nums" aria-live="polite">
              {formatNumber(chosen.length)} selected
            </span>
            {anyUnread ? (
              <Button variant="outline" size="sm" onClick={() => void apply(chosen, "read")}>
                <MailOpenIcon aria-hidden="true" />
                Mark read
              </Button>
            ) : null}
            {anyRead ? (
              <Button variant="outline" size="sm" onClick={() => void apply(chosen, "unread")}>
                <MailIcon aria-hidden="true" />
                Mark unread
              </Button>
            ) : null}
            {show === "archived" ? (
              <Button variant="outline" size="sm" onClick={() => void apply(chosen, "unarchived")}>
                <ArchiveRestoreIcon aria-hidden="true" />
                Move to inbox
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void apply(chosen, "archived")}>
                <ArchiveIcon aria-hidden="true" />
                Archive
              </Button>
            )}
            <Button variant="ghost" size="sm" className="text-danger-text hover:text-danger-text" onClick={() => setConfirmDelete(chosen)}>
              <Trash2Icon aria-hidden="true" />
              Delete
            </Button>
          </div>
        ) : (
          <span className="num text-sm text-text-muted tabular-nums">
            {formatNumber(total)} {show === "archived" ? "archived" : show === "unread" ? "unread" : total === 1 ? "update" : "updates"}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        filtered ? (
          <FilteredEmpty preserve={["show"]} />
        ) : (
          <EmptyState
            icon={<BellIcon />}
            message={
              show === "archived"
                ? "Nothing archived. Archive a notification to keep it out of the way without deleting it."
                : show === "unread"
                  ? "You're up to date. Nothing unread."
                  : "No updates yet. Assignments, approvals, client uploads and deadlines show here as they happen."
            }
          />
        )
      ) : (
        <ul>
          {items.map((r) => {
            const unread = !r.read_at
            const group = NOTIFICATION_GROUP_SLUGS[notificationGroupOf(r.type)]
            return (
              <li key={r.id} className={cn("group/row flex items-start gap-3 border-b border-border/70 px-3 py-2.5 last:border-b-0 md:px-4", selected.has(r.id) && "bg-primary-soft/60")}>
                <Checkbox
                  checked={selected.has(r.id)}
                  onCheckedChange={(v) =>
                    setSelected((s) => {
                      const next = new Set(s)
                      if (v) next.add(r.id)
                      else next.delete(r.id)
                      return next
                    })
                  }
                  aria-label={`Select “${r.title}”`}
                  className="mt-1"
                />
                <span aria-hidden="true" className={cn("mt-2 size-2 flex-none rounded-full", unread ? "bg-primary" : "bg-transparent")} />
                <Link
                  href={safeInboxLink(r.link_url)}
                  onClick={() => openOne(r)}
                  className="min-w-0 flex-1 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className={cn("block text-base text-text", unread ? "font-semibold" : "font-normal")}>
                    {r.title}
                    {unread ? <span className="sr-only"> (unread)</span> : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-sm text-text-muted">{r.body}</span>
                  <span className="mt-1 block text-xs text-text-muted">
                    {group}
                    {r.emailed_at ? " · also emailed" : ""}
                  </span>
                </Link>
                <span className="flex flex-none flex-col items-end gap-1">
                  <time dateTime={r.created_at} title={formatDateTime(r.created_at)} className="num text-xs whitespace-nowrap text-text-muted tabular-nums">
                    {formatTimeAgo(r.created_at, now)}
                  </time>
                  <span className="flex items-center">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="max-md:hidden"
                      aria-label={unread ? `Mark “${r.title}” read` : `Mark “${r.title}” unread`}
                      title={unread ? "Mark read" : "Mark unread"}
                      onClick={() => void apply([r.id], unread ? "read" : "unread")}
                    >
                      {unread ? <MailOpenIcon aria-hidden="true" /> : <MailIcon aria-hidden="true" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="max-md:hidden"
                      aria-label={r.archived_at ? `Move “${r.title}” back to the inbox` : `Archive “${r.title}”`}
                      title={r.archived_at ? "Move to inbox" : "Archive"}
                      onClick={() => void apply([r.id], r.archived_at ? "unarchived" : "archived")}
                    >
                      {r.archived_at ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`More for “${r.title}”`}>
                          <MoreHorizontalIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => void apply([r.id], unread ? "read" : "unread")}>
                          {unread ? <MailOpenIcon aria-hidden="true" /> : <MailIcon aria-hidden="true" />}
                          {unread ? "Mark read" : "Mark unread"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void apply([r.id], r.archived_at ? "unarchived" : "archived")}>
                          {r.archived_at ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
                          {r.archived_at ? "Move to inbox" : "Archive"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setConfirmDelete([r.id])} className="text-danger-text focus:text-danger-text">
                          <Trash2Icon aria-hidden="true" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {total > pageSize || page > 1 ? <TablePagination page={page} pageSize={pageSize} total={total} onPage={url.setPage} onPageSize={url.setPageSize} disabled={url.isPending} /> : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => (!o ? setConfirmDelete(null) : undefined)}
        title={confirmDelete && confirmDelete.length > 1 ? `Delete ${formatNumber(confirmDelete.length)} notifications?` : "Delete this notification?"}
        description="It goes for good. The record it was about isn't touched. To keep it out of the way instead, archive it."
        confirmLabel={confirmDelete && confirmDelete.length > 1 ? "Delete notifications" : "Delete notification"}
        destructive
        onConfirm={async () => {
          if (!confirmDelete) return
          const target = confirmDelete
          setConfirmDelete(null)
          const ok = await remove(target)
          if (ok === false) return false
        }}
      />
    </div>
  )
}


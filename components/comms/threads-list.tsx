"use client"

import * as React from "react"
import Link from "next/link"
import { MessagesSquareIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { TablePagination } from "@/components/app/data-table/pagination"
import { useTableUrlState } from "@/hooks/use-table-url-state"
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format"
import { MESSAGE_CHANNEL_LABEL } from "@/lib/handoff"
import type { ThreadListRow } from "@/lib/data/threads"
import { THREAD_READ_EVENT } from "@/components/comms/comms-ui"

/**
 * The conversations on /messages (§7.13.1): one per client, unread first, then the most recent.
 * "Unread" counts the client's portal messages nobody at the firm has read; a dot marks a thread
 * with something new since you last opened it. Choosing one opens it beside the list (on a phone,
 * in place of it).
 */
export function ThreadsList({
  rows,
  total,
  page,
  pageSize,
  selectedId,
  hrefFor,
  filtered,
  canFilterMine,
  now: serverNow,
}: {
  rows: ThreadListRow[]
  total: number
  page: number
  pageSize: number
  selectedId: string | null
  /** The link that opens each client's thread, keeping the list's filters. */
  hrefFor: Record<string, string>
  filtered: boolean
  canFilterMine: boolean
  /** The server's render time (ISO), so "12 minutes ago" hydrates to the same text. */
  now?: string
}) {
  const url = useTableUrlState()
  const [read, setRead] = React.useState<Set<string>>(() => new Set())
  const [now] = React.useState(() => (serverNow ? new Date(serverNow) : new Date()))

  React.useEffect(() => {
    const onRead = (e: Event) => {
      const id = (e as CustomEvent<{ clientId: string }>).detail?.clientId
      if (id) setRead((s) => new Set(s).add(id))
    }
    window.addEventListener(THREAD_READ_EVENT, onRead)
    return () => window.removeEventListener(THREAD_READ_EVENT, onRead)
  }, [])

  if (rows.length === 0) {
    return filtered ? (
      <FilteredEmpty preserve={["client"]} />
    ) : (
      <EmptyState
        icon={<MessagesSquareIcon />}
        message={canFilterMine ? "No conversations yet. Messages, hand-offs and logged calls with clients show here." : "No conversations with your clients yet. Messages, hand-offs and calls you log show here."}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <ul aria-label="Conversations">
        {rows.map((r) => {
          const unread = read.has(r.client_id) ? 0 : r.unread_count
          const fresh = !read.has(r.client_id) && r.new_for_me
          const active = r.client_id === selectedId
          const who = r.last_direction === "inbound" ? "Client" : r.last_sender_name ?? "The firm"
          return (
            <li key={r.client_id} className="border-b border-border/70 last:border-b-0">
              <Link
                href={hrefFor[r.client_id] ?? `/messages?client=${r.client_id}`}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-16 items-start gap-2.5 px-3 py-2.5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-4",
                  active ? "bg-primary-soft" : "hover:bg-surface-2/60",
                )}
              >
                <span aria-hidden="true" className={cn("mt-2 size-2 flex-none rounded-full", fresh || unread > 0 ? "bg-primary" : "bg-transparent")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("min-w-0 truncate text-base text-text", unread > 0 || fresh ? "font-semibold" : "font-medium")}>{r.client_name}</span>
                    <time dateTime={r.last_at} title={formatDateTime(r.last_at)} className="num flex-none text-xs text-text-muted tabular-nums">
                      {formatTimeAgo(r.last_at, now)}
                    </time>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm text-text-muted">
                      {MESSAGE_CHANNEL_LABEL[r.last_channel] ?? r.last_channel} · {who}: {r.last_subject ? `${r.last_subject} · ` : ""}
                      {r.last_preview.replace(/\s+/g, " ")}
                    </span>
                    {unread > 0 ? (
                      <span className="num flex-none rounded-full bg-primary px-1.5 text-xs leading-5 font-semibold text-primary-foreground tabular-nums" aria-label={`${unread} unread`}>
                        {formatNumber(unread)}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {total > pageSize || page > 1 ? <TablePagination page={page} pageSize={pageSize} total={total} onPage={url.setPage} disabled={url.isPending} /> : null}
    </div>
  )
}

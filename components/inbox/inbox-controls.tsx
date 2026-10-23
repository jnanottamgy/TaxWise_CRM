"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCheckIcon, SlidersHorizontalIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatNumber } from "@/lib/format"
import type { InboxShow } from "@/lib/schemas/inbox"
import { markAllNotificationsRead } from "@/server/actions/inbox"
import { announceInboxChanged, runAction } from "@/components/comms/comms-ui"

/** "Mark all read" (§7.17): every unread notification in your inbox, including those behind action items. */
export function MarkAllReadButton({ unread }: { unread: number }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  return (
    <Button
      variant="outline"
      disabled={pending || unread === 0}
      title={unread === 0 ? "Nothing unread" : undefined}
      onClick={async () => {
        setPending(true)
        const done = await runAction(() => markAllNotificationsRead({}), (d) => (d.count ? `${formatNumber(d.count)} marked read.` : "Nothing was unread."))
        setPending(false)
        if (done) {
          announceInboxChanged()
          router.refresh()
        }
      }}
    >
      {pending ? <Spinner /> : <CheckCheckIcon aria-hidden="true" />}
      Mark all read
    </Button>
  )
}

/** Profile → Notifications: in-app is always on; email per event type (§7.17 Preferences). */
export function NotificationSettingsLink() {
  return (
    <Button asChild variant="ghost">
      <Link href="/profile#notifications">
        <SlidersHorizontalIcon aria-hidden="true" />
        Notification settings
      </Link>
    </Button>
  )
}

/** All (not archived) · Unread · Archived, as links that keep the group filter. */
export function UpdatesTabs({ show, counts, hrefFor }: { show: InboxShow; counts: { unread: number; archived: number }; hrefFor: Record<InboxShow, string> }) {
  const tabs: Array<{ id: InboxShow; label: string; count: number | null }> = [
    { id: "inbox", label: "All", count: null },
    { id: "unread", label: "Unread", count: counts.unread },
    { id: "archived", label: "Archived", count: counts.archived },
  ]
  return (
    <nav aria-label="Which updates" className="overflow-x-auto">
      <ul className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
        {tabs.map((t) => (
          <li key={t.id}>
            <Link
              href={hrefFor[t.id]}
              aria-current={show === t.id ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                show === t.id ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.count ? <span className="num text-xs text-text-muted tabular-nums">{formatNumber(t.count)}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

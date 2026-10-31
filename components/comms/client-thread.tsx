"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronUpIcon, EyeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatNumber, formatTimeAgo } from "@/lib/format"
import { COMM_CHANNEL_FILTERS, type CommChannelFilter, type ThreadMessage } from "@/lib/schemas/inbox"
import { markThreadRead } from "@/server/actions/threads"
import { ThreadView } from "@/components/comms/thread-view"
import { Composer, type ComposerContact, type ComposerMessaging } from "@/components/comms/composer"
import { announceInboxChanged, announceThreadRead } from "@/components/comms/comms-ui"

/**
 * A client's whole conversation with the firm, as Client 360 → Communication and /messages show it
 * (§7.3.3, §7.13.1): who has read it, a channel filter, the messages, and the composer (portal
 * reply, WhatsApp hand-off, log a call). Opening it marks the client's unread portal
 * messages read (the firm's read receipt) and stamps when you last looked (0173).
 */

export type ClientThreadProps = {
  client: { id: string; name: string; code: string; onPortal: boolean; phone: string | null; whatsapp: string | null }
  contacts: ComposerContact[]
  messages: ThreadMessage[]
  messaging: ComposerMessaging
  portalLink: string
  me: string
  today: string
  /**
   * The server's clock when the page was rendered (ISO). "Seen by Anita (5 minutes ago)" is worked
   * out from it on the server and again in the browser, so both must use the same instant or the
   * text differs across a minute boundary and hydration fails.
   */
  now?: string
  newSince: string | null
  unreadInbound: number
  seenBy: Array<{ name: string; at: string }>
  channel: CommChannelFilter | null
  /** Links for the channel chips ("all" plus each filter), keeping the page's other params. */
  channelHrefs: Record<CommChannelFilter | "all", string>
  /** "Show older" link, when there are older messages. */
  olderHref: string | null
  /** The thread's scroll frame height. */
  frameClassName?: string
}

function ThreadReadMarker({ clientId, unread }: { clientId: string; unread: number }) {
  const done = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (done.current === clientId) return
    done.current = clientId
    void markThreadRead({ clientId })
      .then((r) => {
        if (r.ok && (r.data.marked > 0 || unread > 0)) {
          announceInboxChanged()
          announceThreadRead(clientId)
        }
      })
      .catch(() => undefined)
  }, [clientId, unread])
  return null
}

export function ClientThread(props: ClientThreadProps) {
  const { client, messages, channel } = props
  const [now] = React.useState(() => (props.now ? new Date(props.now) : new Date()))
  const chips: Array<{ id: CommChannelFilter | "all"; label: string }> = [{ id: "all", label: "All" }, ...(Object.keys(COMM_CHANNEL_FILTERS) as CommChannelFilter[]).map((k) => ({ id: k, label: COMM_CHANNEL_FILTERS[k].label }))]

  return (
    <div className="flex min-w-0 flex-col">
      <ThreadReadMarker clientId={client.id} unread={props.unreadInbound} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-3 py-2 md:px-5">
        <nav aria-label="Channels" className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1">
          {chips.map((c) => {
            const active = (channel ?? "all") === c.id
            return (
              <Link
                key={c.id}
                href={props.channelHrefs[c.id]}
                scroll={false}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "inline-flex h-7 flex-none items-center rounded-full border px-2.5 text-sm whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-9",
                  active ? "border-primary/30 bg-primary-soft text-text" : "border-border text-text-muted hover:text-text",
                )}
              >
                {c.label}
              </Link>
            )
          })}
        </nav>
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          {props.unreadInbound > 0 ? (
            <span className="font-medium text-primary">
              {formatNumber(props.unreadInbound)} unread from the client ·{" "}
            </span>
          ) : null}
          {props.seenBy.length ? (
            <>
              <EyeIcon aria-hidden="true" className="size-3.5" />
              <span suppressHydrationWarning>
                Seen by {props.seenBy.slice(0, 3).map((s) => `${s.name} (${formatTimeAgo(s.at, now)})`).join(", ")}
                {props.seenBy.length > 3 ? ` and ${props.seenBy.length - 3} more` : ""}
              </span>
            </>
          ) : (
            <span>No colleague has opened this yet.</span>
          )}
        </p>
      </div>
      <ThreadView
        messages={messages}
        clientId={client.id}
        clientName={client.name}
        me={props.me}
        newSince={props.newSince}
        today={props.today}
        className={props.frameClassName ?? "max-h-[min(62dvh,40rem)]"}
        before={
          props.olderHref ? (
            <div className="flex justify-center pt-3">
              <Link href={props.olderHref} scroll={false} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <ChevronUpIcon aria-hidden="true" className="size-4" />
                Show older messages
              </Link>
            </div>
          ) : null
        }
        emptyMessage={
          channel
            ? `No ${COMM_CHANNEL_FILTERS[channel].label.toLowerCase()} with ${client.name} yet.`
            : `No messages with ${client.name} yet. Write below, or log a call, and it starts the history.`
        }
      />
      <Composer key={client.id} client={client} contacts={props.contacts} messaging={props.messaging} portalLink={props.portalLink} />
    </div>
  )
}

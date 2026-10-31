"use client"

import * as React from "react"
import Link from "next/link"
import { AtSignIcon, FileTextIcon, GlobeIcon, MailIcon, MessageCircleIcon, PhoneIcon, StickyNoteIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { StatusChip } from "@/components/app/status-chip"
import { formatDateTime, formatTime } from "@/lib/format"
import { formatWhatsAppNumber } from "@/lib/domain/messaging"
import { MESSAGE_CHANNEL_LABEL, messageStatusInfo } from "@/lib/handoff"
import { senderLabel, threadEntries, type ThreadMessage } from "@/lib/schemas/inbox"

/**
 * One client's messages in one history (§7.13.1, §7.3.3 Communication): WhatsApp hand-offs, portal
 * messages, calls and notes (and the emails and Gmail hand-offs logged before the app stopped
 * using email), oldest first with a divider per day and a "New" marker where you last left off.
 * Every status is what the app may claim for that channel (messageStatusInfo): a hand-off only
 * ever "Handed off", a call or note "Logged", an old email its Sent / Delivered / Failed.
 */

const CHANNEL_ICON: Record<string, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  email: MailIcon,
  whatsapp_handoff: MessageCircleIcon,
  gmail_handoff: AtSignIcon,
  portal: GlobeIcon,
  call_log: PhoneIcon,
  internal_note: StickyNoteIcon,
}

const LONG = 700

function recipientText(m: ThreadMessage): string | null {
  if (!m.recipient || m.direction === "inbound") return null
  if (m.channel === "whatsapp_handoff" && /^\d{8,15}$/.test(m.recipient)) return formatWhatsAppNumber(m.recipient)
  return m.recipient
}

function MessageBody({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false)
  const long = text.length > LONG || text.split("\n").length > 14
  return (
    <div>
      <p className={cn("text-base leading-6 break-words whitespace-pre-wrap text-text", long && !open && "line-clamp-[12]")}>{text}</p>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 cursor-pointer text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  )
}

function MessageCard({ m, clientId, clientName, mine }: { m: ThreadMessage; clientId: string; clientName: string; mine: boolean }) {
  const Icon = CHANNEL_ICON[m.channel] ?? MailIcon
  const info = messageStatusInfo(m.channel, m.status)
  const note = m.channel === "call_log" || m.channel === "internal_note"
  const inbound = m.direction === "inbound"
  const to = recipientText(m)
  const logged = m.at !== m.created_at && Math.abs(Date.parse(m.at) - Date.parse(m.created_at)) > 5 * 60_000

  return (
    <article
      aria-label={`${MESSAGE_CHANNEL_LABEL[m.channel] ?? m.channel} from ${senderLabel(m, clientName)}, ${formatDateTime(m.at)}`}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1.5 rounded-lg border px-3 py-2.5 md:max-w-[min(46rem,85%)]",
        note ? "self-stretch border-dashed border-border bg-surface-2/50 md:max-w-none" : inbound ? "self-start border-border bg-surface" : "self-end border-primary/20 bg-primary-soft/50",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium text-text">
          <Icon aria-hidden={true} className="size-3.5 flex-none text-text-muted" />
          {MESSAGE_CHANNEL_LABEL[m.channel] ?? m.channel}
        </span>
        <span className="text-text-muted">·</span>
        <span className="min-w-0 truncate text-text">{mine ? "You" : senderLabel(m, clientName)}</span>
        {to ? <span className="min-w-0 truncate text-text-muted">to {m.contact_name ? `${m.contact_name} (${to})` : to}</span> : m.contact_name && !inbound ? <span className="text-text-muted">to {m.contact_name}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          <time dateTime={m.at} title={formatDateTime(m.at)} className="num text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatTime(m.at)}
          </time>
          <StatusChip label={info.label} tone={info.tone === "neutral" ? "neutral" : info.tone} meaning={info.meaning || undefined} />
        </span>
      </header>
      {m.subject ? <p className="text-base font-medium break-words text-text">{m.subject}</p> : null}
      <MessageBody text={m.body} />
      {m.attachments.length ? (
        <ul className="flex flex-wrap gap-2">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <Link
                href={`/clients/${clientId}?tab=documents&doc=${a.id}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-sm text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <FileTextIcon aria-hidden="true" className="size-3.5 flex-none text-text-muted" />
                <span className="truncate">{a.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {m.status === "failed" ? (
        <p className="text-sm text-danger-text">
          {`This didn't reach ${clientName}. Send it on WhatsApp instead.`}
          {m.error ? <span className="block text-text-muted">Reason: {m.error}</span> : null}
        </p>
      ) : null}
      {m.template_name || logged || (m.channel === "portal" && !inbound && m.read_at) ? (
        <p className="text-xs text-text-muted">
          {[
            m.template_name ? `From the template “${m.template_name}”` : null,
            logged ? `Logged ${formatDateTime(m.created_at)}` : null,
            m.channel === "portal" && !inbound && m.read_at ? `Read by the client ${formatDateTime(m.read_at)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </article>
  )
}

export function ThreadView({
  messages,
  clientId,
  clientName,
  me,
  newSince,
  today,
  emptyMessage,
  before,
  className,
}: {
  messages: ThreadMessage[]
  clientId: string
  clientName: string
  me: string
  newSince: string | null
  today: string
  emptyMessage: React.ReactNode
  /** Above the first message inside the scroll area ("Show older"). */
  before?: React.ReactNode
  /** The scroll frame's height, e.g. "max-h-[min(64dvh,40rem)]". */
  className?: string
}) {
  const entries = React.useMemo(() => threadEntries(messages, { newSince, me, today }), [messages, newSince, me, today])
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const lastId = messages[messages.length - 1]?.id ?? null
  // Open at the newest message (inside the thread's own frame; the page doesn't jump).
  React.useEffect(() => {
    const el = frameRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])

  if (messages.length === 0) {
    return <div className="px-4 py-10 text-center text-base text-text-muted md:px-5">{emptyMessage}</div>
  }
  return (
    <div ref={frameRef} tabIndex={0} aria-label={`Messages with ${clientName}`} className={cn("overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", className)}>
    {before}
    <ol className="flex flex-col gap-2 px-3 py-3 md:px-5">
      {entries.map((e) =>
        e.kind === "day" ? (
          <li key={e.key} role="separator" aria-label={e.label} className="my-2 flex items-center gap-3 text-xs font-medium text-text-muted">
            <span className="h-px flex-1 bg-border" />
            {e.label}
            <span className="h-px flex-1 bg-border" />
          </li>
        ) : e.kind === "new" ? (
          <li key={e.key} role="separator" aria-label="New since you last looked" className="my-1 flex items-center gap-3 text-xs font-semibold text-primary">
            <span className="h-px flex-1 bg-primary/40" />
            New since you last looked
            <span className="h-px flex-1 bg-primary/40" />
          </li>
        ) : (
          <li key={e.key} className="flex flex-col">
            <MessageCard m={e.message} clientId={clientId} clientName={clientName} mine={e.mine} />
          </li>
        ),
      )}
    </ol>
    </div>
  )
}

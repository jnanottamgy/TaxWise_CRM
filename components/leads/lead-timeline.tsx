import { FileTextIcon, MessageCircleIcon, MoveRightIcon, PhoneCallIcon, SearchCheckIcon, StickyNoteIcon, UserPlusIcon } from "lucide-react"
import { formatDateTime } from "@/lib/format"
import type { LeadTimelineRow } from "@/lib/data/leads"

function iconFor(type: string) {
  if (type === "lead_call_logged") return PhoneCallIcon
  if (type === "lead_note_added") return StickyNoteIcon
  if (type === "lead_message_sent") return MessageCircleIcon
  if (type === "lead_status_changed" || type === "lead_converted") return MoveRightIcon
  if (type === "lead_conflict_check") return SearchCheckIcon
  if (type.startsWith("quotation_")) return FileTextIcon
  return UserPlusIcon
}

/**
 * The lead's story (§7.5.1 "timeline (calls, notes, stage changes, quotations)"), newest first:
 * calls and notes with what was discussed, WhatsApp hand-offs (and Gmail ones logged before the
 * app stopped using email), stage moves with the lost reason, quotations sent, opened, accepted or
 * declined, conflict checks, the conversion. Server-safe.
 */
export function LeadTimeline({ events }: { events: LeadTimelineRow[] }) {
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => {
        const Icon = iconFor(e.event_type)
        return (
          <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < events.length - 1 ? <span aria-hidden="true" className="absolute top-6 bottom-0 left-[0.6875rem] w-px bg-border" /> : null}
            <span className="relative mt-0.5 flex size-6 flex-none items-center justify-center rounded-full border border-border bg-surface">
              <Icon aria-hidden="true" className="size-3.5 text-text-muted" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base leading-5 text-text">{e.title}</p>
              {e.description ? <p className="mt-0.5 line-clamp-4 text-sm whitespace-pre-line text-text-muted">{e.description}</p> : null}
              <p className="num mt-0.5 text-xs text-text-muted tabular-nums">
                {formatDateTime(e.created_at)}
                {e.performed_by_name ? ` · ${e.performed_by_name}` : ""}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

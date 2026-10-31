"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { StatusChip } from "@/components/app/status-chip"
import { WhatsAppButton, type MessageTemplateOption } from "@/components/app/messaging/whatsapp-button"
import { cn } from "@/lib/utils"
import { formatDate, formatDateTime } from "@/lib/format"
import { CHANNEL_SEND_LABELS, followUpStatusInfo } from "@/lib/schemas/quotations"
import { logQuotationHandoff } from "@/server/actions/quotations"
import type { FollowUpView } from "@/components/quotations/detail/types"

/**
 * The quotation's follow-ups (§7.5.3 "day 3, 7 and 14 after sending, while it is still Sent/Viewed
 * and not expired"): each day's date and status. One that is due (or an older one whose email
 * failed) is sent on WhatsApp with its draft, or one of the firm's quotation templates; the job's
 * notice links here with `?followup=<day>`, which is highlighted.
 */
export function FollowUpsPanel({
  quotationId,
  rows,
  open,
  highlightDay,
  whatsappNumber,
  who,
  plannedDays,
  now,
  templates,
}: {
  quotationId: string
  rows: FollowUpView[]
  open: boolean
  highlightDay: number | null
  whatsappNumber: string | null
  who: string
  plannedDays: number[]
  now: string
  /** The firm's quotation templates, filled in, to switch the draft to. */
  templates?: MessageTemplateOption[]
}) {
  const router = useRouter()
  const nowDate = React.useMemo(() => new Date(now), [now])
  const highlightRef = React.useRef<HTMLLIElement | null>(null)

  React.useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [])

  if (rows.length === 0) {
    return (
      <p className="px-4 pb-4 text-sm text-text-muted md:px-5">
        {plannedDays.length
          ? `Once it's sent, follow-ups go on day ${plannedDays.join(", ").replace(/, (\d+)$/, " and $1")} while it is open.`
          : "Follow-ups are switched off in Settings."}
      </p>
    )
  }

  const handOff = async (day: number, input: { recipient: string; body: string }) => {
    const r = await logQuotationHandoff({ id: quotationId, updatedAt: null, channel: "whatsapp_handoff", recipient: input.recipient, body: input.body, followUpDay: day })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return
    }
    toast.success(`Day-${day} follow-up handed off.`)
    router.refresh()
  }

  return (
    <ul aria-label="Follow-ups" className="px-4 pb-3 md:px-5">
      {rows.map((r) => {
        const info = followUpStatusInfo({ status: r.status, scheduled_at: r.scheduledAt }, nowDate, open)
        const actionable = open && (r.status === "failed" || (r.status === "pending" && Date.parse(r.scheduledAt) <= nowDate.getTime()))
        const highlighted = highlightDay === r.day
        return (
          <li
            key={r.id}
            ref={highlighted ? highlightRef : undefined}
            className={cn("flex flex-col gap-2 border-t border-border/70 py-2.5 first:border-t-0", highlighted && "-mx-2 rounded-md border-t-0 bg-info-soft px-2 ring-1 ring-info/40")}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base text-text">Day {r.day}</p>
                <p className="num text-sm text-text-muted tabular-nums">
                  {r.sentAt ? `${formatDateTime(r.sentAt)}${r.channel ? ` · ${CHANNEL_SEND_LABELS[r.channel] ?? r.channel}` : ""}` : formatDate(r.scheduledAt)}
                </p>
              </div>
              <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
            </div>
            {actionable ? (
              <div className="flex flex-wrap items-center gap-2">
                <WhatsAppButton
                  recipientName={who}
                  number={whatsappNumber}
                  draft={r.whatsapp}
                  templates={templates}
                  label="Send on WhatsApp"
                  variant="outline"
                  disabledReason="No WhatsApp number on the quotation's lead or client."
                  onHandedOff={({ number, text }) => handOff(r.day, { recipient: number, body: text })}
                />
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

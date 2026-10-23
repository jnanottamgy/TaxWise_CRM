"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MailIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StatusChip } from "@/components/app/status-chip"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton, type ComposeFields } from "@/components/app/messaging/gmail-button"
import { cn } from "@/lib/utils"
import { formatDate, formatDateTime } from "@/lib/format"
import { emailOutcomeNotice } from "@/lib/handoff"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import { CHANNEL_SEND_LABELS, followUpStatusInfo } from "@/lib/schemas/quotations"
import { logQuotationHandoff, sendQuotationFollowUp } from "@/server/actions/quotations"
import type { FollowUpView } from "@/components/quotations/detail/types"

const whatsAppUrl = (digits: string, text: string) => waMeUrl(digits, text)
const gmailUrl = (f: ComposeFields) => gmailComposeUrl(f)

/**
 * The quotation's follow-ups (§7.5.3 "day 3, 7 and 14 after sending, while it is still Sent/Viewed
 * and not expired"): each day's date and status. One that is due (or whose email failed) can be
 * emailed now, or handed off by WhatsApp or Gmail with its draft; the job's "hand it off" notice
 * links here with `?followup=<day>`, which is highlighted.
 */
export function FollowUpsPanel({
  quotationId,
  rows,
  open,
  emailReady,
  highlightDay,
  whatsappNumber,
  email,
  who,
  recipientName,
  pdfHref,
  plannedDays,
  now,
}: {
  quotationId: string
  rows: FollowUpView[]
  open: boolean
  emailReady: boolean
  highlightDay: number | null
  whatsappNumber: string | null
  email: string
  who: string
  recipientName: string
  pdfHref: string
  plannedDays: number[]
  now: string
}) {
  const router = useRouter()
  const nowDate = React.useMemo(() => new Date(now), [now])
  const [busyDay, setBusyDay] = React.useState<number | null>(null)
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

  const emailNow = async (day: number) => {
    setBusyDay(day)
    try {
      const r = await sendQuotationFollowUp({ id: quotationId, day })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      const notice = emailOutcomeNotice(r.data.outcome, recipientName)
      if (notice.tone === "success") toast.success(`Day-${day} follow-up emailed to ${recipientName}.`)
      else toast.warning(notice.message, { duration: 12_000 })
      router.refresh()
    } finally {
      setBusyDay(null)
    }
  }

  const handOff = async (day: number, input: { channel: "whatsapp_handoff" | "gmail_handoff"; recipient: string; subject?: string; body: string }) => {
    const r = await logQuotationHandoff({ id: quotationId, updatedAt: null, channel: input.channel, recipient: input.recipient, subject: input.subject ?? "", body: input.body, followUpDay: day })
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
                {emailReady ? (
                  <Button type="button" size="sm" variant="outline" disabled={busyDay !== null} onClick={() => void emailNow(r.day)}>
                    {busyDay === r.day ? <Spinner /> : <MailIcon aria-hidden="true" />}
                    Email now
                  </Button>
                ) : null}
                <WhatsAppButton
                  recipientName={who}
                  number={whatsappNumber}
                  draft={r.whatsapp}
                  buildUrl={whatsAppUrl}
                  variant="outline"
                  disabledReason="No WhatsApp number on the quotation's lead or client."
                  onHandedOff={({ number, text }) => handOff(r.day, { channel: "whatsapp_handoff", recipient: number, body: text })}
                />
                <GmailButton
                  to={email}
                  subject={r.emailSubject}
                  body={r.emailBody}
                  buildUrl={gmailUrl}
                  pdfHref={pdfHref}
                  onHandedOff={(f) => handOff(r.day, { channel: "gmail_handoff", recipient: f.to, subject: f.subject, body: f.body })}
                />
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

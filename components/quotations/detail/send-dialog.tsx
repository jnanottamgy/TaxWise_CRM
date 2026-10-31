"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { LinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { useCopy } from "@/hooks/use-copy"
import { logQuotationHandoff } from "@/server/actions/quotations"
import type { ControlsData } from "@/components/quotations/detail/types"

/**
 * Send (or resend) a quotation (§7.5.3) on WhatsApp: the message with the client's link (the firm's
 * Quotation template, or the suggested wording), and the quotation PDF downloaded in the same click
 * to attach. Or copy the link to share it another way. Sending a Draft or an Approved quotation
 * marks it Sent and starts the day 3 / 7 / 14 follow-ups. Nothing is emailed.
 */
export function SendQuotationDialog({
  open,
  onOpenChange,
  data,
  updatedAt,
  onSent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: ControlsData
  updatedAt: string
  onSent: (r: { updatedAt: string | null }) => void
}) {
  const router = useRouter()
  const { copy } = useCopy()
  const [busy, setBusy] = React.useState(false)
  const resend = data.status === "sent" || data.status === "viewed"

  const handOff = async (input: { channel: "whatsapp_handoff" | "internal_note"; recipient: string; body?: string }) => {
    setBusy(true)
    try {
      const r = await logQuotationHandoff({ id: data.id, updatedAt, channel: input.channel, recipient: input.recipient, body: input.body ?? "" })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return false
      }
      toast.success(
        input.channel === "internal_note"
          ? resend
            ? "Link copied."
            : `Link copied, and ${data.number} is marked as sent.`
          : resend
            ? "Handed off; noted on the quotation."
            : `Handed off, and ${data.number} is marked as sent.`,
      )
      onSent({ updatedAt: r.data.updatedAt })
      onOpenChange(false)
      router.refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`${resend ? "Resend" : "Send"} quotation ${data.number}`}
      description={`To ${data.who}: total ${data.totalLabel} incl. GST. The client can view, download, accept or decline it from the link.`}
      footer={
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <section aria-labelledby="send-handoff-title" className="flex flex-col gap-2">
        <h3 id="send-handoff-title" className="text-sm font-semibold text-text">
          Send it on WhatsApp
        </h3>
        <p className="text-sm text-text-muted">
          The message has the link to the quotation, and the PDF downloads to attach. {resend ? "" : "Handing it off marks the quotation as sent."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <WhatsAppButton
            recipientName={data.who}
            number={data.whatsappNumber}
            draft={data.drafts.whatsapp}
            templates={data.drafts.templates}
            attachment={data.attachment}
            label="Send on WhatsApp"
            disabledReason="No WhatsApp number on the quotation's lead or client. Copy the link instead."
            onHandedOff={async ({ number, text }) => {
              await handOff({ channel: "whatsapp_handoff", recipient: number, body: text })
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const copied = await copy(data.link)
              if (!copied) {
                toast.error("Couldn't copy the link. Select it below and copy it by hand.")
                return
              }
              await handOff({ channel: "internal_note", recipient: "Link copied" })
            }}
          >
            <LinkIcon aria-hidden="true" />
            Copy link
          </Button>
        </div>
        <p className="truncate font-mono text-xs text-text-muted select-all" title={data.link}>
          {data.link}
        </p>
      </section>
    </FormDialog>
  )
}

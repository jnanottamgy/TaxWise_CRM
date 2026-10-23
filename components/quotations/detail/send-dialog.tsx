"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CircleCheckIcon, CircleAlertIcon, LinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField, TextareaField } from "@/components/app/form/fields"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton, type ComposeFields } from "@/components/app/messaging/gmail-button"
import { EmailSetupBanner } from "@/components/settings/email/email-setup-banner"
import { useActionForm } from "@/hooks/use-action-form"
import { useCopy } from "@/hooks/use-copy"
import { cn } from "@/lib/utils"
import { emailOutcomeNotice, type EmailSendOutcome } from "@/lib/handoff"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import { SendQuotationEmailSchema, type SendQuotationEmailInput } from "@/lib/schemas/quotations"
import { logQuotationHandoff, sendQuotationEmail } from "@/server/actions/quotations"
import type { ControlsData } from "@/components/quotations/detail/types"

const whatsAppUrl = (digits: string, text: string) => waMeUrl(digits, text)
const gmailUrl = (f: ComposeFields) => gmailComposeUrl(f)

/**
 * Send (or resend) a quotation (§7.5.3): by email (Resend: the branded email with View quotation and
 * the PDF attached), or handed off: Gmail compose with the link (Download PDF beside it, since no
 * compose URL can attach a file), WhatsApp with the link, or the link copied. Sending a Draft or an
 * Approved quotation marks it Sent and starts the day 3 / 7 / 14 follow-ups. While email isn't set
 * up, the banner shows and only the hand-offs are offered (§7.13.5); after a failed send the
 * hand-offs come first (§7.13.3).
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
  const [outcome, setOutcome] = React.useState<EmailSendOutcome | null>(null)
  const [busy, setBusy] = React.useState(false)
  const resend = data.status === "sent" || data.status === "viewed"
  const defaults: SendQuotationEmailInput = { id: data.id, updatedAt, to: data.email, cc: "", coveringNote: "" }

  const f = useActionForm(SendQuotationEmailSchema, sendQuotationEmail, {
    defaultValues: defaults,
    resetOnSuccess: false,
    onSuccess: (r) => {
      setOutcome(r.outcome)
      if (r.outcome.status === "sent") {
        toast.success(emailOutcomeNotice(r.outcome, data.recipientName).message)
        onSent({ updatedAt: r.updatedAt })
        onOpenChange(false)
        router.refresh()
      }
    },
  })

  // Each time it opens: no outcome from last time, and the form on the latest updated_at.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOutcome(null)
  }
  React.useEffect(() => {
    if (open) {
      f.form.reset({ ...defaults, updatedAt })
      f.clearFormError()
    }
    // Reset each time it opens, with the latest updated_at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])

  const handOff = async (input: { channel: "whatsapp_handoff" | "gmail_handoff" | "internal_note"; recipient: string; subject?: string; body?: string }) => {
    setBusy(true)
    try {
      const r = await logQuotationHandoff({ id: data.id, updatedAt, channel: input.channel, recipient: input.recipient, subject: input.subject ?? "", body: input.body ?? "" })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return false
      }
      const already = resend
      toast.success(
        input.channel === "internal_note"
          ? already
            ? "Link copied."
            : `Link copied, and ${data.number} is marked as sent.`
          : already
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

  const notice = outcome ? emailOutcomeNotice(outcome, data.recipientName) : null
  const handoffFirst = Boolean(notice?.offerHandoff) || !data.emailReady

  const handoffs = (
    <section aria-labelledby="send-handoff-title" className={cn("flex flex-col gap-2", handoffFirst ? "" : "border-t border-border pt-4")}>
      <h3 id="send-handoff-title" className="text-sm font-semibold text-text">
        {data.emailReady ? "Or send it yourself" : "Send it yourself"}
      </h3>
      <p className="text-sm text-text-muted">The message has the link to the quotation. {resend ? "" : "Handing it off marks the quotation as sent."}</p>
      <div className="flex flex-wrap items-center gap-2">
        <WhatsAppButton
          recipientName={data.who}
          number={data.whatsappNumber}
          draft={data.drafts.whatsapp}
          buildUrl={whatsAppUrl}
          disabledReason="No WhatsApp number on the quotation's lead or client. Copy the link instead."
          onHandedOff={async ({ number, text }) => {
            await handOff({ channel: "whatsapp_handoff", recipient: number, body: text })
          }}
        />
        <GmailButton
          to={data.email}
          subject={data.drafts.emailSubject}
          body={data.drafts.emailBody}
          buildUrl={gmailUrl}
          pdfHref={data.pdfHref}
          disabledReason="No email address on the quotation."
          onHandedOff={async (fields) => {
            await handOff({ channel: "gmail_handoff", recipient: fields.to, subject: fields.subject, body: fields.body })
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
  )

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`${resend ? "Resend" : "Send"} quotation ${data.number}`}
      description={`To ${data.who}: total ${data.totalLabel} incl. GST. The client can view, download, accept or decline it from the link.`}
      onSubmit={data.emailReady ? f.onSubmit : undefined}
      submitLabel="Send email"
      pending={f.pending}
      dirty={f.form.formState.isDirty && !outcome}
      footer={
        data.emailReady ? undefined : (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {notice && notice.tone !== "success" ? (
          <div
            role="alert"
            className={cn("flex gap-2.5 rounded-md border px-3 py-2.5 text-base text-text", notice.tone === "danger" ? "border-danger/30 bg-danger-soft" : "border-warning/40 bg-warning-soft")}
          >
            <CircleAlertIcon className={cn("mt-0.5 size-4 flex-none", notice.tone === "danger" ? "text-danger-text" : "text-warning-text")} aria-hidden="true" />
            <div className="min-w-0">
              <p>{notice.message}</p>
              {notice.detail ? <p className="mt-0.5 text-sm text-text-muted">{notice.detail}</p> : null}
            </div>
          </div>
        ) : null}
        {!data.emailReady ? <EmailSetupBanner canSetUp={data.viewerRole === "partner"} /> : null}
        {handoffFirst ? handoffs : null}
        {data.emailReady ? (
          <section aria-labelledby="send-email-title" className={cn("flex flex-col gap-4", handoffFirst ? "border-t border-border pt-4" : "")}>
            <h3 id="send-email-title" className="flex items-center gap-2 text-sm font-semibold text-text">
              <CircleCheckIcon className="size-4 text-success-text" aria-hidden="true" />
              By email, with the PDF attached
            </h3>
            <FormAlert state={f} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextField control={f.control} name="to" label="To" required type="email" inputMode="email" autoComplete="off" />
              <TextField control={f.control} name="cc" label="Cc" autoComplete="off" helper="Separate several with commas." />
            </div>
            <TextareaField
              control={f.control}
              name="coveringNote"
              label="Covering note"
              rows={4}
              maxLength={4000}
              helper="Shown above the quotation's details. Leave it empty for the standard note."
            />
          </section>
        ) : null}
        {!handoffFirst ? handoffs : null}
      </div>
    </FormDialog>
  )
}

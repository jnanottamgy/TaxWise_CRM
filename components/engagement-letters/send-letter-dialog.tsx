"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { DownloadIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { applySignature, firstNameOf, formatWhatsAppNumber } from "@/lib/domain/messaging"
import { letterFileName, letterShareText } from "@/lib/schemas/engagement-letters"
import { whatsAppTemplateOptions } from "@/lib/schemas/message-templates"
import { issueLetter, recordLetterHandoff } from "@/server/actions/engagement-letters"

/** A contact (or the client itself, `id` null) the letter can go to, with a usable WhatsApp number. */
export type LetterRecipient = { id: string | null; name: string; role: string | null; number: string; primary: boolean; handles: boolean }

/** The firm's messaging settings for the draft: the sender's signature and the firm's templates. */
export type LetterMessaging = {
  firmName: string
  firmPhone: string | null
  signatureFormat: string
  addSignature: boolean
  senderName: string
  templates: Array<{ id: string; name: string; type: string; channel: string; body: string }>
}

/**
 * Send the letter for signature (§7.15.3) on WhatsApp: the message asking them to sign and send it
 * back, and the letter's PDF on the letterhead downloaded in the same click to attach. A Draft is
 * issued first (what the client signs is then fixed). The hand-off is logged as "handed off" and
 * the letter is marked sent for signature. Nothing is emailed.
 */
export function SendLetterDialog({
  open,
  onOpenChange,
  letter,
  recipients,
  messaging,
  today,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  letter: { id: string; updatedAt: string; status: string; clientName: string; clientCode: string; financialYear: string; signatoryName: string | null }
  recipients: LetterRecipient[]
  messaging: LetterMessaging | null
  today: string
}) {
  const router = useRouter()
  const first = recipients.find((r) => r.primary) ?? recipients.find((r) => r.handles) ?? recipients[0] ?? null
  const [pick, setPick] = React.useState<string>(first ? (first.id ?? "client") : "")
  const [issued, setIssued] = React.useState(letter.status !== "draft")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)

  const chosen = recipients.find((r) => (r.id ?? "client") === pick) ?? first
  const firstName = chosen && chosen.id ? firstNameOf(chosen.name) || chosen.name : ""
  const sign = (text: string) => (messaging?.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const draft = sign(letterShareText({ firstName, clientName: letter.clientName, financialYear: letter.financialYear, signatoryName: letter.signatoryName }))
  const templates = messaging
    ? whatsAppTemplateOptions(
        messaging.templates,
        { client_name: letter.clientName, client_code: letter.clientCode, contact_name: firstName, firm_name: messaging.firmName, firm_phone: messaging.firmPhone ?? "", sender_name: messaging.senderName },
        { types: ["custom"], sign },
      )
    : []
  const pdfHref = `/api/pdf/engagement-letter/${letter.id}?download=1`

  const issue = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setError(null)
    setPending(true)
    try {
      const r = await issueLetter({ id: letter.id, updatedAt: letter.updatedAt, issuedOn: today })
      if (!r.ok) return setError({ message: r.error, ref: r.ref })
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success("The letter is issued. Send it on WhatsApp now.")
      setIssued(true)
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  if (!issued) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="sm"
        title="Issue and send for signature"
        description="The letter is issued today, so what the client signs is fixed. Then it goes on WhatsApp with the PDF."
        onSubmit={issue}
        pending={pending}
        submitLabel="Issue, then send on WhatsApp"
      >
        {error ? <FormAlert error={error} /> : null}
        <p className="text-sm text-text-muted">
          {letter.clientName} · FY {letter.financialYear}. To change it after this, withdraw it to a draft.
        </p>
      </FormDialog>
    )
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Send for signature"
      description={`${letter.clientName} · FY ${letter.financialYear}`}
      footer={
        <div className="ml-auto">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {recipients.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium text-text">Send to</legend>
            <RadioGroup value={pick} onValueChange={setPick} className="gap-2">
              {recipients.map((r) => {
                const key = r.id ?? "client"
                return (
                  <div key={key} className="flex items-start gap-2.5">
                    <RadioGroupItem id={`rcp-${key}`} value={key} className="mt-0.5" />
                    <label htmlFor={`rcp-${key}`} className="min-w-0 cursor-pointer text-base leading-5 text-text">
                      {r.name}
                      {r.role ? <span className="text-text-muted"> · {r.role}</span> : null}
                      <span className="num block truncate text-sm text-text-muted tabular-nums">
                        {formatWhatsAppNumber(r.number)}
                        {r.primary ? " · primary" : r.handles ? " · handles these services" : ""}
                      </span>
                    </label>
                  </div>
                )
              })}
            </RadioGroup>
          </fieldset>
        ) : null}
        <p className="text-sm text-text-muted">The PDF on the TaxWise letterhead downloads as WhatsApp opens; attach it in the chat and press Send there.</p>
        <div className="flex flex-wrap items-center gap-2">
          <WhatsAppButton
            recipientName={chosen ? (chosen.id ? `${chosen.name} · ${letter.clientName}` : chosen.name) : letter.clientName}
            number={chosen?.number ?? null}
            draft={draft}
            templates={templates}
            attachment={{ href: pdfHref, filename: letterFileName(letter.financialYear, letter.clientCode, false) }}
            label="Send on WhatsApp"
            size="default"
            disabledReason="No WhatsApp number for this client or its contacts. Add one in Contacts."
            onHandedOff={async ({ number, text }) => {
              const r = await recordLetterHandoff({ id: letter.id, channel: "whatsapp_handoff", contactId: chosen?.id ?? null, recipient: number, body: text })
              if (!r.ok) throw new Error(r.error)
              router.refresh()
            }}
          />
          <Button asChild variant="ghost">
            <a href={pdfHref}>
              <DownloadIcon aria-hidden="true" />
              Download PDF
            </a>
          </Button>
        </div>
      </div>
    </FormDialog>
  )
}

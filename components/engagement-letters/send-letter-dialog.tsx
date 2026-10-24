"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CircleAlertIcon, DownloadIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { cn } from "@/lib/utils"
import { gmailComposeUrl, firstNameOf } from "@/lib/domain/messaging"
import { EMAIL_NOT_SET_UP_MESSAGE, emailOutcomeNotice, type EmailSendOutcome } from "@/lib/handoff"
import { recordLetterHandoff, sendLetterEmail } from "@/server/actions/engagement-letters"
import { newNonce } from "@/components/registers/shared"

export type LetterRecipient = { id: string; name: string; role: string | null; email: string; primary: boolean; handles: boolean }

const OTHER = "__other__"

/**
 * Send the letter for signature (§7.15.3, §10.13): by email from the firm's mailbox with the PDF
 * attached, on the engagement-letter template; a Draft is issued as it goes. If the email can't go
 * (the domain isn't verified, or the send failed), the Gmail hand-off and the PDF download are put
 * in front of you instead (§7.13.3), and the hand-off is logged.
 */
export function SendLetterDialog({
  open,
  onOpenChange,
  letter,
  recipients,
  emailReady,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  letter: { id: string; updatedAt: string; status: string; clientName: string; financialYear: string; signatoryName: string | null }
  recipients: LetterRecipient[]
  emailReady: boolean
}) {
  const router = useRouter()
  const first = recipients.find((r) => r.primary) ?? recipients.find((r) => r.handles) ?? recipients[0] ?? null
  const [pick, setPick] = React.useState<string>(first?.id ?? OTHER)
  const [other, setOther] = React.useState("")
  const [nonce] = React.useState(newNonce)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [outcome, setOutcome] = React.useState<EmailSendOutcome | null>(emailReady ? null : { status: "not_configured" })
  const ids = { other: React.useId() }

  const chosen = pick === OTHER ? null : recipients.find((r) => r.id === pick) ?? null
  const to = chosen?.email ?? other.trim()
  const toName = chosen?.name ?? to
  const pdfHref = `/api/pdf/engagement-letter/${letter.id}?download=1`
  const draft = letter.status === "draft"
  const subject = `Engagement letter for FY ${letter.financialYear}: please sign`
  const body = [
    `Dear ${firstNameOf(chosen?.name ?? "") || "Sir or Madam"},`,
    "",
    `Please find attached our engagement letter for FY ${letter.financialYear} for ${letter.clientName}. Please read it, sign where marked by an authorised signatory, and send the signed copy back to us.`,
    "",
    "Regards,",
    letter.signatoryName ?? "",
  ].join("\n")

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setError(null)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setError({ message: "Enter the email address to send it to." })
      return
    }
    setPending(true)
    try {
      const r = await sendLetterEmail({ id: letter.id, updatedAt: letter.updatedAt, contactId: chosen?.id ?? null, to, nonce })
      if (!r.ok) return setError({ message: r.error, ref: r.ref })
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      router.refresh()
      if (r.data.email.status === "sent") {
        toast.success(`${r.data.issued ? "Issued and emailed" : "Emailed"} to ${toName} for signature.`)
        onOpenChange(false)
        return
      }
      if (r.data.issued) toast.success("The letter is issued.")
      setOutcome(r.data.email)
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const logGmail = async (fields: { to: string; subject: string; body: string }) => {
    const r = await recordLetterHandoff({ id: letter.id, channel: "gmail_handoff", contactId: recipients.find((x) => x.email.toLowerCase() === fields.to.toLowerCase())?.id ?? null, recipient: fields.to, subject: fields.subject, body: fields.body || fields.subject })
    if (!r.ok) throw new Error(r.error)
    router.refresh()
  }

  if (outcome) {
    const notice = outcome.status === "not_configured" && !emailReady ? { tone: "warning" as const, message: EMAIL_NOT_SET_UP_MESSAGE, detail: null } : emailOutcomeNotice(outcome, toName || "the client")
    const Icon = notice.tone === "warning" ? TriangleAlertIcon : CircleAlertIcon
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="sm"
        title={draft && emailReady ? "Issued, but the email didn't go" : "Send it from your mailbox"}
        description={`${letter.clientName} · FY ${letter.financialYear}`}
        footer={
          <div className="ml-auto">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div role="status" className={cn("flex items-start gap-2 text-sm", notice.tone === "warning" ? "text-warning-text" : "text-danger-text")}>
            <Icon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <span className="text-text">
              {notice.message}
              {notice.detail ? <span className="block text-text-muted">{notice.detail}</span> : null}
            </span>
          </div>
          <p className="text-sm text-text-muted">Download the PDF, then open Gmail: the note is filled in; attach the PDF there.{draft && !emailReady ? " Issue the letter from More once it has gone." : ""}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <a href={pdfHref}>
                <DownloadIcon aria-hidden="true" />
                Download PDF
              </a>
            </Button>
            <GmailButton to={to || first?.email || null} subject={subject} body={body} buildUrl={(f) => gmailComposeUrl({ to: f.to, cc: f.cc, subject: f.subject, body: f.body })} pdfHref={pdfHref} size="default" onHandedOff={logGmail} />
          </div>
          {emailReady ? null : (
            <Button type="button" variant="link" className="self-start" onClick={() => setOutcome(null)}>
              Try the email anyway
            </Button>
          )}
        </div>
      </FormDialog>
    )
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={draft ? "Issue and send for signature" : "Send for signature"}
      description={draft ? "The letter is issued as it goes; what the client signs is then fixed." : `${letter.clientName} · FY ${letter.financialYear}`}
      onSubmit={send}
      pending={pending}
      submitLabel={draft ? "Issue and email" : "Send email"}
      dirty={Boolean(other.trim())}
    >
      {error ? <FormAlert error={error} /> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium text-text">Send to</legend>
        <RadioGroup value={pick} onValueChange={setPick} className="gap-2">
          {recipients.map((r) => (
            <div key={r.id} className="flex items-start gap-2.5">
              <RadioGroupItem id={`rcp-${r.id}`} value={r.id} className="mt-0.5" />
              <label htmlFor={`rcp-${r.id}`} className="min-w-0 cursor-pointer text-base leading-5 text-text">
                {r.name}
                {r.role ? <span className="text-text-muted"> · {r.role}</span> : null}
                <span className="block truncate text-sm text-text-muted">
                  {r.email}
                  {r.primary ? " · primary" : r.handles ? " · handles these services" : ""}
                </span>
              </label>
            </div>
          ))}
          <div className="flex items-start gap-2.5">
            <RadioGroupItem id="rcp-other" value={OTHER} className="mt-0.5" />
            <label htmlFor="rcp-other" className="cursor-pointer text-base leading-5 text-text">
              Another address
            </label>
          </div>
        </RadioGroup>
        {pick === OTHER ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <Label htmlFor={ids.other} className="sr-only">
              Email address
            </Label>
            <Input id={ids.other} type="email" inputMode="email" autoComplete="email" value={other} onChange={(e) => setOther(e.target.value)} placeholder="name@company.in" />
          </div>
        ) : null}
      </fieldset>
      <p className="mt-4 text-sm text-text-muted">The letter goes as a PDF on the TaxWise letterhead, with the engagement-letter note asking them to sign and return it.</p>
    </FormDialog>
  )
}

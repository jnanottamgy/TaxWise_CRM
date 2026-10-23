"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2Icon, CircleAlertIcon, DownloadIcon, TriangleAlertIcon } from "lucide-react"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { WhatsAppButton, type MessageTemplateOption } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { EmailSetupBanner } from "@/components/settings/email/email-setup-banner"
import { Money } from "@/components/app/money"
import { cn } from "@/lib/utils"
import { fromPaise, formatINR } from "@/lib/domain/money"
import { formatDate } from "@/lib/format"
import { applySignature, firstNameOf, gmailComposeUrl, pickWhatsAppNumber, upiPayUrl, waMeUrl } from "@/lib/domain/messaging"
import { extractVariables, renderTemplate } from "@/lib/domain/templates"
import { emailOutcomeNotice, type EmailSendOutcome } from "@/lib/handoff"
import { invoiceShareText, type SendChannel } from "@/lib/schemas/invoices"
import type { FormError } from "@/hooks/use-action-form"
import { issueInvoice, recordInvoiceHandoff, sendInvoiceEmail } from "@/server/actions/invoices"
import { newNonce } from "@/components/invoices/invoice-ui"
import type { DetailInvoice, SendContext, SendRecipient } from "@/components/invoices/detail/types"

/**
 * Issue and send, or send again (§7.9.3, §7.13, §10.8). Email goes from the firm's mailbox with the
 * PDF attached and the portal "View & pay" link; WhatsApp and Gmail are hand-offs (the portal link,
 * and on WhatsApp the UPI pay link; never an attachment, §7.13.3) logged as "Handed off"; By hand
 * marks it issued for an invoice handed over in person. Issuing gives the invoice its number and
 * moves it to Sent (§7.9.3 "Sent on the first send of any kind").
 */

type Channel = SendChannel

const CHANNEL_TEXT: Record<Channel, { label: string; hint: string }> = {
  email: { label: "Email", hint: "From the firm's mailbox, with the PDF attached and a View & pay link." },
  whatsapp: { label: "WhatsApp", hint: "Opens WhatsApp with the amount, due date, the portal link and a UPI pay link." },
  gmail: { label: "Gmail", hint: "Opens Gmail compose with the portal link. Attach the PDF yourself if you want." },
  in_person: { label: "By hand", hint: "You give the client a printed copy. The invoice is issued; nothing is sent." },
}

type Address = { key: string; email: string; name: string; contactId: string | null; bounced: boolean; primary: boolean }

function addressesOf(send: SendContext): Address[] {
  const out: Address[] = []
  const seen = new Set<string>()
  for (const r of send.recipients) {
    if (!r.email) continue
    const k = r.email.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ key: k, email: r.email, name: r.name, contactId: r.contactId, bounced: r.bounced, primary: r.primary })
  }
  if (send.client.email && !seen.has(send.client.email.toLowerCase())) {
    out.push({ key: send.client.email.toLowerCase(), email: send.client.email, name: "Client email", contactId: null, bounced: false, primary: out.length === 0 })
  }
  return out
}

function splitAddresses(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function defaultChannel(mode: "issue" | "send", send: SendContext, addresses: Address[], hasNumber: boolean): Channel {
  if (send.emailReady && addresses.some((a) => !a.bounced)) return "email"
  if (hasNumber) return "whatsapp"
  if (addresses.length) return "gmail"
  return mode === "issue" ? "in_person" : "email"
}

export function SendInvoiceDialog({
  mode,
  invoice,
  send,
  onClose,
}: {
  mode: "issue" | "send"
  invoice: DetailInvoice
  send: SendContext
  onClose: () => void
}) {
  const router = useRouter()
  const addresses = React.useMemo(() => addressesOf(send), [send])
  const primary = send.recipients.find((r) => r.primary) ?? send.recipients[0] ?? null
  const [contactKey, setContactKey] = React.useState<string>(primary?.contactId ?? "")
  const contact: SendRecipient | null = send.recipients.find((r) => (r.contactId ?? "") === contactKey) ?? primary
  const number = pickWhatsAppNumber(contact, send.client, { countryCode: send.countryCode })
  const [channel, setChannel] = React.useState<Channel>(() => defaultChannel(mode, send, addresses, Boolean(pickWhatsAppNumber(primary, send.client, { countryCode: send.countryCode }))))
  const [picked, setPicked] = React.useState<Set<string>>(() => {
    const first = addresses.find((a) => a.primary && !a.bounced) ?? addresses.find((a) => !a.bounced)
    return new Set(first ? [first.key] : [])
  })
  const [extra, setExtra] = React.useState("")
  const [cc, setCc] = React.useState("")
  const [note, setNote] = React.useState("")
  const [nonce] = React.useState(newNonce)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)
  const [fieldError, setFieldError] = React.useState<Record<string, string>>({})
  /** After a successful issue or send: the number, and what happened to the email. */
  const [done, setDone] = React.useState<{ number: string; email: EmailSendOutcome | null; to: string } | null>(null)
  const ids = { extra: React.useId(), cc: React.useId(), note: React.useId(), contact: React.useId() }

  const invoiceNumber = done?.number ?? invoice.number
  const issued = mode === "send" || done !== null
  const duePaise = invoice.outstandingPaise > 0 ? invoice.outstandingPaise : invoice.totalPaise
  let upiUrl: string | null = null
  if (send.upi && duePaise > 0 && invoiceNumber) {
    try {
      upiUrl = upiPayUrl({ upiId: send.upi.id, payee: send.upi.payee, amountPaise: duePaise, note: `Invoice ${invoiceNumber}` })
    } catch {
      upiUrl = null
    }
  }
  const contactName = contact?.name ? firstNameOf(contact.name) || contact.name : null
  const share = invoiceNumber
    ? invoiceShareText({
        contactName,
        clientName: invoice.clientName,
        invoiceNumber,
        periodLabel: invoice.periodLabel,
        totalPaise: invoice.totalPaise,
        duePaise,
        dueDate: invoice.dueDate,
        portalUrl: send.portalUrl,
        upiUrl,
        firmName: send.firmName,
        senderName: send.senderName,
        bank: send.bank,
      })
    : null
  const sign = (text: string) => (send.addSignature ? applySignature(text, send.signatureFormat, firstNameOf(send.senderName)) : text)
  const templateValues = {
    client_name: invoice.clientName,
    contact_name: contactName ?? "",
    invoice_number: invoiceNumber ?? "",
    amount: formatINR(duePaise),
    payment_link: send.portalUrl,
    portal_link: send.portalUrl,
    upi_link: upiUrl ?? "",
    due_date: formatDate(invoice.dueDate),
    firm_name: send.firmName,
    firm_phone: send.firmPhone ?? "",
    sender_name: send.senderName,
  }
  const templates: MessageTemplateOption[] = send.templates
    .filter((t) => (t.channel === "whatsapp" || t.channel === "any") && extractVariables(t.body).some((v) => v === "invoice_number" || v === "payment_link" || v === "upi_link"))
    .map((t) => ({ id: t.id, name: t.name, body: sign(renderTemplate(t.body, templateValues, { missing: "mark" })) }))

  const toList = [...addresses.filter((a) => picked.has(a.key)).map((a) => a.email), ...splitAddresses(extra)]
  const emailContactId = addresses.find((a) => picked.has(a.key) && a.contactId)?.contactId ?? null
  const recipientName = addresses.find((a) => picked.has(a.key))?.name ?? toList[0] ?? "the client"

  const fail = (r: { error: string; ref?: string; fieldErrors?: Record<string, string[]> }) => {
    const fe: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.fieldErrors ?? {})) if (v[0]) fe[k.replace(/^email\./, "")] = v[0]
    setFieldError(fe)
    setError({ message: r.error, ref: r.ref })
  }

  const emailInput = () => ({ to: toList, cc: cc.trim(), contactId: emailContactId, note: note.trim(), nonce })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setError(null)
    setFieldError({})
    if (channel === "email" && toList.length === 0) {
      setFieldError({ to: "Choose at least one email address." })
      setError({ message: "Choose who the invoice goes to.", client: true })
      return
    }
    setPending(true)
    try {
      if (mode === "issue") {
        const r = await issueInvoice({ invoiceId: invoice.id, updatedAt: invoice.updatedAt, channel, email: channel === "email" ? emailInput() : null })
        if (!r.ok) return fail(r)
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        router.refresh()
        if (channel === "in_person") {
          toast.success(`Issued as ${r.data.invoiceNumber}. Download the PDF to print it.`)
          onClose()
          return
        }
        if (channel === "email" && r.data.email?.status === "sent") {
          toast.success(`Issued as ${r.data.invoiceNumber} and emailed to ${recipientName}.`)
          onClose()
          return
        }
        setDone({ number: r.data.invoiceNumber, email: r.data.email, to: recipientName })
        return
      }
      if (channel === "email") {
        const r = await sendInvoiceEmail({ invoiceId: invoice.id, ...emailInput() })
        if (!r.ok) return fail(r)
        router.refresh()
        if (r.data.email.status === "sent") {
          toast.success(`Emailed to ${recipientName}.`)
          onClose()
          return
        }
        setDone({ number: invoice.number ?? "", email: r.data.email, to: recipientName })
      }
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const logWhatsApp = async (info: { number: string; text: string }) => {
    const r = await recordInvoiceHandoff({ invoiceId: invoice.id, channel: "whatsapp_handoff", contactId: contact?.contactId ?? null, recipient: info.number, body: info.text })
    if (!r.ok) throw new Error(r.error)
    router.refresh()
  }
  const logGmail = async (fields: { to: string; subject: string; body: string }) => {
    const r = await recordInvoiceHandoff({
      invoiceId: invoice.id,
      channel: "gmail_handoff",
      contactId: send.recipients.find((x) => x.email?.toLowerCase() === fields.to.toLowerCase())?.contactId ?? null,
      recipient: fields.to,
      subject: fields.subject,
      body: fields.body || fields.subject,
    })
    if (!r.ok) throw new Error(r.error)
    router.refresh()
  }

  const pdfHref = `/api/pdf/invoice/${invoice.id}?download=1`
  const gmailTo = contact?.email ?? addresses.find((a) => !a.bounced)?.email ?? null
  const handoffButtons = share ? (
    <div className="flex flex-wrap items-center gap-2">
      <WhatsAppButton
        recipientName={`${contact?.name ?? "Client"} · ${invoice.clientName}`}
        number={number?.digits ?? null}
        draft={sign(share.whatsapp)}
        templates={templates}
        buildUrl={waMeUrl}
        size="default"
        variant="outline"
        onHandedOff={logWhatsApp}
      />
      <GmailButton to={gmailTo} subject={share.subject} body={share.emailBody} buildUrl={(f) => gmailComposeUrl({ to: f.to, cc: f.cc, subject: f.subject, body: f.body })} pdfHref={pdfHref} size="default" onHandedOff={logGmail} />
    </div>
  ) : null

  // ---- After issuing / a failed email: what happened, and the hand-offs --------------------------
  if (done) {
    const notice = done.email ? emailOutcomeNotice(done.email, done.to) : null
    const Icon = !notice || notice.tone === "success" ? CheckCircle2Icon : notice.tone === "warning" ? TriangleAlertIcon : CircleAlertIcon
    return (
      <FormDialog
        open
        onOpenChange={(o) => (!o ? onClose() : undefined)}
        size="sm"
        title={mode === "issue" ? `Issued as ${done.number}` : "The email didn't go"}
        description={mode === "issue" ? "It has its number and is marked Sent. Send it now:" : `Invoice ${done.number}`}
        footer={
          <div className="ml-auto">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {notice ? (
            <div role="status" className={cn("flex items-start gap-2 text-sm", notice.tone === "success" ? "text-success-text" : notice.tone === "warning" ? "text-warning-text" : "text-danger-text")}>
              <Icon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
              <span className="text-text">
                {notice.message}
                {notice.detail ? <span className="block text-text-muted">{notice.detail}</span> : null}
              </span>
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              {channel === "whatsapp" ? "Open WhatsApp to send the message. You press Send there." : "Open Gmail to send it from your mailbox."}
            </p>
          )}
          {handoffButtons}
          <Button asChild variant="ghost" className="self-start">
            <a href={pdfHref}>
              <DownloadIcon aria-hidden="true" />
              Download PDF
            </a>
          </Button>
        </div>
      </FormDialog>
    )
  }

  const channels: Channel[] = mode === "issue" ? ["email", "whatsapp", "gmail", "in_person"] : ["email", "whatsapp", "gmail"]
  const handoffNow = issued && (channel === "whatsapp" || channel === "gmail")
  const submitLabel =
    mode === "issue"
      ? channel === "email"
        ? "Issue and email"
        : channel === "in_person"
          ? "Issue"
          : `Issue, then open ${CHANNEL_TEXT[channel].label}`
      : "Send email"

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title={mode === "issue" ? "Issue and send" : `Send ${invoice.number ?? "the invoice"}`}
      description={
        <>
          {invoice.clientName} · <Money value={fromPaise(invoice.totalPaise)} />
          {mode === "issue" ? " · It gets its number now and can't be edited after." : null}
        </>
      }
      onSubmit={submit}
      pending={pending}
      submitLabel={submitLabel}
      submitDisabled={mode === "issue" && ((channel === "whatsapp" && !number) || (channel === "gmail" && !gmailTo))}
      dirty={Boolean(note.trim() || extra.trim() || cc.trim())}
      footer={
        handoffNow ? (
          <div className="ml-auto">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : undefined
      }
    >
      <FormAlert error={error} />
      <fieldset className="mb-5">
        <legend className="mb-2 text-sm font-medium text-text">Send by</legend>
        <RadioGroup value={channel} onValueChange={(v) => setChannel(v as Channel)} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {channels.map((c) => (
            <label
              key={c}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-base",
                channel === c ? "border-primary bg-primary-soft/40 text-text" : "border-border text-text hover:bg-surface-2"
              )}
            >
              <RadioGroupItem value={c} aria-label={CHANNEL_TEXT[c].label} />
              {CHANNEL_TEXT[c].label}
            </label>
          ))}
        </RadioGroup>
        <p className="mt-2 text-sm text-text-muted">{CHANNEL_TEXT[channel].hint}</p>
      </fieldset>

      {channel === "email" ? (
        <div className="flex flex-col gap-4">
          {!send.emailReady ? <EmailSetupBanner canSetUp={send.canSetUpEmail} /> : null}
          <fieldset aria-describedby={fieldError.to ? "send-to-err" : undefined}>
            <legend className="mb-1.5 text-sm font-medium text-text">
              To <span className="text-danger-text">*</span>
            </legend>
            {addresses.length ? (
              <ul className="flex flex-col">
                {addresses.map((a) => (
                  <li key={a.key}>
                    <label className="flex min-h-10 cursor-pointer items-center gap-3 py-1">
                      <Checkbox
                        checked={picked.has(a.key)}
                        onCheckedChange={(v) =>
                          setPicked((prev) => {
                            const next = new Set(prev)
                            if (v === true) next.add(a.key)
                            else next.delete(a.key)
                            return next
                          })
                        }
                        aria-label={`Send to ${a.email}`}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-base text-text">{a.email}</span>
                        <span className="text-xs text-text-muted">
                          {a.name}
                          {a.primary ? " · primary" : ""}
                          {a.bounced ? <span className="text-danger-text"> · last email bounced</span> : null}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">No email address on file for this client. Type one below, or add it in Contacts.</p>
            )}
            {fieldError.to ? (
              <p id="send-to-err" className="mt-1 text-xs text-danger-text">
                {fieldError.to}
              </p>
            ) : null}
          </fieldset>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.extra}>Also send to</Label>
              <Input id={ids.extra} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="accounts@client.in" autoComplete="off" inputMode="email" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.cc}>CC</Label>
              <Input id={ids.cc} value={cc} onChange={(e) => setCc(e.target.value)} autoComplete="off" inputMode="email" aria-invalid={fieldError.cc ? true : undefined} />
              {fieldError.cc ? <p className="text-xs text-danger-text">{fieldError.cc}</p> : null}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.note}>Covering note</Label>
            <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} placeholder="Optional. It goes above the invoice summary in the email." />
          </div>
        </div>
      ) : channel === "in_person" ? (
        <p className="text-base text-text">
          The invoice gets its number and is marked Sent, handed over in person. Download the PDF from the invoice page to print it.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {send.recipients.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.contact}>Contact</Label>
              <div className="[&>[data-slot=native-select-wrapper]]:w-full">
                <NativeSelect id={ids.contact} value={contactKey} onChange={(e) => setContactKey(e.target.value)}>
                  {send.recipients.map((r) => (
                    <NativeSelectOption key={r.contactId ?? "client"} value={r.contactId ?? ""}>
                      {r.name}
                      {r.primary ? " (primary)" : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          ) : null}
          {issued ? (
            <>
              <p className="text-sm text-text-muted">
                {channel === "whatsapp"
                  ? "Shows the message first; Open WhatsApp hands it over. It's logged as handed off, never as delivered."
                  : "Shows the email first; Open Gmail hands it over. It's logged as handed off."}
              </p>
              {handoffButtons}
            </>
          ) : (
            <p className="text-base text-text">
              {channel === "whatsapp"
                ? number
                  ? "The invoice is issued first, so the message carries its number. Then WhatsApp opens with the message for you to send."
                  : "No WhatsApp number for this contact. Add one in Contacts, or choose another way."
                : gmailTo
                  ? "The invoice is issued first, so the email carries its number. Then Gmail opens with the email for you to send."
                  : "No email address for this contact. Add one in Contacts, or choose another way."}
            </p>
          )}
        </div>
      )}
    </FormDialog>
  )
}

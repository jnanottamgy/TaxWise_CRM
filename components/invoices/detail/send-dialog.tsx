"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { DownloadIcon } from "lucide-react"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Money } from "@/components/app/money"
import { cn } from "@/lib/utils"
import { fromPaise, formatINR } from "@/lib/domain/money"
import { formatDate, pdfFileName } from "@/lib/format"
import { applySignature, firstNameOf, pickWhatsAppNumber, upiPayUrl } from "@/lib/domain/messaging"
import { extractVariables } from "@/lib/domain/templates"
import { whatsAppTemplateOptions } from "@/lib/schemas/message-templates"
import { invoiceShareText, type SendChannel } from "@/lib/schemas/invoices"
import type { FormError } from "@/hooks/use-action-form"
import { issueInvoice, recordInvoiceHandoff } from "@/server/actions/invoices"
import type { DetailInvoice, SendContext, SendRecipient } from "@/components/invoices/detail/types"

/**
 * Issue and send, or send again (§7.9.3, §7.13.2). The firm sends invoices on WhatsApp: Send on
 * WhatsApp opens the client's chat with the message typed in (amount, due date, the portal "View &
 * pay" link and the UPI pay link) and downloads the invoice PDF in the same click, to attach there;
 * it is logged as "Handed off". By hand marks it issued for an invoice handed over in person.
 * Issuing gives the invoice its number and moves it to Sent (§7.9.3 "Sent on the first send of any
 * kind"), so the message and the PDF carry the number.
 */

const CHANNEL_TEXT: Record<SendChannel, { label: string; hint: string }> = {
  whatsapp: { label: "WhatsApp", hint: "Opens WhatsApp with the amount, due date, the portal link and a UPI pay link, and downloads the PDF to attach." },
  in_person: { label: "By hand", hint: "You give the client a printed copy. The invoice is issued; nothing is sent." },
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
  const primary = send.recipients.find((r) => r.primary) ?? send.recipients[0] ?? null
  const [contactKey, setContactKey] = React.useState<string>(primary?.contactId ?? "")
  const contact: SendRecipient | null = send.recipients.find((r) => (r.contactId ?? "") === contactKey) ?? primary
  const number = pickWhatsAppNumber(contact, send.client, { countryCode: send.countryCode })
  const [channel, setChannel] = React.useState<SendChannel>(() => (mode === "issue" && !pickWhatsAppNumber(primary, send.client, { countryCode: send.countryCode }) ? "in_person" : "whatsapp"))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)
  /** After a successful issue: the number, for the message and the PDF. */
  const [issuedAs, setIssuedAs] = React.useState<string | null>(null)
  const contactId = React.useId()

  const invoiceNumber = issuedAs ?? invoice.number
  const issued = mode === "send" || issuedAs !== null
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
  // Templates about an invoice: those that name it, its payment link or its UPI link.
  const invoiceTemplates = send.templates.filter((t) => extractVariables(t.body).some((v) => v === "invoice_number" || v === "payment_link" || v === "upi_link"))
  const templates = whatsAppTemplateOptions(invoiceTemplates, templateValues, { sign })
  const draft = invoiceNumber
    ? sign(
        invoiceShareText({
          contactName,
          invoiceNumber,
          periodLabel: invoice.periodLabel,
          totalPaise: invoice.totalPaise,
          duePaise,
          dueDate: invoice.dueDate,
          portalUrl: send.portalUrl,
          upiUrl,
          firmName: send.firmName,
        }),
      )
    : ""
  const pdfHref = `/api/pdf/invoice/${invoice.id}?download=1`
  const attachment = invoiceNumber ? { href: pdfHref, filename: pdfFileName(invoiceNumber, invoice.kind === "debit_note" ? "Debit note" : "Invoice") } : undefined

  const logWhatsApp = async (info: { number: string; text: string; templateId: string | null }) => {
    const r = await recordInvoiceHandoff({ invoiceId: invoice.id, channel: "whatsapp_handoff", contactId: contact?.contactId ?? null, recipient: info.number, body: info.text })
    if (!r.ok) throw new Error(r.error)
    router.refresh()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending || mode !== "issue") return
    setError(null)
    setPending(true)
    try {
      const r = await issueInvoice({ invoiceId: invoice.id, updatedAt: invoice.updatedAt, channel })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      router.refresh()
      if (channel === "in_person") {
        toast.success(`Issued as ${r.data.invoiceNumber}. Download the PDF to print it.`)
        onClose()
        return
      }
      setIssuedAs(r.data.invoiceNumber)
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const contactPicker =
    send.recipients.length > 1 ? (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={contactId}>Contact</Label>
        <div className="[&>[data-slot=native-select-wrapper]]:w-full">
          <NativeSelect id={contactId} value={contactKey} onChange={(e) => setContactKey(e.target.value)}>
            {send.recipients.map((r) => (
              <NativeSelectOption key={r.contactId ?? "client"} value={r.contactId ?? ""}>
                {r.name}
                {r.primary ? " (primary)" : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
    ) : null

  const handoff = (
    <div className="flex flex-wrap items-center gap-2">
      <WhatsAppButton
        recipientName={`${contact?.name ?? "Client"} · ${invoice.clientName}`}
        number={number?.digits ?? null}
        draft={draft}
        templates={templates}
        attachment={attachment}
        label="Send on WhatsApp"
        size="default"
        onHandedOff={logWhatsApp}
      />
      <Button asChild variant="ghost">
        <a href={pdfHref}>
          <DownloadIcon aria-hidden="true" />
          Download PDF
        </a>
      </Button>
    </div>
  )

  // ---- Issued (or sending again): the WhatsApp hand-off with the PDF -----------------------------
  if (issued) {
    return (
      <FormDialog
        open
        onOpenChange={(o) => (!o ? onClose() : undefined)}
        size="sm"
        title={issuedAs ? `Issued as ${issuedAs}` : `Send ${invoice.number ?? "the invoice"}`}
        description={
          issuedAs ? (
            "It has its number and is marked Sent. Send it to the client now:"
          ) : (
            <>
              {invoice.clientName} · <Money value={fromPaise(duePaise)} /> {invoice.outstandingPaise > 0 && invoice.outstandingPaise !== invoice.totalPaise ? "still to pay" : ""}
            </>
          )
        }
        footer={
          <div className="ml-auto">
            <Button type="button" variant={issuedAs ? "default" : "outline"} onClick={onClose}>
              {issuedAs ? "Done" : "Close"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {contactPicker}
          <p className="text-sm text-text-muted">
            Shows the message first, with a template to switch to. Then WhatsApp opens with it typed in and the PDF downloads to attach; you press Send there. It&apos;s logged as handed off,
            never as delivered.
          </p>
          {handoff}
        </div>
      </FormDialog>
    )
  }

  // ---- Issue and send ----------------------------------------------------------------------------
  const channels: SendChannel[] = ["whatsapp", "in_person"]
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="Issue and send"
      description={
        <>
          {invoice.clientName} · <Money value={fromPaise(invoice.totalPaise)} /> · It gets its number now and can&apos;t be edited after.
        </>
      }
      onSubmit={submit}
      pending={pending}
      submitLabel={channel === "in_person" ? "Issue" : "Issue, then send on WhatsApp"}
      submitDisabled={channel === "whatsapp" && !number}
    >
      <FormAlert error={error} />
      <fieldset className="mb-5">
        <legend className="mb-2 text-sm font-medium text-text">Send by</legend>
        <RadioGroup value={channel} onValueChange={(v) => setChannel(v as SendChannel)} className="grid grid-cols-2 gap-2">
          {channels.map((c) => (
            <label
              key={c}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-base",
                channel === c ? "border-primary bg-primary-soft/40 text-text" : "border-border text-text hover:bg-surface-2",
              )}
            >
              <RadioGroupItem value={c} aria-label={CHANNEL_TEXT[c].label} />
              {CHANNEL_TEXT[c].label}
            </label>
          ))}
        </RadioGroup>
        <p className="mt-2 text-sm text-text-muted">{CHANNEL_TEXT[channel].hint}</p>
      </fieldset>

      {channel === "in_person" ? (
        <p className="text-base text-text">The invoice gets its number and is marked Sent, handed over in person. Download the PDF from the invoice page to print it.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {contactPicker}
          <p className="text-base text-text">
            {number
              ? "The invoice is issued first, so the message and the PDF carry its number. Then Send on WhatsApp opens the chat with the message typed in and downloads the PDF to attach."
              : "No WhatsApp number for this contact. Add one in Contacts, or choose By hand."}
          </p>
        </div>
      )}
    </FormDialog>
  )
}

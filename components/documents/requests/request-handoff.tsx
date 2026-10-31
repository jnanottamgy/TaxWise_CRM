"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { WhatsAppButton, type MessageTemplateOption } from "@/components/app/messaging/whatsapp-button"
import { applySignature, firstNameOf, pickWhatsAppNumber } from "@/lib/domain/messaging"
import { renderTemplate } from "@/lib/domain/templates"
import { formatDate } from "@/lib/format"
import { outstandingLines, requestHandoffDraft, type DraftItem } from "@/lib/schemas/document-requests"
import { logHandoff } from "@/server/actions/messages"
import { recordRequestHandoff } from "@/server/actions/document-requests"

/**
 * Send on WhatsApp for a document request (§7.13.2 "Document request: the list of pending items +
 * portal link", §7.14 sending): the request or a reminder, from the firm's document-reminder
 * templates or the suggested message. It opens a preview first; once opened it is logged as
 * "handed off" (never "delivered") in the client's messages and counts as a reminder, so the
 * morning job doesn't ask for another one straight away.
 */

export interface HandoffMessaging {
  firmName: string
  firmPhone: string | null
  countryCode: string
  signatureFormat: string
  addSignature: boolean
  senderName: string
  /** Document-reminder templates (WhatsApp or any channel), unrendered. */
  templates: Array<{ id: string; name: string; body: string; channel: string }>
}

export interface HandoffRecipient {
  contactId: string | null
  name: string | null
  phone: string | null
  whatsapp: string | null
}

export function RequestHandoff({
  clientId,
  clientName,
  clientCode,
  client,
  recipient,
  request,
  items,
  portalLink,
  messaging,
  reminder = false,
  size = "sm",
}: {
  clientId: string
  clientName: string
  clientCode: string
  /** The client's own numbers, used when the contact has none (§7.13.2 "Which number"). */
  client: { phone: string | null; whatsapp: string | null }
  recipient: HandoffRecipient | null
  request: { id: string; title: string; due_date: string | null }
  items: DraftItem[]
  portalLink: string
  messaging: HandoffMessaging
  reminder?: boolean
  size?: "sm" | "default"
}) {
  const router = useRouter()
  const contactName = recipient?.name ? firstNameOf(recipient.name) || recipient.name : null
  const dueText = request.due_date ? formatDate(request.due_date) : null
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const draft = requestHandoffDraft({ contactName, clientName, title: request.title, items, dueDateText: dueText, portalLink, reminder })
  const values = {
    client_name: clientName,
    client_code: clientCode,
    contact_name: contactName ?? "",
    missing_items: outstandingLines(items).join("\n"),
    due_date: dueText ?? "",
    portal_link: portalLink,
    firm_name: messaging.firmName,
    firm_phone: messaging.firmPhone ?? "",
    sender_name: messaging.senderName,
  }
  const templates: MessageTemplateOption[] = messaging.templates
    .filter((t) => t.channel === "whatsapp" || t.channel === "any")
    .map((t) => ({ id: t.id, name: t.name, body: sign(renderTemplate(t.body, values, { missing: "mark" })) }))
  const number = pickWhatsAppNumber(recipient, client, { countryCode: messaging.countryCode })

  const record = async () => {
    const r = await recordRequestHandoff({ id: request.id, clientId })
    if (!r.ok) toast.warning(`Handed off, but the reminder count wasn't updated: ${r.error}`)
    router.refresh()
  }

  return (
    <WhatsAppButton
      recipientName={`${recipient?.name ?? "Client"} · ${clientName}`}
      number={number?.digits ?? null}
      draft={sign(draft)}
      templates={templates}
      label={reminder ? "Remind on WhatsApp" : "Send on WhatsApp"}
      size={size}
      variant="outline"
      disabledReason="No WhatsApp number for this client. Add one in Contacts."
      onHandedOff={async ({ number: n, text, templateId }) => {
        const r = await logHandoff({
          clientId,
          contactId: recipient?.contactId ?? null,
          channel: "whatsapp_handoff",
          recipient: n,
          body: text,
          templateId,
          related: { type: "document_request", id: request.id },
        })
        if (!r.ok) throw new Error(r.error)
        await record()
      }}
    />
  )
}

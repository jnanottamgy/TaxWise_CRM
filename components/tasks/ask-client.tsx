"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { WhatsAppButton, type MessageTemplateOption } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { applySignature, firstNameOf, gmailComposeUrl, pickWhatsAppNumber, waMeUrl } from "@/lib/domain/messaging"
import { renderTemplate } from "@/lib/domain/templates"
import { askClientDraft, askClientSubject, askClientValues, type AskClientFacts } from "@/lib/schemas/tasks"
import { logHandoff } from "@/server/actions/messages"

/**
 * "Ask client for data" (§7.6.6; §7.6.4 Data awaited "with WhatsApp/email drafts asking the client
 * for what's missing"): WhatsApp and Gmail hand-offs with the open checklist items as the list of
 * what's missing, from the firm's document-reminder templates (§7.13.4) or a suggested message.
 * Each opens a preview first; once opened it is logged against the task as "handed off", never
 * "delivered" (§7.13.1).
 */

export type AskClientMessaging = {
  firmName: string
  firmPhone: string | null
  countryCode: string
  signatureFormat: string
  addSignature: boolean
  senderName: string
  templates: Array<{ id: string; name: string; channel: string; subject: string | null; body: string }>
}

export type AskClientRecipient = {
  contact: { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null } | null
  client: { phone: string | null; whatsapp: string | null; email: string | null } | null
}

export function AskClientForData({
  taskId,
  clientId,
  facts,
  recipient,
  messaging,
  size = "default",
  variant = "outline",
}: {
  taskId: string
  clientId: string
  facts: Omit<AskClientFacts, "contactName" | "firmName" | "firmPhone" | "senderName">
  recipient: AskClientRecipient
  messaging: AskClientMessaging
  size?: "sm" | "default"
  /** `ghost` where the buttons repeat down a list (the Data awaited call list). */
  variant?: "outline" | "ghost"
}) {
  const router = useRouter()
  const contactName = recipient.contact?.name ? firstNameOf(recipient.contact.name) || recipient.contact.name : null
  const full: AskClientFacts = { ...facts, contactName, firmName: messaging.firmName, firmPhone: messaging.firmPhone, senderName: messaging.senderName }
  const values = askClientValues(full)
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const draft = askClientDraft(full)
  const waTemplates: MessageTemplateOption[] = messaging.templates
    .filter((t) => t.channel === "whatsapp" || t.channel === "any")
    .map((t) => ({ id: t.id, name: t.name, body: sign(renderTemplate(t.body, values, { missing: "mark" })) }))
  const emailTemplate = messaging.templates.find((t) => t.channel === "email" || t.channel === "any")
  const subject = emailTemplate?.subject ? renderTemplate(emailTemplate.subject, values) : askClientSubject(full)
  const emailBody = emailTemplate ? renderTemplate(emailTemplate.body, values, { missing: "mark" }) : draft
  const number = pickWhatsAppNumber(recipient.contact, recipient.client, { countryCode: messaging.countryCode })
  const email = recipient.contact?.email ?? recipient.client?.email ?? null

  return (
    <>
      <WhatsAppButton
        recipientName={`${recipient.contact?.name ?? "Client"} · ${facts.clientName}`}
        number={number?.digits ?? null}
        draft={sign(draft)}
        templates={waTemplates}
        buildUrl={waMeUrl}
        size={size === "sm" ? "sm" : "default"}
        variant={variant}
        label="Ask on WhatsApp"
        disabledReason="No WhatsApp number for this client. Add one in Contacts."
        onHandedOff={async ({ number: n, text, templateId }) => {
          const r = await logHandoff({ clientId, contactId: recipient.contact?.id ?? null, channel: "whatsapp_handoff", recipient: n, body: text, templateId, related: { type: "task", id: taskId } })
          if (!r.ok) throw new Error(r.error)
          router.refresh()
        }}
      />
      <GmailButton
        to={email}
        subject={subject}
        body={emailBody}
        buildUrl={(fields) => gmailComposeUrl({ to: fields.to, cc: fields.cc, subject: fields.subject, body: fields.body })}
        size={size === "sm" ? "sm" : "default"}
        variant={variant}
        label="Ask by email"
        disabledReason="No email address for this client. Add one in Contacts."
        onHandedOff={async (fields) => {
          const r = await logHandoff({
            clientId,
            contactId: recipient.contact?.id ?? null,
            channel: "gmail_handoff",
            recipient: fields.to,
            subject: fields.subject,
            body: fields.body || fields.subject,
            templateId: emailTemplate?.id ?? null,
            related: { type: "task", id: taskId },
          })
          if (!r.ok) throw new Error(r.error)
          router.refresh()
        }}
      />
    </>
  )
}

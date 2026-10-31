"use client"

import * as React from "react"
import { MailIcon, PhoneIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Explain } from "@/components/app/explain"
import { WhatsAppButton, type MessageTemplateOption } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { gmailComposeUrl, mailtoUrl } from "@/lib/domain/messaging"
import { logHandoff } from "@/server/actions/messages"

export interface ContactTarget {
  clientId: string
  contactId: string | null
  /** "Rakesh Sharma · Sharma Traders" */
  recipientName: string
  /** For tel: and display ("+91 98450 12345", "080 2345 6789"). */
  phone: string | null
  /** Normalised WhatsApp digits (pickWhatsAppNumber), or null. */
  whatsapp: string | null
  email: string | null
}

/**
 * Call · WhatsApp · Email · Gmail for a client or one contact (§7.3.3 header, §7.13.2, §7.13.3).
 * WhatsApp and Gmail open a preview first and log the hand-off (`handed_off`, never "delivered");
 * Call opens the phone (tel:) and Email the default mail app (mailto:). A missing number or address
 * keeps the button visible but disabled, saying why.
 */
export function ContactButtons({
  target,
  draft,
  templates,
  emailSubject,
  emailBody,
  compact = false,
  scope = "client",
}: {
  target: ContactTarget
  draft: string
  templates?: MessageTemplateOption[]
  emailSubject: string
  emailBody: string
  /** Icon-only buttons (contact rows). */
  compact?: boolean
  /** Whose number is missing, for the disabled buttons' explanation. */
  scope?: "client" | "contact"
}) {
  const who = scope === "contact" ? "this contact" : "this client"
  const tel = target.phone ? `tel:${target.phone.replace(/[^\d+]/g, "")}` : null
  const mailto = target.email ? mailtoUrl({ to: target.email, subject: emailSubject, body: "" }) : null

  const onWhatsApp = async ({ number, text, templateId }: { number: string; text: string; templateId: string | null }) => {
    const r = await logHandoff({ clientId: target.clientId, contactId: target.contactId, channel: "whatsapp_handoff", recipient: number, body: text, templateId })
    if (!r.ok) throw new Error(r.error)
  }
  const onGmail = async (f: { to: string; subject: string; body: string }) => {
    const r = await logHandoff({ clientId: target.clientId, contactId: target.contactId, channel: "gmail_handoff", recipient: f.to, subject: f.subject, body: f.body || f.subject })
    if (!r.ok) throw new Error(r.error)
  }

  return (
    // Phones: a 2 × 2 grid of full-width buttons instead of three in a row and a stray fourth.
    <div className={compact ? "flex flex-wrap items-center gap-2" : "grid grid-cols-2 gap-2 *:w-full sm:flex sm:flex-wrap sm:items-center sm:*:w-auto"}>
      {tel ? (
        <Button asChild variant="outline" size={compact ? "icon-sm" : "sm"} aria-label={compact ? `Call ${target.recipientName}` : undefined}>
          <a href={tel}>
            <PhoneIcon aria-hidden="true" />
            {compact ? null : "Call"}
          </a>
        </Button>
      ) : (
        <Unavailable label="Call" compact={compact} reason={`No phone number for ${who}. Add one in Contacts.`} icon={<PhoneIcon aria-hidden="true" />} />
      )}
      <WhatsAppButton
        recipientName={target.recipientName}
        number={target.whatsapp}
        draft={draft}
        templates={templates}
        onHandedOff={onWhatsApp}
        variant="outline"
        size="sm"
        iconOnly={compact}
        disabledReason={`No WhatsApp number for ${who}. Add one in Contacts.`}
      />
      {mailto ? (
        <Button asChild variant="outline" size={compact ? "icon-sm" : "sm"} aria-label={compact ? `Email ${target.recipientName}` : undefined}>
          <a href={mailto}>
            <MailIcon aria-hidden="true" />
            {compact ? null : "Email"}
          </a>
        </Button>
      ) : (
        <Unavailable label="Email" compact={compact} reason={`No email address for ${who}. Add one in Contacts.`} icon={<MailIcon aria-hidden="true" />} />
      )}
      <GmailButton
        to={target.email}
        subject={emailSubject}
        body={emailBody}
        buildUrl={(f) => gmailComposeUrl({ to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, body: f.body })}
        onHandedOff={onGmail}
        size="sm"
        iconOnly={compact}
        disabledReason={`No email address for ${who}. Add one in Contacts.`}
      />
    </div>
  )
}

function Unavailable({ label, reason, icon, compact }: { label: string; reason: string; icon: React.ReactNode; compact: boolean }) {
  return (
    <Explain content={<p>{reason}</p>}>
      <Button
        type="button"
        variant="outline"
        size={compact ? "icon-sm" : "sm"}
        aria-disabled="true"
        aria-label={compact ? `${label} unavailable: ${reason}` : undefined}
        className="cursor-not-allowed text-text-muted hover:bg-surface hover:text-text-muted"
      >
        {icon}
        {compact ? null : label}
        {compact ? null : <span className="sr-only">: unavailable. {reason}</span>}
      </Button>
    </Explain>
  )
}

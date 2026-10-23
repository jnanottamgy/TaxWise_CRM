"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PhoneIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton, type ComposeFields } from "@/components/app/messaging/gmail-button"
import { applySignature, firstNameOf, gmailComposeUrl, normalizeWhatsAppNumber, waMeUrl } from "@/lib/domain/messaging"
import { logLeadHandoff } from "@/server/actions/leads"

const whatsAppUrl = (digits: string, text: string) => waMeUrl(digits, text)
const gmailUrl = (f: ComposeFields) => gmailComposeUrl(f)

/**
 * WhatsApp, email (Gmail) and call buttons for a lead (§7.5.1 "WhatsApp/email/Gmail buttons with
 * drafts"; §7.13.2–§7.13.3): the drafts come from the firm's "Lead follow-up" templates, the
 * WhatsApp draft ends with the sender's signature on shared numbers, and each hand-off is logged on
 * the lead's timeline as handed off (never "delivered").
 */
export function LeadContactButtons({
  lead,
  drafts,
  countryCode,
  signature,
}: {
  lead: { id: string; name: string; company: string | null; email: string | null; phone: string | null; whatsapp: string | null }
  drafts: { whatsapp: string; emailSubject: string; emailBody: string }
  countryCode: string
  signature: { add: boolean; format: string; senderName: string }
}) {
  const router = useRouter()
  const number = normalizeWhatsAppNumber(lead.whatsapp, { countryCode }) ?? normalizeWhatsAppNumber(lead.phone, { countryCode })
  const who = lead.company ? `${lead.name} · ${lead.company}` : lead.name
  const wa = signature.add ? applySignature(drafts.whatsapp, signature.format, firstNameOf(signature.senderName)) : drafts.whatsapp
  const log = async (input: Parameters<typeof logLeadHandoff>[0]) => {
    const r = await logLeadHandoff(input)
    if (!r.ok) throw new Error(r.error)
    router.refresh()
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <WhatsAppButton
        recipientName={who}
        number={number}
        draft={wa}
        buildUrl={whatsAppUrl}
        disabledReason="No WhatsApp number for this lead. Add a mobile number to the lead."
        onHandedOff={({ number: n, text }) => log({ leadId: lead.id, channel: "whatsapp_handoff", recipient: n, body: text })}
      />
      <GmailButton
        to={lead.email}
        subject={drafts.emailSubject}
        body={drafts.emailBody}
        buildUrl={gmailUrl}
        label="Email"
        disabledReason="No email address for this lead. Add one to the lead."
        onHandedOff={(f) => log({ leadId: lead.id, channel: "gmail_handoff", recipient: f.to, subject: f.subject, body: f.body })}
      />
      {lead.phone ? (
        <Button asChild variant="outline" size="sm">
          <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}>
            <PhoneIcon aria-hidden="true" />
            Call
          </a>
        </Button>
      ) : null}
    </div>
  )
}

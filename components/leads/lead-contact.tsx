"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PhoneIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { applySignature, firstNameOf, normalizeWhatsAppNumber } from "@/lib/domain/messaging"
import { logLeadHandoff } from "@/server/actions/leads"

/**
 * WhatsApp and call buttons for a lead (§7.5.1 "buttons with drafts"; §7.13.2): the draft comes from
 * the firm's "Lead follow-up" template, ends with the sender's signature on shared numbers, and each
 * hand-off is logged on the lead's timeline as handed off (never "delivered"). The app sends no
 * email.
 */
export function LeadContactButtons({
  lead,
  draft,
  countryCode,
  signature,
}: {
  lead: { id: string; name: string; company: string | null; phone: string | null; whatsapp: string | null }
  draft: string
  countryCode: string
  signature: { add: boolean; format: string; senderName: string }
}) {
  const router = useRouter()
  const number = normalizeWhatsAppNumber(lead.whatsapp, { countryCode }) ?? normalizeWhatsAppNumber(lead.phone, { countryCode })
  const who = lead.company ? `${lead.name} · ${lead.company}` : lead.name
  const wa = signature.add ? applySignature(draft, signature.format, firstNameOf(signature.senderName)) : draft
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
        disabledReason="No WhatsApp number for this lead. Add a mobile number to the lead."
        onHandedOff={({ number: n, text }) => log({ leadId: lead.id, channel: "whatsapp_handoff", recipient: n, body: text })}
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

"use client"

import { useRouter } from "next/navigation"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import type { DocumentShare } from "@/lib/data/document-share"
import { logHandoff } from "@/server/actions/messages"

export type { DocumentShare }

/**
 * Send on WhatsApp for a document (§7.13.2), from a DocumentShare built on the server page
 * (lib/data/document-share.ts): the preview with the message and the template picker, then WhatsApp
 * opens on the client's chat with the text typed in and the PDF downloads in the same click, to
 * attach. The hand-off is logged on the client's Communication tab, against the record.
 *
 *   <SendDocumentButton share={share} />                       a "Send on WhatsApp" button
 *   <SendDocumentButton share={share} iconOnly label="Send receipt TW-R/26-27/0007 on WhatsApp to" />
 */
export function SendDocumentButton({
  share,
  label = "Send on WhatsApp",
  iconOnly = false,
  variant = "outline",
  size = "sm",
  className,
}: {
  share: DocumentShare
  label?: string
  iconOnly?: boolean
  variant?: "whatsapp" | "outline" | "ghost"
  size?: "sm" | "default"
  className?: string
}) {
  const router = useRouter()
  return (
    <WhatsAppButton
      recipientName={share.recipientName}
      number={share.number}
      draft={share.draft}
      templates={share.templates}
      attachment={share.attachment}
      label={label}
      iconOnly={iconOnly}
      variant={variant}
      size={size}
      className={className}
      onHandedOff={async ({ number, text, templateId }) => {
        const r = await logHandoff({ clientId: share.clientId, contactId: share.contactId, channel: "whatsapp_handoff", recipient: number, body: text, templateId, related: share.related })
        if (!r.ok) throw new Error(r.error)
        router.refresh()
      }}
    />
  )
}

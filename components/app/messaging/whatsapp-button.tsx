"use client"

import * as React from "react"
import { ExternalLinkIcon, FileDownIcon, MessageCircleIcon, PaperclipIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Explain } from "@/components/app/explain"
import { HandoffSheet, displayPhone } from "@/components/app/messaging/handoff-sheet"
import { useIsPhone } from "@/components/whatsapp/use-phone"
import { waMeUrl, whatsAppWebSendUrl } from "@/lib/domain/messaging"
import { WHATSAPP_WINDOW_NAME, whatsappWindowFeatures } from "@/lib/domain/whatsapp"

export interface MessageTemplateOption {
  id: string
  name: string
  /** The filled-in draft for this recipient. */
  body: string
}

/** A document to send with the message: it downloads in the same click, ready to attach in the chat. */
export interface WhatsAppAttachment {
  /** A same-origin URL that returns the file (a PDF route, a signed download). */
  href: string
  /** The name it is saved under, e.g. "Invoice TW-26-27-0070.pdf". */
  filename: string
}

const NO_NUMBER = "No WhatsApp number for this client. Add one in Contacts."

/**
 * Send on WhatsApp (§7.13.2): every message to a client goes out this way. The caller resolves the
 * number (normalizeWhatsAppNumber in lib/domain/messaging.ts) and the ready-made text (a template,
 * filled in). With no usable number the button stays visible but disabled, and says why.
 *
 * Clicking opens the preview (recipient, template picker, editable text, the document if any).
 * "Open WhatsApp" then:
 *   - on a computer, opens the chat in WhatsApp Web with the text typed in, in one reused window on
 *     the right half of the screen (so the CRM stays beside it and tabs don't multiply);
 *   - on a phone, opens the WhatsApp app (wa.me);
 *   - downloads the document in the same click, to drop into the chat (paperclip, or drag it in);
 * and calls `onHandedOff` so the feature logs `whatsapp_handoff / handed_off`. You press Send in
 * WhatsApp; the app never claims the message was delivered.
 *
 *   <WhatsAppButton
 *     recipientName="Rakesh Sharma · Sharma Traders"
 *     number={normalizeWhatsAppNumber(contact.whatsapp ?? contact.phone)}
 *     draft={renderTemplate(tpl, vars)}
 *     templates={templates}
 *     attachment={{ href: `/api/pdf/invoice/${id}`, filename: `Invoice ${number}.pdf` }}
 *     onHandedOff={({ text }) => logHandoff({ clientId, contactId, text })}
 *   />
 */
export function WhatsAppButton({
  recipientName,
  number,
  draft,
  templates,
  templatePicker,
  attachment,
  onHandedOff,
  label = "WhatsApp",
  iconOnly = false,
  size = "sm",
  variant = "whatsapp",
  disabledReason = NO_NUMBER,
  className,
}: {
  recipientName: string
  /** Normalised digits (E.164 without +), or null when there is no usable number. */
  number: string | null | undefined
  draft: string
  /** Templates to switch the draft to (their bodies already filled in). */
  templates?: MessageTemplateOption[]
  /** Or your own picker, rendered above the draft. */
  templatePicker?: React.ReactNode
  /** The document this message sends (an invoice, a quotation, a computation). */
  attachment?: WhatsAppAttachment
  onHandedOff?: (info: { number: string; text: string; templateId: string | null }) => void | Promise<void>
  label?: string
  /** Compact icon button for table rows and contact lists (a ghost button with the green icon). */
  iconOnly?: boolean
  size?: "sm" | "default"
  /** `whatsapp` (green fill), `outline`, or `ghost` for an action repeated down a list. */
  variant?: "whatsapp" | "outline" | "ghost"
  disabledReason?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState(draft)
  const [templateId, setTemplateId] = React.useState<string | null>(null)
  const phone = useIsPhone()
  const textId = React.useId()
  const tplId = React.useId()

  // Icon-only buttons repeat down lists, so they are ghost buttons: no box around each icon (DESIGN.md §4).
  const buttonVariant = iconOnly ? "ghost" : variant
  const iconClass = iconOnly || variant !== "whatsapp" ? "text-success-text" : undefined

  if (!number) {
    return (
      <Explain content={<p>{disabledReason}</p>}>
        <Button
            type="button"
            variant={iconOnly || variant === "ghost" ? "ghost" : "outline"}
            size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
            aria-disabled="true"
            aria-label={iconOnly ? `${label} unavailable: ${disabledReason}` : undefined}
            className={cn("cursor-not-allowed text-text-muted hover:text-text-muted", iconOnly || variant === "ghost" ? "hover:bg-transparent" : "hover:bg-surface", className)}
          >
            <MessageCircleIcon aria-hidden="true" />
            {iconOnly ? null : label}
            {iconOnly ? null : <span className="sr-only">: unavailable. {disabledReason}</span>}
        </Button>
      </Explain>
    )
  }

  const send = async () => {
    // Everything that opens or downloads happens inside the click, so pop-up blockers allow it.
    openWhatsAppChat(number, text, phone)
    if (attachment) downloadFile(attachment)
    setOpen(false)
    try {
      await onHandedOff?.({ number, text, templateId })
      toast.success(attachment ? "WhatsApp is open and the document downloaded. Attach it, then press Send." : "WhatsApp is open with the message. Press Send there.")
    } catch {
      toast.warning("WhatsApp opened, but the hand-off wasn't logged. Note it on the Communication tab.")
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
        aria-label={iconOnly ? `${label} ${recipientName}` : undefined}
        onClick={(e) => {
          e.stopPropagation()
          setText(draft)
          setTemplateId(null)
          setOpen(true)
        }}
        className={className}
      >
        <MessageCircleIcon aria-hidden="true" className={iconClass} />
        {iconOnly ? null : label}
      </Button>
      <HandoffSheet
        open={open}
        onOpenChange={setOpen}
        title="Send on WhatsApp"
        description={
          attachment
            ? "Opens the chat with this message typed in and downloads the document to attach. You press Send there."
            : "Opens the chat with this message typed in. You press Send there."
        }
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="whatsapp" disabled={!text.trim()} onClick={send}>
              <ExternalLinkIcon aria-hidden="true" />
              {attachment ? "Download and open WhatsApp" : "Open WhatsApp"}
            </Button>
          </>
        }
      >
        <dl className="mb-4 grid grid-cols-[5.5rem_1fr] gap-y-1 text-base">
          <dt className="text-sm text-text-muted">To</dt>
          <dd className="min-w-0 text-text">{recipientName}</dd>
          <dt className="text-sm text-text-muted">Number</dt>
          <dd className="num text-text tabular-nums">{displayPhone(number)}</dd>
        </dl>
        {templatePicker ? <div className="mb-4">{templatePicker}</div> : null}
        {!templatePicker && templates?.length ? (
          <div className="mb-4 flex flex-col gap-1.5">
            <label htmlFor={tplId} className="text-sm font-medium text-text">
              Template
            </label>
            <select
              id={tplId}
              value={templateId ?? ""}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value)
                setTemplateId(t?.id ?? null)
                setText(t ? t.body : draft)
              }}
              className="h-9 w-full cursor-pointer rounded-md border border-text-muted/30 bg-surface px-3 text-base text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 max-md:text-md pointer-coarse:h-11"
            >
              <option value="">Suggested message</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={textId} className="text-sm font-medium text-text">
            Message
          </label>
          <Textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} rows={8} className="min-h-40" />
          <p className="num text-sm text-text-muted tabular-nums">{text.length.toLocaleString("en-IN")} characters</p>
        </div>
        {attachment ? (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5">
            <PaperclipIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{attachment.filename}</p>
              <p className="text-sm text-text-muted">Downloads as WhatsApp opens. Attach it in the chat with the paperclip, or drag it in.</p>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Download ${attachment.filename}`} onClick={() => downloadFile(attachment)}>
              <FileDownIcon aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </HandoffSheet>
    </>
  )
}

/**
 * Opens the chat with the text typed in: WhatsApp Web in the one reused window on a computer, the
 * WhatsApp app on a phone. The window is opened blank first so the CRM can cut its `opener` link
 * before WhatsApp loads; a window already showing WhatsApp is simply pointed at the new chat.
 */
export function openWhatsAppChat(digits: string, text: string, onPhone: boolean): void {
  if (onPhone) {
    window.open(waMeUrl(digits, text), "_blank", "noopener,noreferrer")
    return
  }
  const url = whatsAppWebSendUrl(digits, text)
  const s = window.screen
  const win = window.open("", WHATSAPP_WINDOW_NAME, whatsappWindowFeatures({ availWidth: s.availWidth, availHeight: s.availHeight, availLeft: (s as Screen & { availLeft?: number }).availLeft, availTop: (s as Screen & { availTop?: number }).availTop }))
  if (!win) {
    // Pop-ups blocked for this site: a normal tab still works.
    window.open(url, "_blank", "noopener,noreferrer")
    return
  }
  try {
    win.opener = null
  } catch {
    // The window already shows WhatsApp (another origin): it has no hold on this page to cut.
  }
  win.location.href = url
  win.focus()
}

/** Saves a same-origin file through a temporary link (works inside the same click as the window). */
function downloadFile(file: WhatsAppAttachment): void {
  const a = document.createElement("a")
  a.href = file.href
  a.download = file.filename
  a.rel = "noopener"
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  a.remove()
}

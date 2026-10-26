"use client"

import * as React from "react"
import { ExternalLinkIcon, MessageCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Explain } from "@/components/app/explain"
import { HandoffSheet, displayPhone } from "@/components/app/messaging/handoff-sheet"

export interface MessageTemplateOption {
  id: string
  name: string
  /** The filled-in draft for this recipient. */
  body: string
}

const NO_NUMBER = "No WhatsApp number for this client. Add one in Contacts."

/**
 * WhatsApp click-to-chat hand-off (§7.13.2). Presentational: the caller resolves the number
 * (normalizeWhatsAppNumber in lib/domain/messaging.ts) and passes the URL builder. With no usable
 * number the button stays visible but disabled, and says why on hover, focus or tap. Clicking opens
 * the preview sheet (recipient, editable draft, template picker); "Open WhatsApp" opens wa.me in a
 * new tab and calls `onHandedOff` so the feature can log `whatsapp_handoff / handed_off`. The app
 * never claims the message was delivered.
 *
 *   <WhatsAppButton
 *     recipientName="Rakesh Sharma · Sharma Traders"
 *     number={normalizeWhatsAppNumber(contact.whatsapp ?? contact.phone)}
 *     draft={renderTemplate(tpl, vars)}
 *     buildUrl={whatsAppUrl}
 *     templates={templates}
 *     onHandedOff={({ text }) => logHandoff({ clientId, contactId, text })}
 *   />
 */
export function WhatsAppButton({
  recipientName,
  number,
  draft,
  buildUrl,
  templates,
  templatePicker,
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
  buildUrl: (digits: string, text: string) => string
  /** Templates to switch the draft to (their bodies already filled in). */
  templates?: MessageTemplateOption[]
  /** Or your own picker, rendered above the draft. */
  templatePicker?: React.ReactNode
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
        description="Opens WhatsApp with this message. You press Send there."
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="whatsapp"
              disabled={!text.trim()}
              onClick={async () => {
                const url = buildUrl(number, text)
                window.open(url, "_blank", "noopener,noreferrer")
                setOpen(false)
                try {
                  await onHandedOff?.({ number, text, templateId })
                  toast.success("Handed off to WhatsApp. Press Send there.")
                } catch {
                  toast.warning("WhatsApp opened, but the hand-off wasn't logged. Note it on the Communication tab.")
                }
              }}
            >
              <ExternalLinkIcon aria-hidden="true" />
              Open WhatsApp
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
      </HandoffSheet>
    </>
  )
}

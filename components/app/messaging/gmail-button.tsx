"use client"

import * as React from "react"
import { DownloadIcon, ExternalLinkIcon, MailIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Explain } from "@/components/app/explain"
import { HandoffSheet } from "@/components/app/messaging/handoff-sheet"

export interface ComposeFields {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
}

const NO_EMAIL = "No email address for this client. Add one in Contacts."

/**
 * Gmail compose hand-off (§7.13.3). Presentational: pass `buildUrl` from lib/domain/messaging.ts
 * (it caps the URL at about 1,900 characters by trimming the body, and builds `mailto:` for people
 * who chose "Outlook / default mail app"). Opens a preview sheet with the subject and body editable;
 * "Open Gmail" opens compose in a new tab and calls `onHandedOff`. No compose URL can attach a
 * file: put a link in the body, and pass `pdfHref` to offer Download PDF beside it.
 *
 *   <GmailButton to={contact.email} subject={`Invoice ${inv.number}`} body={body}
 *     buildUrl={gmailComposeUrl} pdfHref={`/api/pdf/invoice/${inv.id}`}
 *     onHandedOff={(f) => logHandoff({ channel: "gmail_handoff", … })} />
 */
export function GmailButton({
  to,
  cc,
  subject,
  body,
  buildUrl,
  onHandedOff,
  pdfHref,
  label = "Gmail",
  appName = "Gmail",
  iconOnly = false,
  size = "sm",
  variant = "outline",
  disabledReason = NO_EMAIL,
  className,
}: {
  to: string | null | undefined
  cc?: string
  subject: string
  body: string
  buildUrl: (fields: ComposeFields) => string
  onHandedOff?: (fields: ComposeFields) => void | Promise<void>
  /** Offer the PDF to attach by hand. */
  pdfHref?: string
  label?: string
  /** "Gmail", or "your mail app" for the mailto fallback. */
  appName?: string
  iconOnly?: boolean
  size?: "sm" | "default"
  /** `ghost` for an action repeated down a list (icon-only buttons are always ghost). */
  variant?: "outline" | "ghost"
  disabledReason?: string
  className?: string
}) {
  const quiet = iconOnly || variant === "ghost"
  const [open, setOpen] = React.useState(false)
  const [fields, setFields] = React.useState<ComposeFields>({ to: to ?? "", cc, subject, body })
  const subjectId = React.useId()
  const bodyId = React.useId()

  if (!to) {
    return (
      <Explain content={<p>{disabledReason}</p>}>
        <Button
            type="button"
            variant={quiet ? "ghost" : "outline"}
            size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
            aria-disabled="true"
            aria-label={iconOnly ? `${label} unavailable: ${disabledReason}` : undefined}
            className={cn("cursor-not-allowed text-text-muted hover:text-text-muted", quiet ? "hover:bg-transparent" : "hover:bg-surface", className)}
          >
            <MailIcon aria-hidden="true" />
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
        variant={quiet ? "ghost" : "outline"}
        size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
        aria-label={iconOnly ? `${label} to ${to}` : undefined}
        onClick={(e) => {
          e.stopPropagation()
          setFields({ to, cc, subject, body })
          setOpen(true)
        }}
        className={className}
      >
        <MailIcon aria-hidden="true" />
        {iconOnly ? null : label}
      </Button>
      <HandoffSheet
        open={open}
        onOpenChange={setOpen}
        title={`Send from ${appName}`}
        description={`Opens ${appName} with this email filled in. You press Send there.`}
        footer={
          <>
            {pdfHref ? (
              <Button asChild variant="ghost" className="mr-auto">
                <a href={pdfHref} download>
                  <DownloadIcon aria-hidden="true" />
                  Download PDF
                </a>
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!fields.subject.trim() && !fields.body.trim()}
              onClick={async () => {
                window.open(buildUrl(fields), "_blank", "noopener,noreferrer")
                setOpen(false)
                try {
                  await onHandedOff?.(fields)
                  toast.success(`Handed off to ${appName}. Press Send there.`)
                } catch {
                  toast.warning(`${appName} opened, but the hand-off wasn't logged. Note it on the Communication tab.`)
                }
              }}
            >
              <ExternalLinkIcon aria-hidden="true" />
              Open {appName}
            </Button>
          </>
        }
      >
        <dl className="mb-4 grid grid-cols-[4rem_1fr] gap-y-1 text-base">
          <dt className="text-sm text-text-muted">To</dt>
          <dd className="min-w-0 break-all text-text">{fields.to}</dd>
          {fields.cc ? (
            <>
              <dt className="text-sm text-text-muted">Cc</dt>
              <dd className="min-w-0 break-all text-text">{fields.cc}</dd>
            </>
          ) : null}
        </dl>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={subjectId} className="text-sm font-medium text-text">
              Subject
            </label>
            <Input id={subjectId} value={fields.subject} onChange={(e) => setFields((f) => ({ ...f, subject: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={bodyId} className="text-sm font-medium text-text">
              Message
            </label>
            <Textarea id={bodyId} value={fields.body} onChange={(e) => setFields((f) => ({ ...f, body: e.target.value }))} rows={10} className="min-h-48" />
            <p className="text-sm text-text-muted">Files can&apos;t be attached from here. The link in the message opens the document.</p>
          </div>
        </div>
      </HandoffSheet>
    </>
  )
}

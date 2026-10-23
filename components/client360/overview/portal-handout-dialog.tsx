"use client"

import * as React from "react"
import { CheckCircle2Icon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { MonoId } from "@/components/app/mono-id"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import { emailOutcomeNotice } from "@/lib/handoff"
import type { PortalHandout } from "@/server/actions/portal-access"

/**
 * "Portal login created" (§7.22: "temporary password + email + WhatsApp/Gmail hand-off (like
 * staff)"). It says plainly whether the email went and why not, shows the temporary password once
 * with a copy button, and offers WhatsApp and Gmail with the login drafted. Those hand-offs are not
 * logged in the message history: the draft holds the password (§12).
 */
export function PortalHandoutDialog({ handout, onClose }: { handout: PortalHandout | null; onClose: () => void }) {
  const open = handout !== null
  const h = handout
  const notice = h ? emailOutcomeNotice(h.emailOutcome, h.handoff.contactName) : null
  const Icon = notice?.tone === "success" ? CheckCircle2Icon : notice?.tone === "warning" ? TriangleAlertIcon : CircleAlertIcon
  const title = h?.kind === "resend" ? "New temporary password" : h?.kind === "restore" ? "Portal access restored" : "Portal login created"

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={h ? `For ${h.clientName}. The password is shown only now.` : undefined}
      size="sm"
      footer={
        <div className="ml-auto">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      {h && notice ? (
        <div className="flex flex-col gap-4">
          <p
            role="status"
            className={
              notice.tone === "success"
                ? "flex items-start gap-2 text-sm text-success-text"
                : notice.tone === "warning"
                  ? "flex items-start gap-2 text-sm text-warning-text"
                  : "flex items-start gap-2 text-sm text-danger-text"
            }
          >
            <Icon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <span>
              {notice.tone === "success" ? `The invite was emailed to ${h.email}.` : notice.message}
              {notice.detail ? <span className="block text-text-muted">{notice.detail}</span> : null}
            </span>
          </p>
          <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2.5 rounded-md border border-border bg-surface-2 px-3 py-3">
            <dt className="text-sm text-text-muted">Sign-in page</dt>
            <dd className="min-w-0">
              <MonoId value={h.loginUrl} copy label="sign-in link" />
            </dd>
            <dt className="text-sm text-text-muted">Email</dt>
            <dd className="min-w-0">
              <MonoId value={h.email} copy label="email" />
            </dd>
            <dt className="text-sm text-text-muted">Temporary password</dt>
            <dd className="min-w-0">
              <MonoId value={h.temporaryPassword} copy label="temporary password" />
            </dd>
          </dl>
          <p className="text-sm text-text-muted">They choose their own password the first time they sign in. Share these details another way if the email didn&apos;t go:</p>
          <div className="flex flex-wrap gap-2">
            <WhatsAppButton
              recipientName={`${h.handoff.contactName} · ${h.clientName}`}
              number={h.handoff.whatsappNumber}
              draft={h.handoff.whatsappText}
              buildUrl={waMeUrl}
              label="Share on WhatsApp"
              variant="outline"
            />
            <GmailButton
              to={h.handoff.gmail.to}
              subject={h.handoff.gmail.subject}
              body={h.handoff.gmail.body}
              buildUrl={(f) => gmailComposeUrl({ to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, body: f.body })}
              label="Send via Gmail"
            />
          </div>
        </div>
      ) : (
        <span />
      )}
    </FormDialog>
  )
}

"use client"

import * as React from "react"
import { KeyRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { MonoId } from "@/components/app/mono-id"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import type { PortalHandout } from "@/server/actions/portal-access"

/**
 * "Portal login created" (§7.22: "temporary password + WhatsApp hand-off (like staff)"): the sign-in
 * page, the email the client signs in with and the temporary password, shown once with copy
 * buttons, and Share on WhatsApp with the login drafted. Nothing is emailed. The hand-off is not
 * logged in the message history: the draft holds the password (§12). The same view is how a client
 * who forgot their password gets back in (Resend gives a new temporary password).
 */
export function PortalHandoutDialog({ handout, onClose }: { handout: PortalHandout | null; onClose: () => void }) {
  const open = handout !== null
  const h = handout
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
      {h ? (
        <div className="flex flex-col gap-4">
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
          <p className="flex items-start gap-2 text-sm text-text-muted">
            <KeyRoundIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <span>They choose their own password the first time they sign in. Share the login on WhatsApp: the message has all three.</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <WhatsAppButton
              recipientName={`${h.handoff.contactName} · ${h.clientName}`}
              number={h.handoff.whatsappNumber}
              draft={h.handoff.whatsappText}
              label="Share on WhatsApp"
            />
          </div>
        </div>
      ) : (
        <span />
      )}
    </FormDialog>
  )
}

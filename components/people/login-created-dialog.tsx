"use client"

import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, KeyRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { CopyButton } from "@/components/app/copy-button"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import { loginInviteEmail, loginShareMessage } from "@/lib/schemas/people"
import type { LoginHandout } from "@/server/actions/people"
import { cn } from "@/lib/utils"

/**
 * "Login created" (§4.5 point 2) — and the same view after a password reset (point 3): the login
 * email, the temporary password with a copy button, Share on WhatsApp (pre-drafted message with the
 * login link, email and password) and Send via Gmail, and whether the invite email went (with the
 * provider's reason if it didn't). The password is shown once: it is only in this dialog's memory.
 */
export function LoginCreatedDialog({
  logins,
  failed = [],
  open,
  onOpenChange,
}: {
  logins: LoginHandout[]
  failed?: Array<{ name: string; error: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const reset = logins.length === 1 && logins[0].kind === "reset"
  const title = reset ? "New temporary password" : logins.length === 1 ? "Login created" : `${logins.length} logins created`
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size={logins.length > 1 ? "lg" : "md"}
      title={title}
      description="Each password is shown only now. They set their own when they first sign in."
      footer={
        <div className="ml-auto">
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {failed.length > 0 ? (
          <div role="alert" className="flex gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-base text-text">
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
            <div>
              <p className="font-medium">{failed.length === 1 ? "One login wasn't created." : `${failed.length} logins weren't created.`}</p>
              <ul className="mt-1 list-disc pl-4 text-sm text-text-muted">
                {failed.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    {f.name ? `${f.name}: ` : ""}
                    {f.error}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {logins.map((l) => (
          <LoginCard key={l.employeeId} login={l} compact={logins.length > 1} />
        ))}
      </div>
    </FormDialog>
  )
}

function LoginCard({ login, compact }: { login: LoginHandout; compact: boolean }) {
  const share = { fullName: login.fullName, email: login.email, temporaryPassword: login.temporaryPassword, loginUrl: login.loginUrl, firmName: login.firmName }
  const mail = loginInviteEmail(share, login.kind)
  const sent = login.invite.status === "sent"
  return (
    <section aria-label={`Login for ${login.fullName}`} className={cn("rounded-lg border border-border", compact ? "p-3" : "p-4")}>
      {compact ? <h3 className="mb-2 text-base font-semibold text-text">{login.fullName}</h3> : null}
      <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-base">
        <dt className="text-sm text-text-muted">Sign-in email</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="truncate">{login.email}</span>
          <CopyButton value={login.email} label="email" />
        </dd>
        <dt className="text-sm text-text-muted">Temporary password</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <KeyRoundIcon aria-hidden="true" className="size-3.5 flex-none text-text-muted" />
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[15px] tracking-wide text-text select-all">{login.temporaryPassword}</span>
          <CopyButton value={login.temporaryPassword} label="temporary password" showText />
        </dd>
        <dt className="text-sm text-text-muted">Sign-in page</dt>
        <dd className="min-w-0 truncate text-sm text-text-muted">{login.loginUrl}</dd>
      </dl>

      <p className={cn("mt-3 flex items-start gap-2 text-sm", sent ? "text-success-text" : "text-warning-text")} role="status">
        {sent ? <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" /> : <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />}
        <span>
          {sent
            ? `The ${login.kind === "reset" ? "new password" : "invite"} was emailed to ${login.email}.`
            : `The email didn't go${login.invite.error ? `: ${login.invite.error}` : "."} Share the login on WhatsApp or from Gmail instead.`}
        </span>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <WhatsAppButton
          recipientName={login.fullName}
          number={login.whatsapp}
          draft={loginShareMessage(share)}
          buildUrl={(digits, text) => waMeUrl(digits, text)}
          label="Share on WhatsApp"
          disabledReason={`No WhatsApp or mobile number for ${login.fullName}. Add one in their details, or use Gmail.`}
        />
        <GmailButton to={login.email} subject={mail.subject} body={mail.text} buildUrl={(f) => gmailComposeUrl(f)} label="Send via Gmail" />
      </div>
    </section>
  )
}

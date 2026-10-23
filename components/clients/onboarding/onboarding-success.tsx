"use client"

import Link from "next/link"
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  KeyRoundIcon,
  MailIcon,
  MessageCircleIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import { logHandoff } from "@/server/actions/messages"
import type { OnboardingResult } from "@/server/actions/clients"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CopyButton } from "@/components/app/copy-button"
import { MonoId } from "@/components/app/mono-id"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import type { UploadJob } from "@/components/clients/onboarding/use-checklist-uploads"

const whatsAppUrl = (digits: string, text: string) => waMeUrl(digits, text)
const gmailUrl = (f: { to: string; cc?: string; subject: string; body: string }) => gmailComposeUrl(f)

/** The temporary password is shown once and never stored, so the logged copy of a hand-off leaves it out (§12). */
function redactPassword(text: string, password: string): string {
  return password ? text.split(password).join("(temporary password, not kept)") : text
}

/**
 * The screen after Complete (§7.3.2): what was created, the after-effects that didn't go through
 * as warnings (never errors), the portal login handout shown once with WhatsApp / Gmail hand-offs,
 * the welcome email's outcome, the checklist files being filed, and "Set up the WhatsApp group"
 * (§7.25.2). Then Open client or Add another.
 */
export function OnboardingSuccess({
  result,
  warnings,
  ownerName,
  partnerName,
  uploads,
  onRetryUpload,
  onAddAnother,
}: {
  result: OnboardingResult
  warnings: string[]
  ownerName: string | null
  partnerName: string | null
  uploads: UploadJob[]
  onRetryUpload: (index: number) => void
  onAddAnother: () => void
}) {
  const href = `/clients/${result.clientId}`
  const portal = result.portal
  const welcome = result.welcome
  const logged = (p: Promise<unknown>) => {
    void p.catch(() => undefined)
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-2">
      <div className="flex items-start gap-3">
        <CheckCircle2Icon aria-hidden="true" className="mt-1 size-6 flex-none text-success-text" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text">
            {result.displayName} is onboarded
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-text-muted">
            <MonoId value={result.clientCode} copy label="Client code" />
            <span aria-hidden="true">·</span>
            <span>
              {result.eventCount} {result.eventCount === 1 ? "deadline" : "deadlines"} created, {result.taskCount} {result.taskCount === 1 ? "task" : "tasks"} to collect
              documents{ownerName ? ` for ${ownerName} to accept` : ""}.
            </span>
          </p>
        </div>
      </div>

      {warnings.length ? (
        <div role="status" className="flex gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
          <ul className="flex flex-col gap-1 text-base text-text">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section aria-labelledby="success-whatsapp" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <MessageCircleIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
        <div className="min-w-0 flex-1">
          <h2 id="success-whatsapp" className="text-md font-semibold text-text">
            Set up the WhatsApp group
          </h2>
          <p className="text-sm text-text-muted">
            {result.whatsappTaskId
              ? `On ${partnerName ?? ownerName ?? "the engagement partner"}'s to-do list, due in 2 days. The client's WhatsApp group tab has the checklist.`
              : "The client's WhatsApp group tab has the checklist: the group name, the contacts, the firm's numbers and the welcome message."}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`${href}?tab=whatsapp`}>Open the checklist</Link>
        </Button>
      </section>

      {portal ? (
        <section aria-labelledby="success-portal" className="rounded-lg border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <KeyRoundIcon aria-hidden="true" className="size-4 text-text-muted" />
            <h2 id="success-portal" className="text-md font-semibold text-text">
              Client portal login
            </h2>
          </div>
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-sm text-warning-text">The temporary password is shown only now. The client chooses their own the first time they sign in.</p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
              <dt className="text-sm text-text-muted">Sign in at</dt>
              <dd className="flex min-w-0 items-center gap-1 text-base text-text">
                <span className="truncate">{portal.loginUrl}</span>
                <CopyButton value={portal.loginUrl} label="sign-in link" />
              </dd>
              <dt className="text-sm text-text-muted">Email</dt>
              <dd className="flex min-w-0 items-center gap-1 text-base text-text">
                <span className="truncate">{portal.email}</span>
                <CopyButton value={portal.email} label="email" />
              </dd>
              <dt className="text-sm text-text-muted">Temporary password</dt>
              <dd className="flex items-center gap-1 font-mono text-[13px] text-text">
                {portal.temporaryPassword}
                <CopyButton value={portal.temporaryPassword} label="temporary password" />
              </dd>
            </dl>
            <p className={cn("flex items-center gap-1.5 text-sm", portal.emailOutcome.status === "sent" ? "text-success-text" : "text-warning-text")}>
              <MailIcon aria-hidden="true" className="size-3.5" />
              {portal.emailOutcome.status === "sent"
                ? `The invite was emailed to ${portal.email}.`
                : portal.emailOutcome.status === "not_configured"
                  ? "Email isn't set up for the firm, so the invite wasn't emailed. Hand the details over below."
                  : "The invite email didn't go through. Hand the details over below."}
            </p>
            <div className="flex flex-wrap gap-2">
              <WhatsAppButton
                recipientName={portal.handoff.contactName}
                number={portal.handoff.whatsappNumber}
                draft={portal.handoff.whatsappText}
                buildUrl={whatsAppUrl}
                label="Send on WhatsApp"
                onHandedOff={({ number, text }) =>
                  logged(
                    logHandoff({
                      clientId: result.clientId,
                      contactId: null,
                      channel: "whatsapp_handoff",
                      recipient: number,
                      body: redactPassword(text, portal.temporaryPassword),
                      related: { type: "client", id: result.clientId },
                    }),
                  )
                }
              />
              <GmailButton
                to={portal.handoff.gmail.to}
                subject={portal.handoff.gmail.subject}
                body={portal.handoff.gmail.body}
                buildUrl={gmailUrl}
                label="Send from Gmail"
                onHandedOff={(f) =>
                  logged(
                    logHandoff({
                      clientId: result.clientId,
                      contactId: null,
                      channel: "gmail_handoff",
                      recipient: f.to,
                      subject: f.subject,
                      body: redactPassword(f.body, portal.temporaryPassword),
                      related: { type: "client", id: result.clientId },
                    }),
                  )
                }
              />
            </div>
          </div>
        </section>
      ) : null}

      {welcome && welcome.status !== "skipped" ? (
        <p
          role="status"
          className={cn(
            "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
            welcome.status === "sent" ? "border-border bg-surface text-text-muted" : "border-warning/40 bg-warning-soft text-warning-text",
          )}
        >
          <MailIcon aria-hidden="true" className="size-4 flex-none" />
          {welcome.status === "sent"
            ? `Welcome email sent to ${welcome.to}.`
            : welcome.status === "not_configured"
              ? "Email isn't set up for the firm, so the welcome email wasn't sent. Send it from the client's Communication tab."
              : "The welcome email didn't go through. Send it from the client's Communication tab."}
        </p>
      ) : null}

      {uploads.length ? (
        <section aria-labelledby="success-files" className="rounded-lg border border-border bg-surface">
          <h2 id="success-files" className="border-b border-border px-4 py-3 text-md font-semibold text-text">
            Checklist files
          </h2>
          <ul className="divide-y divide-border">
            {uploads.map((u, i) => (
              <li key={`${u.itemId}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <PaperclipIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-text">{u.label}</span>
                  <span className="block truncate text-sm text-text-muted">{u.file.name}</span>
                </span>
                {u.status === "done" ? (
                  <span className="inline-flex items-center gap-1 text-sm text-success-text">
                    <CheckCircle2Icon aria-hidden="true" className="size-3.5" /> Filed
                  </span>
                ) : u.status === "failed" ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-sm text-danger-text">
                      <CircleAlertIcon aria-hidden="true" className="size-3.5" /> {u.error}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => onRetryUpload(i)}>
                      <RefreshCwIcon aria-hidden="true" />
                      Retry
                    </Button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
                    <Spinner className="size-3.5" /> {u.status === "uploading" ? "Uploading…" : "Waiting"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button asChild>
          <Link href={href}>Open client</Link>
        </Button>
        <Button type="button" variant="outline" onClick={onAddAnother}>
          <PlusIcon aria-hidden="true" />
          Add another client
        </Button>
        <Button asChild variant="ghost">
          <Link href="/clients">Back to clients</Link>
        </Button>
      </div>
    </div>
  )
}

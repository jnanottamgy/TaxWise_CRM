import type { Metadata } from "next"
import { Suspense } from "react"
import { requirePartner } from "@/lib/auth/guards"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { ErrorBlock } from "@/components/app/error-block"
import { SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"
import { PageGuide } from "@/components/shell/page-slots"
import { SettingsCard } from "@/components/settings/settings-card"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"
import { DomainWizard } from "@/components/settings/email/domain-wizard"
import { SenderForm } from "@/components/settings/email/sender-form"
import { TestEmailCard } from "@/components/settings/email/test-email-card"
import { DeliveryLog } from "@/components/settings/email/delivery-log"
import { WebhookCard } from "@/components/settings/email/webhook-card"
import { ResetTemplateCard } from "@/components/settings/email/reset-template-card"
import { getDeliveryLog, getEmailSettingsView, lookUpDomain, type EmailSettingsView } from "@/server/email/settings-data"
import { DOMAIN_STATUS_LABEL } from "@/server/email/policy"
import { emailFirm } from "@/server/email/templates/layout"
import { passwordResetTemplate } from "@/server/email/templates/password-reset"
import { getFirmProfile, defaultFirmProfile } from "@/server/firm"

export const metadata: Metadata = { title: "Email · Settings" }

/**
 * Settings → Email (§7.13.5, §7.21). Partner only (§4.1 "email domain"; requirePartner here, and
 * the actions and RLS refuse anyone else). The question it answers: can the app send email from
 * our domain, and did what it sent arrive?
 *
 * The domain card reads Resend live (in its own Suspense boundary, so a slow or failing Resend
 * never blocks the rest of the page); the delivery log reads the ledger under the Partner's RLS.
 */
export default async function EmailSettingsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requirePartner()
  const sp = await props.searchParams
  const problemsOnly = sp.log === "problems"
  const result = await loadSection("email", () => getEmailSettingsView(supabase))

  if (!result.ok || !result.data) {
    return (
      <div className="min-w-0">
        <SectionHeader title="Email" description="How the app sends email from the firm's domain, and what happened to each message." />
        {!result.ok ? <SectionLoadError what="the email settings" errorRef={result.ref} /> : <SettingsMissing />}
      </div>
    )
  }

  const v = result.data
  const firm = await loadSection("email:firm", () => getFirmProfile(supabase))
  const reset = passwordResetTemplate(emailFirm(firm.ok ? firm.data : defaultFirmProfile()))

  return (
    <div className="min-w-0">
      <PageGuide title="Email">
        <p>
          The app sends invoices, reminders, document requests and invites from the firm&apos;s own domain through Resend. Until Resend has
          verified the domain, nothing is sent automatically: every place that would email shows WhatsApp and Gmail instead.
        </p>
        <p>
          To set it up: add the domain, copy each DNS record into your DNS provider, then Check now. The status here is only ever what Resend
          reports. Then register the delivery events webhook so bounces and opens show on each record.
        </p>
      </PageGuide>
      <SectionHeader title="Email" description={describe(v)} />
      <div className="flex min-w-0 flex-col gap-4 md:gap-5">
        <SettingsCard
          id="domain"
          title="Sending domain"
          description="Resend verifies that the firm owns the domain through DNS records. Until it does, the app doesn't send email."
          columns={1}
        >
          <Suspense fallback={<DomainSkeleton />}>
            <DomainSection view={v} />
          </Suspense>
        </SettingsCard>

        <SettingsCard id="sender" title="Sender" description="Who automatic emails come from, and where replies go." columns={1}>
          <SenderForm
            key={`${v.fromName}|${v.fromAddress}|${v.replyTo}`}
            fromName={v.fromName}
            fromAddress={v.fromAddress}
            replyTo={v.replyTo}
            sendingDomain={v.sendingDomain}
            firmName={firm.ok ? firm.data.firmName : v.fromName}
          />
        </SettingsCard>

        <SettingsCard id="test" title="Test email" description="Check that email reaches an inbox before clients rely on it." columns={1}>
          <TestEmailCard to={user.email} ready={v.ready} notReadyReason={v.notReadyReason} />
        </SettingsCard>

        <SettingsCard id="delivery-log" title="Delivery log" description="What happened to each email the app sent, from Resend's delivery events." columns={1}>
          <Suspense key={problemsOnly ? "problems" : "all"} fallback={<SkeletonTable headers={["Email", "To", "Status", "Sent"]} rows={6} />}>
            <DeliveryLogSection supabase={supabase} problemsOnly={problemsOnly} />
          </Suspense>
        </SettingsCard>

        <SettingsCard id="events" title="Delivery events" description="Resend reports delivered, opened and bounced emails to this endpoint." columns={1}>
          <WebhookCard url={v.webhookUrl} secretPresent={v.webhookSecretPresent} lastEventAt={v.lastWebhookAt} />
        </SettingsCard>

        <SettingsCard id="password-reset" title="Password reset email" description="The branded template for Supabase's own reset email." columns={1}>
          <ResetTemplateCard subject={reset.subject} html={reset.html} />
        </SettingsCard>
      </div>
    </div>
  )
}

function describe(v: EmailSettingsView): string {
  if (v.ready) return `Sending as ${v.sender}; replies go to ${v.replyTo}. ${v.sendingDomain} is verified in Resend.`
  return `Automatic email is off: ${v.notReadyReason ?? "the domain isn't verified."} Staff see WhatsApp and Gmail instead. Domain: ${v.sendingDomain}, ${DOMAIN_STATUS_LABEL[v.domainStatus].toLowerCase()}.`
}

async function DomainSection({ view }: { view: EmailSettingsView }) {
  let details = null
  let lookupError: string | null = null
  if (view.resendDomainId && view.apiKeyPresent) {
    try {
      const found = await lookUpDomain(view.resendDomainId, view.replyTo || view.firmEmail)
      if (found.ok) details = found.details
      else lookupError = found.missing ? `Resend no longer has ${view.sendingDomain}. Press Check now to update this page, then add it again.` : found.error
    } catch (err) {
      const ref = logUnexpected(err, { source: "page:settings:email:domain" })
      return <ErrorBlock message="Couldn't read the sending domain from Resend." errorRef={ref} />
    }
  }
  return (
    <DomainWizard
      key={view.resendDomainId ?? "none"}
      sendingDomain={view.sendingDomain}
      resendDomainId={view.resendDomainId}
      status={view.domainStatus}
      verifiedAt={view.domainVerifiedAt}
      apiKeyPresent={view.apiKeyPresent}
      details={details}
      lookupError={lookupError}
    />
  )
}

async function DeliveryLogSection({ supabase, problemsOnly }: { supabase: ServerSupabase; problemsOnly: boolean }) {
  const result = await loadSection("email:delivery-log", () => getDeliveryLog(supabase, { problemsOnly }))
  if (!result.ok) return <ErrorBlock message="Couldn't load the delivery log." errorRef={result.ref} />
  return <DeliveryLog rows={result.data.rows} problemsOnly={problemsOnly} anyAtAll={result.data.anyAtAll} />
}

function DomainSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
        {["Add the domain to Resend", "Add the DNS records", "Verified by Resend"].map((s, i) => (
          <span key={s} className="flex items-center gap-2 text-sm text-text-muted">
            <span className="inline-flex size-6 items-center justify-center rounded-full border border-border text-xs">{i + 1}</span>
            {s}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-4 py-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <SkeletonTable headers={["Record", "Type", "Name", "Value", "Priority"]} rows={4} />
      <span role="status" className="sr-only">
        Loading the domain from Resend…
      </span>
    </div>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckIcon, ChevronDownIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { formatDateTime, formatTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { DOMAIN_STATUS_LABEL, DOMAIN_STATUS_MEANING, type DomainStatus } from "@/server/email/policy"
import type { DomainDetails } from "@/server/email/settings-data"
import { refreshDomainStatus, removeDomainSetup, startDomainSetup, type DomainActionResult } from "@/server/actions/email-settings"
import { DomainSetupSchema } from "@/components/settings/email/schemas"
import { DnsRecords } from "@/components/settings/email/dns-records"
import type { StatusTone } from "@/lib/status"

/**
 * Settings → Email → Sending domain: the verification wizard (§7.13.5).
 *   1. Add the domain to Resend (name, region).
 *   2. Add the DNS records it shows (SPF, return-path MX, DKIM, plus our DMARC recommendation), each
 *      with copy buttons.
 *   3. Verified, only when Resend says so: the status comes from Resend (polled every 30 seconds
 *      while it waits, or Check now), never set here.
 * Removing the domain (to start again with another name) is last, in its own row, with a
 * confirmation that says what stops.
 */

const STATUS_TONE: Record<DomainStatus, StatusTone> = { not_started: "muted", pending: "warning", verified: "success", failed: "danger" }

const POLL_MS = 30_000
const MAX_POLLS = 20

const REGION_OPTIONS = [
  { value: "ap-northeast-1", label: "Tokyo (closest to India)" },
  { value: "us-east-1", label: "North Virginia (Resend's default)" },
  { value: "eu-west-1", label: "Ireland" },
  { value: "sa-east-1", label: "São Paulo" },
]

export interface DomainWizardProps {
  sendingDomain: string
  resendDomainId: string | null
  status: DomainStatus
  verifiedAt: string | null
  apiKeyPresent: boolean
  details: DomainDetails | null
  /** Resend couldn't be read when the page loaded. */
  lookupError: string | null
}

function Steps({ status, hasDomain }: { status: DomainStatus; hasDomain: boolean }) {
  const steps = [
    { label: "Add the domain to Resend", done: hasDomain },
    { label: "Add the DNS records", done: status === "verified" },
    { label: "Verified by Resend", done: status === "verified" },
  ]
  const current = steps.findIndex((s) => !s.done)
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6" aria-label="Setup steps">
      {steps.map((s, i) => {
        const isCurrent = i === current
        return (
          <li key={s.label} className="flex items-center gap-2 text-sm" aria-current={isCurrent ? "step" : undefined}>
            <span
              className={cn(
                "inline-flex size-6 flex-none items-center justify-center rounded-full border text-xs font-medium",
                s.done ? "border-success/30 bg-success-soft text-success-text" : isCurrent ? "border-primary bg-primary-soft text-primary" : "border-border text-text-muted"
              )}
              aria-hidden="true"
            >
              {s.done ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            <span className={cn(s.done ? "text-text" : isCurrent ? "font-medium text-text" : "text-text-muted")}>
              {s.label}
              <span className="sr-only">{s.done ? " (done)" : isCurrent ? " (current step)" : " (to do)"}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function AddDomainForm({ defaultDomain, disabled }: { defaultDomain: string; disabled: boolean }) {
  const router = useRouter()
  const f = useActionForm(DomainSetupSchema, startDomainSetup, {
    defaultValues: { domain: defaultDomain, region: "ap-northeast-1" },
    onSuccess: (data: DomainActionResult) => {
      toast.success(`Added ${data.details?.name ?? "the domain"} to Resend. Now add the DNS records.`)
      if (data.note) toast.info(data.note, { duration: 12_000 })
      router.refresh()
    },
  })
  return (
    <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        <TextField
          control={f.control}
          name="domain"
          label="Sending domain"
          required
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          helper="Emails go out from this domain, e.g. noreply@twchartered.com. You need access to its DNS settings."
          disabled={disabled}
        />
        <SelectField control={f.control} name="region" label="Resend region" required options={REGION_OPTIONS} helper="Where Resend sends from. It doesn't affect who receives the mail." disabled={disabled} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled || f.pending} aria-busy={f.pending}>
          {f.pending ? <Spinner /> : null}
          Add domain to Resend
        </Button>
      </div>
    </form>
  )
}

export function DomainWizard(props: DomainWizardProps) {
  const router = useRouter()
  const [details, setDetails] = React.useState<DomainDetails | null>(props.details)
  const [status, setStatus] = React.useState<DomainStatus>(props.details?.status ?? props.status)
  const [checkedAt, setCheckedAt] = React.useState<string | null>(props.details?.checkedAt ?? null)
  const [checking, setChecking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(props.lookupError)
  const [polls, setPolls] = React.useState(0)
  const [confirmRemove, setConfirmRemove] = React.useState(false)

  const hasDomain = Boolean(props.resendDomainId)
  const domainName = details?.name ?? props.sendingDomain

  const apply = React.useCallback(
    (data: DomainActionResult) => {
      if (data.details) {
        setDetails(data.details)
        setCheckedAt(data.details.checkedAt)
      }
      setStatus(data.status)
      setError(null)
      if (data.changed) {
        if (data.status === "verified") toast.success(`${domainName} is verified. The app can send email now.`)
        else if (data.status === "failed") toast.error(`Resend couldn't verify ${domainName}. Check the records below.`)
        router.refresh()
      }
      if (data.note) toast.info(data.note, { duration: 12_000 })
    },
    [domainName, router]
  )

  const check = React.useCallback(
    async (verify: boolean) => {
      setChecking(true)
      try {
        const r = await refreshDomainStatus({ verify })
        if (r.ok) apply(r.data)
        else {
          setError(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          if (verify) toast.error(r.error)
        }
      } catch {
        setError("We couldn't reach the server. Check your connection and try again.")
      } finally {
        setChecking(false)
      }
    },
    [apply]
  )

  // Resend's live answer (read when the page loaded) differs from what is stored: store it now, so
  // sending follows what Resend says rather than what this page last saw.
  const stale = Boolean(props.apiKeyPresent && props.details && props.details.status !== props.status)
  React.useEffect(() => {
    if (!stale) return
    const id = window.setTimeout(() => void check(false), 0)
    return () => window.clearTimeout(id)
  }, [stale, check])

  // Poll Resend while it is looking for the records (§7.13.5 "polls the status").
  React.useEffect(() => {
    if (!hasDomain || status !== "pending" || polls >= MAX_POLLS || !props.apiKeyPresent) return
    const id = window.setTimeout(() => {
      if (document.visibilityState === "visible") void check(false)
      setPolls((n) => n + 1)
    }, POLL_MS)
    return () => window.clearTimeout(id)
  }, [hasDomain, status, polls, check, props.apiKeyPresent])

  const remove = async () => {
    const r = await removeDomainSetup({ domain: domainName })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    toast.success(`Removed ${domainName} from Resend.`)
    if (r.data.note) toast.info(r.data.note, { duration: 12_000 })
    router.refresh()
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {!props.apiKeyPresent ? (
        <div role="note" className="flex gap-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-base text-text">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
          <p>
            RESEND_API_KEY isn&apos;t set on this deployment, so the app can&apos;t reach Resend: nothing can be verified or sent. Add the key in the
            hosting settings (Vercel → Project → Settings → Environment Variables) and redeploy.
          </p>
        </div>
      ) : null}

      <Steps status={status} hasDomain={hasDomain} />

      {!hasDomain ? (
        <AddDomainForm defaultDomain={props.sendingDomain} disabled={!props.apiKeyPresent} />
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-base font-medium break-all text-text">{domainName}</span>
                <StatusChip label={DOMAIN_STATUS_LABEL[status]} tone={STATUS_TONE[status]} meaning={DOMAIN_STATUS_MEANING[status]} variant="pill" />
              </div>
              <p className="mt-1 text-sm text-text-muted" aria-live="polite">
                {status === "verified" && props.verifiedAt
                  ? `Verified by Resend on ${formatDateTime(props.verifiedAt)}.`
                  : checkedAt
                    ? `Resend says “${details?.resendStatus.replace(/_/g, " ") ?? status}” · checked at ${formatTime(checkedAt)}`
                    : "Not checked yet."}
                {status === "pending" && polls < MAX_POLLS ? " · checking again every 30 seconds" : null}
                {status === "pending" && polls >= MAX_POLLS ? " · stopped checking on its own; use Check now" : null}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => {
                setPolls(0)
                void check(true)
              }} disabled={checking || !props.apiKeyPresent} aria-busy={checking} className="self-start sm:self-auto">
              {checking ? <Spinner /> : <RotateCwIcon aria-hidden="true" />}
              Check now
            </Button>
          </div>

          {error ? (
            <div role="alert" className="flex gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-base text-text">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
              <p>Couldn&apos;t read the domain from Resend: {error}</p>
            </div>
          ) : null}

          {details ? (
            status === "verified" ? (
              <Collapsible>
                <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform duration-150 group-data-[state=open]:rotate-180" />
                  DNS records ({details.records.filter((r) => !r.advisory).length} verified, DMARC recommended)
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <DnsRecords records={details.records} domain={details.name} />
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-base text-text">
                  Add these records at the company that manages {details.name}&apos;s DNS (GoDaddy, Cloudflare, BigRock, your web host). Then press
                  Check now. DNS changes usually show within an hour, sometimes up to a day.
                </p>
                <DnsRecords records={details.records} domain={details.name} />
              </div>
            )
          ) : null}

          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-muted">Wrong domain? Remove it from Resend and add another. Automatic email stops until the new one is verified.</p>
            <Button type="button" variant="destructive-outline" size="sm" onClick={() => setConfirmRemove(true)} disabled={!props.apiKeyPresent} className="self-start sm:self-auto">
              Remove domain
            </Button>
          </div>
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={`Remove ${domainName} from Resend?`}
            description={`The domain is deleted from the Resend account and its status here goes back to Not set up. Until another domain is verified, the app sends no email: invoices, reminders and invites show WhatsApp and Gmail instead. The DNS records stay at your provider; delete them there if you won't use them again.`}
            confirmLabel="Remove domain"
            destructive
            onConfirm={remove}
          />
        </>
      )}
    </div>
  )
}

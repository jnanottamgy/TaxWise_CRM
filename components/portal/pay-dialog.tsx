"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, CircleCheckIcon, ExternalLinkIcon, IndianRupeeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, TextField, TextareaField } from "@/components/app/form/fields"
import { CopyButton } from "@/components/app/copy-button"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { useActionForm } from "@/hooks/use-action-form"
import { formatDate } from "@/lib/format"
import { fail, type ActionResult } from "@/lib/result"
import { PaymentClaimSchema, type PaymentClaimInput } from "@/lib/schemas/portal"
import { reportPayment } from "@/server/actions/portal"
import type { PayDetails, UpiForInvoice } from "@/lib/data/portal"
import { PortalDropzone } from "@/components/portal/portal-dropzone"
import { PendingFileList } from "@/components/portal/pending-file-list"
import { usePendingUploads } from "@/components/portal/use-pending-uploads"

/**
 * The Pay dialog (§7.22): the amount still due; the UPI QR code and the deep link
 * (upi://pay?pa=<upi_id>&pn=<payee>&am=<amount>&tn=<invoice no>&cu=INR) for paying from a phone; the
 * bank details for a transfer; and "I've paid" (reference + date + optional screenshot), which tells
 * the firm to verify. It never marks the invoice paid: only the receipt the firm records does, and
 * the dialog says so. The footer stays on screen at 1366×768 and 390×844 (§0.1 rule 4).
 */

export interface PayInvoice {
  id: string
  invoiceNumber: string
  outstanding: number
  dueDate: string
  isOverdue: boolean
  pendingClaim: { reference: string | null; paidOn: string | null; reportedAt: string } | null
}

type Stage = "pay" | "report" | "done"

function Detail({ term, value, copy }: { term: string; value: string | null; copy?: string }) {
  if (!value) return null
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-sm text-text-muted">{term}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-right text-base text-text">
        <span className={cn("min-w-0 break-all", copy && "num font-medium tabular-nums")}>{value}</span>
        {copy ? <CopyButton value={value} label={copy} /> : null}
      </dd>
    </div>
  )
}

function PayOptions({ invoice, details, upi }: { invoice: PayInvoice; details: PayDetails; upi: UpiForInvoice | null }) {
  const bank = details.bank
  const hasBank = Boolean(bank && (bank.accountNumber || bank.ifsc))
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm text-text-muted">Amount due</p>
        <p className="mt-0.5 text-2xl font-semibold tracking-[-0.01em] text-text">
          <Money value={invoice.outstanding} />
        </p>
        <p className="mt-0.5 text-sm text-text-muted">
          Invoice <span className="num tabular-nums">{invoice.invoiceNumber}</span> · due <DateText date={invoice.dueDate} withRelative />
        </p>
      </div>

      {invoice.pendingClaim ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text">
          You told us on {formatDate(invoice.pendingClaim.reportedAt)} that you paid
          {invoice.pendingClaim.reference ? ` (reference ${invoice.pendingClaim.reference})` : ""}. We&apos;ll confirm once it shows in our bank account.
        </p>
      ) : null}

      {upi ? (
        <section aria-labelledby="pay-upi" className="rounded-lg border border-border">
          <h3 id="pay-upi" className="border-b border-border px-4 py-2.5 text-base font-semibold text-text">
            Pay by UPI
          </h3>
          <div className="flex flex-col items-center gap-4 px-4 py-4 sm:flex-row sm:items-start">
            {upi.qrDataUrl ? (
              // A data URL made on the server for this invoice; next/image adds nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={upi.qrDataUrl}
                width={176}
                height={176}
                alt={`UPI QR code to pay ${invoice.invoiceNumber} to ${details.upi?.payeeName ?? details.payee}`}
                className="size-44 flex-none rounded-md border border-border bg-white p-1"
              />
            ) : null}
            <div className="flex w-full min-w-0 flex-col gap-3">
              <p className="text-sm text-text-muted">Scan the code with any UPI app, or on this phone open your UPI app with the amount filled in.</p>
              <Button asChild className="w-full sm:w-auto">
                <a href={upi.url}>
                  <ExternalLinkIcon aria-hidden="true" />
                  Open in a UPI app
                </a>
              </Button>
              <dl className="divide-y divide-border/70">
                <Detail term="UPI ID" value={details.upi?.id ?? null} copy="UPI ID" />
                <Detail term="Payee" value={details.upi?.payeeName ?? null} />
              </dl>
            </div>
          </div>
        </section>
      ) : null}

      {hasBank && bank ? (
        <section aria-labelledby="pay-bank" className="rounded-lg border border-border">
          <h3 id="pay-bank" className="border-b border-border px-4 py-2.5 text-base font-semibold text-text">
            Pay by bank transfer
          </h3>
          <dl className="divide-y divide-border/70 px-4">
            <Detail term="Account name" value={bank.accountName ?? details.payee} />
            <Detail term="Account number" value={bank.accountNumber} copy="account number" />
            <Detail term="IFSC" value={bank.ifsc} copy="IFSC" />
            <Detail term="Bank" value={bank.name} />
            <Detail term="Branch" value={bank.branch} />
          </dl>
          <p className="border-t border-border px-4 py-2.5 text-sm text-text-muted">
            Put <span className="num font-medium text-text tabular-nums">{invoice.invoiceNumber}</span> in the transfer&apos;s remarks so we can match it.
          </p>
        </section>
      ) : null}

      {!upi && !hasBank ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-base text-text">
          Our payment details aren&apos;t in the portal yet.{" "}
          <Link href="/portal/messages" className="font-medium text-primary hover:underline">
            Send us a message
          </Link>{" "}
          and we&apos;ll share them.
        </p>
      ) : null}

      <p className="text-sm text-text-muted">
        If you deduct TDS, pay the balance and mention the TDS in &ldquo;I&apos;ve paid&rdquo;. The invoice shows Paid once we record your payment.
      </p>
    </div>
  )
}

function ReportForm({
  invoice,
  clientId,
  today,
  onBack,
  onDone,
  formId,
  onPendingChange,
}: {
  invoice: PayInvoice
  clientId: string
  today: string
  onBack: () => void
  onDone: () => void
  formId: string
  onPendingChange: (pending: boolean, dirty: boolean) => void
}) {
  const proof = usePendingUploads({ clientId, max: 1, category: "other", titleFor: () => `Payment proof for ${invoice.invoiceNumber}` })
  const submit = React.useCallback(
    async (values: PaymentClaimInput): Promise<ActionResult<{ claimId: string; invoiceNumber: string; hasScreenshot: boolean }>> => {
      const up = await proof.uploadAll()
      if (!up.ok) return fail(up.error, { ref: up.ref, fieldErrors: { uploadId: [up.error] } })
      return reportPayment({ ...values, uploadId: up.uploadIds[0] ?? null })
    },
    [proof]
  )
  const f = useActionForm(PaymentClaimSchema, submit, {
    defaultValues: { invoiceId: invoice.id, reference: "", paidOn: today, note: "", uploadId: null },
    onSuccess: () => onDone(),
  })
  const pending = f.pending || proof.busy
  const dirty = f.form.formState.isDirty || proof.files.length > 0
  React.useEffect(() => onPendingChange(pending, dirty), [pending, dirty, onPendingChange])
  const proofError = f.form.formState.errors.uploadId?.message

  return (
    <form id={formId} noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={pending} className="-ml-2">
          <ArrowLeftIcon aria-hidden="true" />
          Payment details
        </Button>
      </div>
      <p className="text-base text-text">
        Tell us about your payment for <span className="num font-medium tabular-nums">{invoice.invoiceNumber}</span> and we&apos;ll match it in our bank account.
      </p>
      <FormAlert state={f} className="mb-0" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          control={f.control}
          name="reference"
          label="Payment reference"
          required
          helper="The UTR, UPI transaction ID or cheque number."
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <DateField control={f.control} name="paidOn" label="Paid on" required max={today} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-text">
          Screenshot <span className="font-normal text-text-muted">(optional)</span>
        </p>
        {proof.files.length === 0 ? (
          <PortalDropzone onFiles={proof.add} disabled={pending} compact label="Add a screenshot or the bank's confirmation." />
        ) : (
          <PendingFileList uploads={proof} />
        )}
        {proofError ? <p className="mt-1 text-sm text-danger-text">{proofError}</p> : null}
      </div>
      <TextareaField control={f.control} name="note" label="Anything we should know" rows={2} helper="For example, TDS you deducted, or a part payment." />
    </form>
  )
}

/**
 * "Pay" for an invoice: opens the Pay dialog. `size="sm"` in lists; the dialog itself is the same
 * everywhere.
 */
export function PayButton({
  invoice,
  details,
  upi,
  clientId,
  today,
  size = "sm",
  variant = "default",
  className,
}: {
  invoice: PayInvoice
  details: PayDetails
  upi: UpiForInvoice | null
  clientId: string
  today: string
  size?: "sm" | "default"
  variant?: "default" | "outline"
  className?: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [stage, setStage] = React.useState<Stage>("pay")
  const [busy, setBusy] = React.useState({ pending: false, dirty: false })
  const formId = React.useId()
  const onPendingChange = React.useCallback((pending: boolean, dirty: boolean) => setBusy({ pending, dirty }), [])

  const change = (next: boolean) => {
    setOpen(next)
    if (!next) {
      if (stage === "done") router.refresh()
      setStage("pay")
      setBusy({ pending: false, dirty: false })
    }
  }

  const footer =
    stage === "pay" ? (
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => change(false)}>
          Close
        </Button>
        <Button type="button" onClick={() => setStage("report")}>
          I&apos;ve paid
        </Button>
      </div>
    ) : stage === "report" ? (
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => change(false)} disabled={busy.pending}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={busy.pending} aria-busy={busy.pending}>
          {busy.pending ? <Spinner /> : null}
          Tell the firm
        </Button>
      </div>
    ) : (
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" onClick={() => change(false)}>
          Done
        </Button>
      </div>
    )

  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={() => setOpen(true)} className={className}>
        <IndianRupeeIcon aria-hidden="true" />
        Pay
        <span className="sr-only"> invoice {invoice.invoiceNumber}</span>
      </Button>
      <FormDialog
        open={open}
        onOpenChange={change}
        size="md"
        title={stage === "report" ? "I've paid" : `Pay invoice ${invoice.invoiceNumber}`}
        description={stage === "report" ? `Invoice ${invoice.invoiceNumber}` : undefined}
        footer={footer}
        pending={busy.pending}
        dirty={stage === "report" && busy.dirty}
      >
        {stage === "pay" ? (
          <PayOptions invoice={invoice} details={details} upi={upi} />
        ) : stage === "report" ? (
          <ReportForm invoice={invoice} clientId={clientId} today={today} onBack={() => setStage("pay")} onDone={() => setStage("done")} formId={formId} onPendingChange={onPendingChange} />
        ) : (
          <div role="status" className="flex flex-col items-start gap-3 py-2">
            <CircleCheckIcon aria-hidden="true" className="size-5 text-success-text" />
            <p className="text-md font-semibold text-text">Thank you. We&apos;ve told the firm.</p>
            <p className="text-base text-text-muted">
              We&apos;ll confirm once the payment shows in our bank account. Invoice <span className="num tabular-nums">{invoice.invoiceNumber}</span> changes to Paid when we record it; until then it still shows the amount due.
            </p>
          </div>
        )}
      </FormDialog>
    </>
  )
}

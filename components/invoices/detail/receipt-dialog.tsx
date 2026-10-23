"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { toast } from "sonner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, MoneyField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { Money } from "@/components/app/money"
import { Button } from "@/components/ui/button"
import { useActionForm } from "@/hooks/use-action-form"
import { formatINR, fromPaise, paiseToDecimalString, toPaise } from "@/lib/domain/money"
import { tdsRulesOn } from "@/lib/domain/tds"
import { isDateString } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { emailOutcomeNotice } from "@/lib/handoff"
import {
  PAYMENT_METHOD_OPTIONS,
  RecordReceiptSchema,
  checkReceiptAmounts,
  paiseOf,
  referenceLabel,
  tdsQuarterLabel,
  tdsSectionOptions,
  tdsSuggestion,
} from "@/lib/schemas/receipts"
import { recordReceipt } from "@/server/actions/receipts"
import type { DetailInvoice, PendingClaim, ReceiptContext } from "@/components/invoices/detail/types"

/**
 * Record receipt (§7.9.4): payment date, amount received, TDS deducted and its section (from the
 * parameters in force on the payment date), method, reference, deposited to, notes. The expected TDS
 * is suggested on the taxable value excluding GST (§6.5) with the difference from what the client
 * deducted; received + TDS may not pass the outstanding amount by more than ₹1, and the excess is
 * refused with "record the advance separately". The status (Partially paid / Paid) and the
 * outstanding amount follow from the receipt in the database, never from this form.
 */
export function ReceiptDialog({
  invoice,
  ctx,
  claim,
  onClose,
}: {
  invoice: DetailInvoice
  ctx: ReceiptContext
  /** A portal "I've paid" claim this receipt answers (§7.22). */
  claim?: PendingClaim | null
  onClose: () => void
}) {
  const router = useRouter()
  const firstRules = tdsRulesOn(claim?.paidOn && isDateString(claim.paidOn) ? claim.paidOn : ctx.today, ctx.tdsRows)
  const professional = firstRules.find((r) => r.nature === "professional")
  const f = useActionForm(RecordReceiptSchema, recordReceipt, {
    defaultValues: {
      invoiceId: invoice.id,
      invoiceUpdatedAt: invoice.updatedAt,
      paymentDate: claim?.paidOn && isDateString(claim.paidOn) && claim.paidOn <= ctx.today ? claim.paidOn : ctx.today,
      amountReceived: "",
      tdsAmount: "",
      tdsSection: ctx.clientHasTan && professional ? `${professional.section}:${professional.nature}` : "",
      method: claim ? "upi" : "bank_transfer",
      reference: claim?.reference ?? "",
      depositedTo: ctx.defaultDepositedTo,
      notes: claim?.note ? `Client's note on the portal: ${claim.note}` : "",
      emailReceipt: false,
      emailTo: ctx.defaultEmail ?? "",
      claimId: claim?.id ?? null,
    },
    onSuccess: (data) => {
      const settled = data.status === "paid" ? "The invoice is paid." : `${formatINR(toPaise(data.outstanding))} is still outstanding.`
      toast.success(`Receipt ${data.receiptNumber} recorded. ${settled}`)
      if (data.email) {
        const n = emailOutcomeNotice(data.email, f.form.getValues("emailTo") ?? "the client")
        if (n.tone === "success") toast.success(`Receipt ${n.message.charAt(0).toLowerCase()}${n.message.slice(1)}`)
        else toast.warning(`The receipt email didn't go: ${n.message}`, { duration: 12_000 })
      }
      onClose()
      router.refresh()
    },
  })
  const control = f.control
  const [paymentDate, tdsSection, tdsAmount, amountReceived, method, emailReceipt] = useWatch({
    control,
    name: ["paymentDate", "tdsSection", "tdsAmount", "amountReceived", "method", "emailReceipt"],
  }) as [string, string, string, string, string, boolean]

  const rules = tdsRulesOn(isDateString(paymentDate ?? "") ? paymentDate : ctx.today, ctx.tdsRows)
  const options = tdsSectionOptions(rules)
  const picked = options.find((o) => o.value === tdsSection) ?? null
  const suggestion = tdsSuggestion({ taxablePaise: ctx.taxablePaise, ratePercent: picked?.ratePercent ?? null, tdsAlreadyPaise: ctx.tdsAlreadyPaise, tdsDeductedText: tdsAmount ?? "" })
  const check = checkReceiptAmounts({ amountReceived: amountReceived ?? "", tdsAmount: tdsAmount ?? "" }, invoice.outstandingPaise)
  const tdsPaise = paiseOf(tdsAmount)
  const restPaise = Math.max(0, invoice.outstandingPaise - tdsPaise)
  const setMoney = (name: "tdsAmount" | "amountReceived", paise: number) => f.form.setValue(name, paiseToDecimalString(paise), { shouldDirty: true, shouldValidate: true })

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="Record receipt"
      description={
        <>
          {invoice.number} · {invoice.clientName} · <Money value={fromPaise(invoice.outstandingPaise)} /> outstanding
        </>
      }
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Record receipt"
    >
      <FormAlert state={f} />
      {claim ? (
        <p className="mb-4 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-sm text-text">
          The client said on the portal they paid{claim.paidOn ? ` on ${formatDate(claim.paidOn)}` : ""}
          {claim.reference ? ` (reference ${claim.reference})` : ""}. Check your bank statement before recording it.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DateField control={control} name="paymentDate" label="Payment date" required max={ctx.today} />
        <SelectField control={control} name="method" label="Method" required options={PAYMENT_METHOD_OPTIONS} />
        <MoneyField
          control={control}
          name="amountReceived"
          label="Amount received (₹)"
          required
          helper={
            <span className="inline-flex flex-wrap items-center gap-x-2">
              <span>
                Rest after TDS: <Money value={fromPaise(restPaise)} />
              </span>
              {restPaise > 0 && paiseOf(amountReceived) !== restPaise ? (
                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-sm" onClick={() => setMoney("amountReceived", restPaise)}>
                  Use it
                </Button>
              ) : null}
            </span>
          }
        />
        <MoneyField control={control} name="tdsAmount" label="TDS deducted (₹)" helper={tdsPaise > 0 && isDateString(paymentDate ?? "") ? `Quarter ${tdsQuarterLabel(paymentDate)}` : "Leave empty if the client deducted none."} />
        <SelectField
          control={control}
          name="tdsSection"
          label="TDS section"
          required={tdsPaise > 0}
          placeholder="No TDS"
          options={options.map((o) => ({ value: o.value, label: o.verified ? o.label : `${o.label} (awaiting a Partner's check)` }))}
          className="sm:col-span-2"
        />
      </div>

      {suggestion ? (
        <div className="mt-3 rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-sm" aria-live="polite">
          <p className="text-text">
            Expected TDS at {suggestion.ratePercent}% on the taxable value of <Money value={fromPaise(ctx.taxablePaise)} /> (excluding GST):{" "}
            <strong className="font-semibold">
              <Money value={fromPaise(suggestion.expectedPaise)} />
            </strong>
            {ctx.tdsAlreadyPaise > 0 ? (
              <span className="text-text-muted">
                {" "}
                after <Money value={fromPaise(ctx.tdsAlreadyPaise)} /> on earlier receipts
              </span>
            ) : null}
            .
            {suggestion.expectedPaise > 0 && tdsPaise !== suggestion.expectedPaise ? (
              <Button type="button" variant="link" size="sm" className="ml-1 h-auto p-0 text-sm" onClick={() => setMoney("tdsAmount", suggestion.expectedPaise)}>
                Use it
              </Button>
            ) : null}
          </p>
          {suggestion.difference?.message ? <p className={suggestion.difference.kind === "matches" ? "mt-1 text-success-text" : "mt-1 text-warning-text"}>{suggestion.difference.message}</p> : null}
        </div>
      ) : null}

      {!check.ok ? (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          {check.error}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField control={control} name="reference" label={referenceLabel(method as never)} autoComplete="off" />
        <TextField control={control} name="depositedTo" label="Deposited to" placeholder="Bank account" autoComplete="off" />
        <TextareaField control={control} name="notes" label="Notes" rows={2} className="sm:col-span-2" />
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
        <SwitchField control={control} name="emailReceipt" label="Email the receipt to the client" description="The receipt PDF, from the firm's mailbox." />
        {emailReceipt ? <TextField control={control} name="emailTo" label="Email to" required inputMode="email" autoComplete="off" /> : null}
      </div>
    </FormDialog>
  )
}

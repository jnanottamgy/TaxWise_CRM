"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, MoneyField, SelectField, TextareaField } from "@/components/app/form/fields"
import { Money } from "@/components/app/money"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"
import { useActionForm } from "@/hooks/use-action-form"
import { formatINR, fromPaise } from "@/lib/domain/money"
import { isDateString } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { CREDIT_NOTE_REASON_OPTIONS, IssueCreditNoteSchema, creditNotePreview, creditableRates } from "@/lib/schemas/credit-notes"
import { issueCreditNote } from "@/server/actions/credit-notes"
import type { CreditContext, DetailInvoice } from "@/components/invoices/detail/types"

/**
 * Issue a credit note (§7.9.7, Partner only): reason code and reason, the taxable amount at one of
 * the invoice's GST rates (no more than what is still creditable there), its GST split the invoice's
 * way, its own number series and PDF. A note that reduces GST must be issued by the s.34 deadline
 * (§6.4): the form warns from 30 days before and the database refuses it after; a commercial credit
 * (no GST change) is still allowed, with a notice.
 */
export function CreditNoteDialog({ invoice, ctx, onClose }: { invoice: DetailInvoice; ctx: CreditContext; onClose: () => void }) {
  const router = useRouter()
  const rates = creditableRates(ctx.items, ctx.creditNotes)
  const firstRate = rates.find((r) => r.remainingPaise > 0) ?? rates[0] ?? null
  const f = useActionForm(IssueCreditNoteSchema, issueCreditNote, {
    defaultValues: {
      invoiceId: invoice.id,
      reasonCode: "",
      reason: "",
      taxableAmount: "",
      taxRate: firstRate ? String(firstRate.ratePercent) : "",
      reducesGst: rates.some((r) => r.remainingPaise > 0),
      issueDate: ctx.today,
      annualReturnFiledOn: ctx.annualReturnFiledOn ?? "",
      notes: "",
    },
    onSuccess: (data) => {
      toast.success(`Credit note ${data.creditNoteNumber} issued.`)
      onClose()
      router.refresh()
    },
  })
  const control = f.control
  const reduces = useController({ control, name: "reducesGst" })
  const [taxableText, taxRate, filedOn] = useWatch({ control, name: ["taxableAmount", "taxRate", "annualReturnFiledOn"] }) as [string, string, string]
  const rate = rates.find((r) => String(r.ratePercent) === String(taxRate)) ?? null
  const reducesGst = Boolean(reduces.field.value)
  const preview = creditNotePreview(
    {
      taxableText: String(taxableText ?? ""),
      ratePercent: reducesGst ? (rate?.ratePercent ?? null) : null,
      reducesGst,
      invoiceDate: invoice.issueDate,
      // s.34 is judged on the day the note is actually issued, whatever date is typed on it (the
      // database refuses a backdated tax-reducing note once the deadline has passed, 0190).
      creditNoteDate: ctx.today,
      annualReturnFiledOn: filedOn && isDateString(filedOn) ? filedOn : null,
      placeOfSupplyCode: invoice.placeOfSupplyCode,
      firmStateCode: ctx.firmStateCode,
      remainingTaxablePaise: rate?.remainingPaise ?? 0,
      outstandingPaise: invoice.outstandingPaise,
    },
    ctx.params,
  )
  const intra = invoice.placeOfSupplyCode === ctx.firmStateCode
  const legend = React.useId()
  const refused = preview.check.level === "refuse"

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="Issue credit note"
      description={`Against ${invoice.number} · ${invoice.clientName}. It gets the next credit note number and a PDF.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Issue credit note"
      submitDisabled={refused || Boolean(preview.amountError)}
    >
      <FormAlert state={f} />
      <fieldset aria-labelledby={legend} className="mb-4">
        <legend id={legend} className="mb-2 text-sm font-medium text-text">
          What it changes
        </legend>
        <RadioGroup
          value={reducesGst ? "gst" : "commercial"}
          onValueChange={(v) => {
            reduces.field.onChange(v === "gst")
            reduces.field.onBlur()
          }}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {[
            { v: "gst", t: "Reduces the invoice and its GST", d: "A GST credit note (s.34), reported in GSTR-1." },
            { v: "commercial", t: "Commercial credit only", d: "A discount on what the client owes. The GST stays as invoiced." },
          ].map((o) => (
            <label key={o.v} className={cn("flex cursor-pointer gap-3 rounded-md border px-3 py-2.5", (reducesGst ? "gst" : "commercial") === o.v ? "border-primary bg-primary-soft/40" : "border-border hover:bg-surface-2")}>
              <RadioGroupItem value={o.v} aria-label={o.t} className="mt-0.5" disabled={o.v === "gst" && rates.every((r) => r.remainingPaise <= 0)} />
              <span className="flex flex-col">
                <span className="text-base text-text">{o.t}</span>
                <span className="text-sm text-text-muted">{o.d}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField control={control} name="reasonCode" label="Reason code" required options={CREDIT_NOTE_REASON_OPTIONS} />
        <DateField control={control} name="issueDate" label="Credit note date" required max={ctx.today} min={invoice.issueDate} />
        {reducesGst ? (
          <SelectField
            control={control}
            name="taxRate"
            label="GST rate"
            required
            options={rates.map((r) => ({ value: String(r.ratePercent), label: `${r.ratePercent}% · ${formatINR(r.remainingPaise)} creditable`, disabled: r.remainingPaise <= 0 }))}
          />
        ) : null}
        <MoneyField control={control} name="taxableAmount" label={reducesGst ? "Taxable amount to credit (₹)" : "Amount to credit (₹)"} required />
        <TextareaField control={control} name="reason" label="Reason" required rows={2} className="sm:col-span-2" placeholder="Fee reduced after the scope of the audit was cut" />
        <DateField
          control={control}
          name="annualReturnFiledOn"
          label={`Annual return for ${ctx.fy} filed on`}
          helper="If TaxWise's GSTR-9 for the invoice's year is filed, the s.34 deadline is the earlier date."
          max={ctx.today}
          className="sm:col-span-2"
        />
        <TextareaField control={control} name="notes" label="Notes" rows={2} className="sm:col-span-2" />
      </div>

      {preview.amountError ? (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          {preview.amountError}
        </p>
      ) : null}

      {preview.check.message ? (
        <p
          role={refused ? "alert" : "status"}
          className={cn(
            "mt-3 rounded-md border px-3 py-2 text-sm text-text",
            refused ? "border-danger/30 bg-danger-soft" : preview.check.level === "warn" ? "border-warning/30 bg-warning-soft" : "border-info/30 bg-info-soft"
          )}
        >
          {preview.check.message}
        </p>
      ) : reducesGst ? (
        <p className="mt-3 text-sm text-text-muted">s.34 deadline for this invoice: {formatDate(preview.check.deadline)}.</p>
      ) : null}

      {preview.amounts ? (
        <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-sm">
          <dt className="text-text-muted">{reducesGst ? "Taxable value" : "Credit"}</dt>
          <dd className="text-right">
            <Money value={fromPaise(preview.amounts.taxablePaise)} />
          </dd>
          {reducesGst ? (
            intra ? (
              <>
                <dt className="text-text-muted">CGST {(rate?.ratePercent ?? 0) / 2}%</dt>
                <dd className="text-right">
                  <Money value={fromPaise(preview.amounts.cgstPaise)} />
                </dd>
                <dt className="text-text-muted">SGST {(rate?.ratePercent ?? 0) / 2}%</dt>
                <dd className="text-right">
                  <Money value={fromPaise(preview.amounts.sgstPaise)} />
                </dd>
              </>
            ) : (
              <>
                <dt className="text-text-muted">IGST {rate?.ratePercent ?? 0}%</dt>
                <dd className="text-right">
                  <Money value={fromPaise(preview.amounts.igstPaise)} />
                </dd>
              </>
            )
          ) : null}
          <dt className="border-t border-border pt-1 font-medium text-text">Credit note total</dt>
          <dd className="border-t border-border pt-1 text-right font-semibold">
            <Money value={fromPaise(preview.amounts.totalPaise)} />
          </dd>
        </dl>
      ) : null}
      {preview.refundPaise > 0 ? (
        <p className="mt-2 text-sm text-warning-text">
          The client has already paid more than this leaves due: <Money value={fromPaise(preview.refundPaise)} /> would be owed back. Record the refund separately.
        </p>
      ) : null}
    </FormDialog>
  )
}

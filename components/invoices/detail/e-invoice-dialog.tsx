"use client"

import { useRouter } from "next/navigation"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { EInvoiceSchema } from "@/lib/schemas/invoices"
import { saveEInvoiceDetails } from "@/server/actions/invoices"
import type { DetailInvoice } from "@/components/invoices/detail/types"

/**
 * The IRN details from the e-invoice portal (§6.4, optional): when e-invoicing applies to the firm,
 * the invoice is registered on the IRP outside the app and its IRN, acknowledgement and signed QR
 * are recorded here, so the PDF prints them. Clearing the IRN removes them.
 */
export function EInvoiceDialog({ invoice, today, onClose }: { invoice: DetailInvoice; today: string; onClose: () => void }) {
  const router = useRouter()
  const f = useActionForm(EInvoiceSchema, saveEInvoiceDetails, {
    defaultValues: {
      invoiceId: invoice.id,
      updatedAt: invoice.updatedAt,
      irn: invoice.eInvoice.irn ?? "",
      ackNo: invoice.eInvoice.ackNo ?? "",
      ackDate: invoice.eInvoice.ackDate ? invoice.eInvoice.ackDate.slice(0, 10) : "",
      signedQr: invoice.eInvoice.signedQr ?? "",
    },
    successMessage: "E-invoice details saved. The PDF prints them now.",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="E-invoice details"
      description={`${invoice.number} · as returned by the Invoice Registration Portal.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save details"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField control={f.control} name="irn" label="IRN" helper="64 characters" autoComplete="off" spellCheck={false} className="sm:col-span-2 [&_input]:font-mono" />
        <TextField control={f.control} name="ackNo" label="Acknowledgement no." inputMode="numeric" autoComplete="off" />
        <DateField control={f.control} name="ackDate" label="Acknowledgement date" max={today} min={invoice.issueDate} />
        <TextareaField control={f.control} name="signedQr" label="Signed QR code text" rows={3} helper="Printed as the QR code on the invoice." className="sm:col-span-2" />
      </div>
    </FormDialog>
  )
}

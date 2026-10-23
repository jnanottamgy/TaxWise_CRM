"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FOLLOW_UP_CHANNELS, FOLLOW_UP_CHANNEL_LABEL, FollowUpSchema, type FollowUpInput } from "@/lib/schemas/collections"
import { logFollowUp } from "@/server/actions/collections"
import { useActionForm } from "@/hooks/use-action-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, TextareaField } from "@/components/app/form/fields"

/**
 * Log a follow-up on an invoice (§7.9.5): channel, notes*, the date they promised to pay (it feeds
 * the collection forecast), and when to follow up next (a reminder comes that morning).
 */
export function FollowUpDialog({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  today,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceId: string
  invoiceNumber: string | null
  today: string
}) {
  const router = useRouter()
  const defaults: FollowUpInput = { invoiceId, channel: "call", notes: "", promisedPaymentDate: "", nextFollowUpOn: "" }
  const f = useActionForm(FollowUpSchema, logFollowUp, {
    defaultValues: defaults,
    successMessage: "Follow-up logged.",
    onSuccess: () => {
      f.form.reset(defaults)
      onOpenChange(false)
      router.refresh()
    },
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) f.clearFormError()
        onOpenChange(o)
      }}
      size="md"
      title="Log follow-up"
      description={invoiceNumber ? `Invoice ${invoiceNumber}` : undefined}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Log follow-up"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <SelectField control={f.control} name="channel" label="How" required options={FOLLOW_UP_CHANNELS.map((c) => ({ value: c, label: FOLLOW_UP_CHANNEL_LABEL[c] }))} />
        <TextareaField control={f.control} name="notes" label="Notes" required rows={4} helper="What was said or agreed, and with whom." />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DateField control={f.control} name="promisedPaymentDate" label="Promised to pay by" min={today} helper="Feeds the collection forecast." />
          <DateField control={f.control} name="nextFollowUpOn" label="Next follow-up" min={today} helper="A reminder comes to you that morning." />
        </div>
      </div>
    </FormDialog>
  )
}

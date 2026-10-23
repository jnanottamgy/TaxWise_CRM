"use client"

import * as React from "react"
import { useWatch, type Control, type FieldValues } from "react-hook-form"
import type { z } from "zod"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import type { ActionResult } from "@/lib/result"

/**
 * One dialog for every action that needs a reason in words (§7.9.3): return to the raiser, mark
 * disputed, waive, cancel & reissue, start a debit note, reverse a receipt. The reason is required;
 * the dialog says exactly what will happen before the button does it.
 */
export function ReasonDialog<T>({
  onClose,
  title,
  description,
  details,
  label,
  placeholder,
  helper,
  submitLabel,
  schema,
  action,
  values,
  field = "reason",
  successMessage,
  onDone,
}: {
  onClose: () => void
  title: string
  description: React.ReactNode
  /** What else happens, shown above the reason. */
  details?: React.ReactNode
  label: string
  placeholder?: string
  helper?: React.ReactNode
  submitLabel: string
  schema: z.ZodType<FieldValues, FieldValues>
  action: (input: never) => Promise<ActionResult<T>>
  /** The fixed part of the input (invoiceId, updatedAt, receiptId). */
  values: Record<string, unknown>
  /** The reason's field name in the schema. */
  field?: "reason" | "note"
  successMessage?: string | ((data: T) => string)
  onDone: (data: T) => void | Promise<void>
}) {
  const f = useActionForm(schema, action as (input: FieldValues) => Promise<ActionResult<T>>, {
    defaultValues: { ...values, [field]: "" },
    successMessage,
    onSuccess: async (data) => {
      onClose()
      await onDone(data)
    },
  })
  const control = f.control as unknown as Control<FieldValues>
  const reason = useWatch({ control, name: field }) as unknown
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={title}
      description={description}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={Boolean(String(reason ?? "").trim())}
      submitLabel={submitLabel}
    >
      <FormAlert state={f} />
      {details ? <div className="mb-4 text-sm text-text-muted">{details}</div> : null}
      <TextareaField control={control} name={field} label={label} required rows={3} placeholder={placeholder} helper={helper} />
    </FormDialog>
  )
}

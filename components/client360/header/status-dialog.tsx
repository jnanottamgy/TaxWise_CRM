"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { InfoIcon } from "lucide-react"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { CLIENT_STATUSES, type ClientStatus } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { ClientStatusChangeSchema, statusChangeConsequence } from "@/lib/schemas/clients"
import { changeClientStatus } from "@/server/actions/client-status"

/**
 * Change status with a reason (§7.3.4). The dialog says what the new status does before it is
 * saved: On hold and Inactive pause automatic invoicing and client-facing reminders.
 */
export function StatusDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  current,
  updatedAt,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  clientName: string
  current: ClientStatus
  updatedAt: string
}) {
  const router = useRouter()
  const options = CLIENT_STATUSES.filter((s) => s !== current).map((s) => ({ value: s, label: getStatus("client_status", s).label }))
  const f = useActionForm(ClientStatusChangeSchema, changeClientStatus, {
    defaultValues: { clientId, to: undefined, reason: "", updatedAt },
    successMessage: (d) => `${clientName} is now ${getStatus("client_status", d.to).label}.`,
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })

  React.useEffect(() => {
    if (open) f.form.reset({ clientId, to: undefined, reason: "", updatedAt })
    // Reset when the dialog opens, with the row's current updated_at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])

  const to = f.form.watch("to") as ClientStatus | undefined
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Change ${clientName}'s status`}
      description={`Now ${getStatus("client_status", current).label}. The reason is kept in the client's history.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={to ? `Change to ${getStatus("client_status", to).label}` : "Change status"}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <SelectField control={f.control} name="to" label="New status" required options={options} />
        {to ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm text-text">
            <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none text-text-muted" />
            <span>{statusChangeConsequence(to)}</span>
          </p>
        ) : null}
        <TextareaField control={f.control} name="reason" label="Reason" required rows={3} maxLength={500} placeholder="Client asked to pause work until April" />
      </div>
    </FormDialog>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { ClientNotesSchema } from "@/components/client360/logic/profile-schemas"
import { updateClientNotes } from "@/server/actions/client-profile"

/**
 * The client's internal notes. Everyone who can see the client may edit them: for an Employee this
 * is the "limited edit" of §4.1 (the 0033 guard lets them change nothing else on the client).
 */
export function NotesDialog({ open, onOpenChange, clientId, updatedAt, notes }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; updatedAt: string; notes: string | null }) {
  const router = useRouter()
  const f = useActionForm(ClientNotesSchema, updateClientNotes, {
    defaultValues: { clientId, updatedAt, notes: notes ?? "" },
    successMessage: "Notes saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset({ clientId, updatedAt, notes: notes ?? "" })
    // Reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Notes"
      description="Internal notes about this client. Never shown to the client."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save notes"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <TextareaField control={f.control} name="notes" label="Notes" hideLabel rows={8} maxLength={4000} />
      </div>
    </FormDialog>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { z } from "zod"
import { CALL_KIND_LABEL, CALL_KINDS, CallNoteSchema, type CallNoteInput } from "@/lib/handoff"
import { logCallNote } from "@/server/actions/messages"
import { DateTimeField } from "@/components/client360/form/datetime-field"

/** A select can't hold an empty value, so "No one in particular" is this token until it is sent. */
const NO_CONTACT = "none"

const LogCallFormSchema = CallNoteSchema.extend({
  contactId: z
    .union([z.uuid({ error: "Choose one of the client's contacts." }), z.literal(NO_CONTACT), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v && v !== NO_CONTACT ? v : null)),
})

type LogCallFormInput = z.input<typeof LogCallFormSchema>

function send(input: LogCallFormInput) {
  const payload: CallNoteInput = { ...input, contactId: input.contactId && input.contactId !== NO_CONTACT ? input.contactId : null }
  return logCallNote(payload)
}

/**
 * "Log a call/note" (§7.3.3 quick actions, §7.13.1 "Call log / note: Logged"): who it was with,
 * when, a one-line summary and what was discussed. It lands on the Communication tab and the
 * timeline; nothing is sent to the client.
 */
export function LogCallDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  contacts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  clientName: string
  contacts: Array<{ id: string; name: string; role: string | null; is_primary: boolean }>
}) {
  const router = useRouter()
  const primary = contacts.find((c) => c.is_primary) ?? contacts[0] ?? null
  const f = useActionForm(LogCallFormSchema, send, {
    defaultValues: { clientId, contactId: primary?.id ?? NO_CONTACT, kind: "call_out", occurredAt: "", subject: "", body: "" },
    successMessage: "Logged on the client's Communication tab.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })

  React.useEffect(() => {
    if (open) f.form.reset({ clientId, contactId: primary?.id ?? NO_CONTACT, kind: "call_out", occurredAt: "", subject: "", body: "" })
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const kind = f.form.watch("kind")
  const contactOptions = [{ value: NO_CONTACT, label: "No one in particular" }, ...contacts.map((c) => ({ value: c.id, label: c.role ? `${c.name} (${c.role})` : c.name }))]

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Log a call or note"
      description={`For ${clientName}. It shows on the Communication tab and the timeline; nothing is sent to the client.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={kind === "note" ? "Save note" : "Log it"}
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField control={f.control} name="kind" label="What was it" required options={CALL_KINDS.map((k) => ({ value: k, label: CALL_KIND_LABEL[k] }))} />
          <SelectField control={f.control} name="contactId" label={kind === "note" ? "About" : "With"} options={contactOptions} />
        </div>
        <DateTimeField control={f.control} name="occurredAt" label="When" helper="Leave empty for now. Times are IST." max={new Date().toISOString()} />
        <TextField control={f.control} name="subject" label="Summary" placeholder="Asked for the September purchase invoices" maxLength={200} />
        <TextareaField control={f.control} name="body" label={kind === "note" ? "Note" : "What was discussed"} required rows={5} maxLength={5000} />
      </div>
    </FormDialog>
  )
}

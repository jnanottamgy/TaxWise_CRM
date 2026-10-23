"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PhoneCallIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { DateTimeField } from "@/components/client360/form/datetime-field"
import { useActionForm } from "@/hooks/use-action-form"
import { CALL_KINDS, CALL_KIND_LABEL } from "@/lib/handoff"
import { LeadNoteSchema, type LeadNoteInput } from "@/lib/schemas/leads"
import { logLeadNote } from "@/server/actions/leads"

const KIND_OPTIONS = CALL_KINDS.map((k) => ({ value: k, label: CALL_KIND_LABEL[k] }))

/**
 * Log a call or note on a lead (§7.5.1 "log a call/note"): what kind, when (now by default), a
 * one-line summary, what was discussed, and optionally the next follow-up. It goes on the lead's
 * timeline and counts as activity, so the lead isn't flagged as untouched.
 */
export function LogLeadNoteButton({ leadId, leadName, nextFollowUpAt }: { leadId: string; leadName: string; nextFollowUpAt: string | null }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const defaults: LeadNoteInput = { leadId, kind: "call_out", occurredAt: "", subject: "", body: "", nextFollowUpAt: nextFollowUpAt ?? "" }
  const f = useActionForm(LeadNoteSchema, logLeadNote, {
    defaultValues: defaults,
    successMessage: "Logged on the lead's timeline.",
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
  })
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          f.form.reset(defaults)
          f.clearFormError()
          setOpen(true)
        }}
      >
        <PhoneCallIcon aria-hidden="true" />
        Log a call or note
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Log a call or note"
        description={`On ${leadName}'s timeline.`}
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Log it"
      >
        <div className="flex flex-col gap-4">
          <FormAlert state={f} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField control={f.control} name="kind" label="What" required options={KIND_OPTIONS} />
            <DateTimeField control={f.control} name="occurredAt" label="When" helper="Leave empty for now." max={new Date().toISOString()} />
          </div>
          <TextField control={f.control} name="subject" label="Summary" maxLength={200} placeholder="Wants a quote for GST and ITR from April" />
          <TextareaField control={f.control} name="body" label="What was discussed" required rows={4} maxLength={5000} />
          <DateTimeField control={f.control} name="nextFollowUpAt" label="Next follow-up" helper="A reminder comes up at this time." />
        </div>
      </FormDialog>
    </>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BellRingIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateTimeField } from "@/components/client360/form/datetime-field"
import { useActionForm } from "@/hooks/use-action-form"
import { LeadFollowUpSchema } from "@/lib/schemas/leads"
import { setLeadFollowUp } from "@/server/actions/leads"

/** Set, move or clear the lead's next follow-up (§7.5.1 "Next follow-up (date-time)"; the reminder comes at that time). */
export function FollowUpControl({ leadId, updatedAt, nextFollowUpAt }: { leadId: string; updatedAt: string; nextFollowUpAt: string | null }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const defaults = { id: leadId, updatedAt, nextFollowUpAt: nextFollowUpAt ?? "" }
  const f = useActionForm(LeadFollowUpSchema, setLeadFollowUp, {
    defaultValues: defaults,
    successMessage: (d) => (d ? "Next follow-up saved." : "Saved."),
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
  })
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          f.form.reset(defaults)
          f.clearFormError()
          setOpen(true)
        }}
      >
        <BellRingIcon aria-hidden="true" />
        {nextFollowUpAt ? "Change" : "Set follow-up"}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Next follow-up"
        description="A reminder goes to the person the lead is assigned to at this time. Leave it empty to clear it."
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Save"
      >
        <div className="flex flex-col gap-4">
          <FormAlert state={f} />
          <DateTimeField control={f.control} name="nextFollowUpAt" label="Follow up at" />
        </div>
      </FormDialog>
    </>
  )
}

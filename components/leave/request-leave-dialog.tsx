"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { CalendarPlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, SwitchField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { LEAVE_TYPE_OPTIONS, LeaveRequestSchema } from "@/lib/schemas/leave"
import { formatLeaveRange, leaveCalendarDays } from "@/lib/domain/leave"
import { isDateString } from "@/lib/domain/fy"
import { requestLeave } from "@/server/actions/leave"

/**
 * Request leave (§7.11.3): Type* · From* · To* (inclusive; half-day option) · Reason. Partners and
 * Managers may also record a request for someone they manage (it still needs a decision).
 */
export function RequestLeaveDialog({
  people,
  label = "Request leave",
  variant = "default",
}: {
  /** Someone else the requester may record leave for (Partners/Managers). Empty: only themselves. */
  people?: Array<{ id: string; full_name: string }>
  label?: string
  variant?: "default" | "outline"
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const f = useActionForm(LeaveRequestSchema, requestLeave, {
    defaultValues: { employee_id: null, type: "annual", start_date: "", end_date: "", half_day: false, reason: "" },
    successMessage: "Leave requested. Your approver has been told.",
    onSuccess: () => {
      setOpen(false)
      f.form.reset()
      router.refresh()
    },
  })
  const start = useWatch({ control: f.control, name: "start_date" })
  const end = useWatch({ control: f.control, name: "end_date" })
  const half = useWatch({ control: f.control, name: "half_day" })
  const summary =
    isDateString(start) && isDateString(end) && end >= start
      ? `${leaveCalendarDays(start, end, !!half)} ${leaveCalendarDays(start, end, !!half) === 1 ? "day" : "days"}, ${formatLeaveRange(start, end, !!half)}`
      : null

  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        <CalendarPlusIcon aria-hidden="true" />
        {label}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="md"
        title="Request leave"
        description="Managers decide Employees' leave; Partners decide Managers' and Partners'. Approved leave shows as On leave in attendance."
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Send request"
        footerStart={summary}
      >
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {people && people.length ? (
            <ComboboxField
              control={f.control}
              name="employee_id"
              label="For"
              className="md:col-span-2"
              options={people.map((p) => ({ value: p.id, label: p.full_name }))}
              placeholder="Myself"
              helper="Leave it as yourself, or record a request for someone you manage."
            />
          ) : null}
          <SelectField control={f.control} name="type" label="Type" required options={LEAVE_TYPE_OPTIONS} />
          <div className="hidden md:block" />
          <DateField control={f.control} name="start_date" label="From" required />
          <DateField control={f.control} name="end_date" label="To" required helper="Inclusive: the last day you're away." />
          <SwitchField control={f.control} name="half_day" label="Half day" description="A single date: make From and To the same day." className="md:col-span-2" />
          <TextareaField control={f.control} name="reason" label="Reason" rows={3} className="md:col-span-2" />
        </div>
      </FormDialog>
    </>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { LockIcon, LockOpenIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { formatMinutes } from "@/lib/format"
import { ApproveWeekSchema, ReopenWeekSchema, weekLabel } from "@/lib/schemas/timesheet"
import { approveTimesheetWeek, reopenTimesheetWeek } from "@/server/actions/timesheet"

/**
 * Week approval (§7.10 "A Partner/Manager can approve a week, which locks it"). Approving locks the
 * person's entries of the week; reopening (with a reason) unlocks them, except billed ones, which
 * stay read-only. The database decides who may: Partners anyone's week, Managers Employees' weeks
 * but never their own.
 */

type Person = { employee_id: string; name: string }

export function ApproveWeekButton({ person, weekStart, minutes, running, size = "sm", variant = "outline" }: { person: Person; weekStart: string; minutes: number; running: boolean; size?: "sm" | "default"; variant?: "outline" | "default" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={() => setOpen(true)}>
        <LockIcon aria-hidden="true" />
        Approve
      </Button>
      {open ? <ApproveDialog open={open} onOpenChange={setOpen} person={person} weekStart={weekStart} minutes={minutes} running={running} /> : null}
    </>
  )
}

function ApproveDialog({ open, onOpenChange, person, weekStart, minutes, running }: { open: boolean; onOpenChange: (o: boolean) => void; person: Person; weekStart: string; minutes: number; running: boolean }) {
  const router = useRouter()
  const f = useActionForm(ApproveWeekSchema, approveTimesheetWeek, {
    defaultValues: { employee_id: person.employee_id, week_start: weekStart, note: "" },
    successMessage: (d) => `${person.name}'s week approved: ${d.entries} ${d.entries === 1 ? "entry" : "entries"} (${formatMinutes(d.minutes)}) locked.`,
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Approve ${person.name}'s week?`}
      description={`${weekLabel(weekStart)} · ${formatMinutes(minutes)} logged. Approving locks every entry of the week; nobody can change them until it is reopened.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Approve and lock"
    >
      <FormAlert state={f} />
      {running ? (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-text">
          {person.name} has a timer running. It has to be stopped before the week can be approved.
        </p>
      ) : null}
      <TextareaField control={f.control} name="note" label="Note" rows={2} placeholder="Optional, for the audit trail" />
    </FormDialog>
  )
}

export function ReopenWeekButton({ person, weekStart, size = "sm" }: { person: Person; weekStart: string; size?: "sm" | "default" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size={size} variant="ghost" onClick={() => setOpen(true)}>
        <LockOpenIcon aria-hidden="true" />
        Reopen
      </Button>
      {open ? <ReopenDialog open={open} onOpenChange={setOpen} person={person} weekStart={weekStart} /> : null}
    </>
  )
}

function ReopenDialog({ open, onOpenChange, person, weekStart }: { open: boolean; onOpenChange: (o: boolean) => void; person: Person; weekStart: string }) {
  const router = useRouter()
  const f = useActionForm(ReopenWeekSchema, reopenTimesheetWeek, {
    defaultValues: { employee_id: person.employee_id, week_start: weekStart, reason: "" },
    successMessage: (d) =>
      d.billed > 0
        ? `Week reopened: ${d.unlocked} ${d.unlocked === 1 ? "entry" : "entries"} unlocked. ${d.billed} billed ${d.billed === 1 ? "entry stays" : "entries stay"} read-only.`
        : `Week reopened: ${d.unlocked} ${d.unlocked === 1 ? "entry" : "entries"} unlocked.`,
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Reopen ${person.name}'s week?`}
      description={`${weekLabel(weekStart)}. Its entries unlock so they can be corrected; billed entries stay read-only.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Reopen week"
    >
      <FormAlert state={f} />
      <TextareaField control={f.control} name="reason" label="Reason" required rows={3} placeholder="What needs correcting" />
    </FormDialog>
  )
}

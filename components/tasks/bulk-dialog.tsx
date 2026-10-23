"use client"

import * as React from "react"
import { toast } from "sonner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { TASK_PRIORITIES } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { BulkTaskSchema } from "@/lib/schemas/tasks"
import { bulkUpdateTasks } from "@/server/actions/tasks"
import type { StaffPick } from "@/components/tasks/task-form"

/**
 * Bulk changes to selected tasks (§7.6.7): assign, change reviewer, change due date (with a
 * reason), change priority. Tasks that can't take the change (already filed, or the person is the
 * task's reviewer or assignee) are skipped and listed, never half-changed.
 */

export type BulkKind = "assignee" | "reviewer" | "due_date" | "priority"

const COPY: Record<BulkKind, { title: string; submit: string }> = {
  assignee: { title: "Assign tasks", submit: "Assign" },
  reviewer: { title: "Change the reviewer", submit: "Change reviewer" },
  due_date: { title: "Change the due date", submit: "Change due date" },
  priority: { title: "Change the priority", submit: "Change priority" },
}

export function BulkDialog({
  kind,
  ids,
  staff,
  reviewers,
  onClose,
  onDone,
}: {
  kind: BulkKind
  ids: string[]
  staff: StaffPick[]
  reviewers: StaffPick[]
  onClose: () => void
  onDone: () => void
}) {
  const f = useActionForm(BulkTaskSchema, bulkUpdateTasks, {
    defaultValues: { ids, change: kind, assigned_employee_id: "", reviewer_employee_id: "", due_date: "", priority: "", reason: "" },
    onSuccess: (d) => {
      const lines = d.skipped.map((s) => `${s.task_number ? `${s.task_number}: ` : ""}${s.reason}`)
      if (d.updated) toast.success(`${d.updated} ${d.updated === 1 ? "task" : "tasks"} changed.`)
      if (lines.length) toast.warning(`${lines.length} skipped: ${lines.slice(0, 4).join("; ")}${lines.length > 4 ? "…" : ""}`, { duration: 12_000 })
      if (!d.updated && !lines.length) toast.message("Nothing needed changing.")
      onDone()
    },
  })
  const n = ids.length
  const people = (list: StaffPick[]) => list.map((s) => ({ value: s.id, label: s.name, description: s.designation ?? undefined }))
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={COPY[kind].title}
      description={`${n} selected ${n === 1 ? "task" : "tasks"}.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={COPY[kind].submit}
    >
      <FormAlert state={f} />
      <div className="flex flex-col gap-4">
        {kind === "assignee" ? (
          <ComboboxField
            control={f.control}
            name="assigned_employee_id"
            label="Assign to"
            placeholder="Unassign them"
            options={people(staff)}
            helper="Each task waits for the new assignee to accept it. Leave empty to unassign."
          />
        ) : null}
        {kind === "reviewer" ? (
          <ComboboxField control={f.control} name="reviewer_employee_id" label="Reviewer" placeholder="Any Manager" options={people(reviewers)} helper="Leave empty for any Manager to review." />
        ) : null}
        {kind === "due_date" ? (
          <>
            <DateField control={f.control} name="due_date" label="New due date" />
            <TextareaField control={f.control} name="reason" label="Reason" required rows={3} helper="Kept on each task's history and the client's timeline. Escalation re-arms." />
          </>
        ) : null}
        {kind === "priority" ? (
          <SelectField control={f.control} name="priority" label="Priority" required options={TASK_PRIORITIES.map((p) => ({ value: p, label: getStatus("task_priority", p).label }))} />
        ) : null}
      </div>
    </FormDialog>
  )
}

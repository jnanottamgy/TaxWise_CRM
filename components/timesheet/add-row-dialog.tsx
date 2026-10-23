"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, SwitchField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { useActionForm } from "@/hooks/use-action-form"
import { weekLabel, AddRowSchema } from "@/lib/schemas/timesheet"
import { addGridRow } from "@/server/actions/timesheet"
import { searchTaskClients, searchTasks } from "@/server/actions/tasks"

/**
 * Adds a row to the week grid (§7.10): a client, a task of it (or of any client you work on), or
 * neither for internal time. The row stays on the week even before any time is typed into it.
 */
export function AddRowDialog({ open, onOpenChange, weekStart }: { open: boolean; onOpenChange: (open: boolean) => void; weekStart: string }) {
  const router = useRouter()
  const f = useActionForm(AddRowSchema, addGridRow, {
    defaultValues: { week_start: weekStart, client_id: "", task_id: "", billable: true },
    successMessage: `Row added to ${weekLabel(weekStart)}.`,
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const v = useWatch({ control: f.control })
  const [clientLabel, setClientLabel] = React.useState("")
  const [taskLabel, setTaskLabel] = React.useState("")
  const hasClient = Boolean(v.client_id || v.task_id)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a row"
      description="A client or task you work on this week. Leave both empty for internal time."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Add row"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4">
        <ComboboxField
          control={f.control}
          name="client_id"
          label="Client"
          placeholder="Internal (no client)"
          searchPlaceholder="Name or code"
          selectedLabel={clientLabel}
          loadOptions={async (q: string) => {
            const r = await searchTaskClients({ q })
            return r.ok ? r.data : []
          }}
          onSelectOption={(o?: ComboOption) => {
            setClientLabel(o?.label ?? "")
            if (f.form.getValues("task_id")) {
              f.form.setValue("task_id", "")
              setTaskLabel("")
            }
          }}
        />
        <ComboboxField
          control={f.control}
          name="task_id"
          label="Task"
          placeholder="No task"
          searchPlaceholder="Task number or title"
          selectedLabel={taskLabel}
          loadOptions={async (q: string) => {
            const r = await searchTasks({ q, clientId: (f.form.getValues("client_id") as string) || null, openOnly: true })
            return r.ok ? r.data : []
          }}
          onSelectOption={(o?: ComboOption) => setTaskLabel(o?.label ?? "")}
          helper={v.client_id ? "Open tasks of this client." : "Picking a task fills in its client."}
        />
        <SwitchField
          control={f.control}
          name="billable"
          label="Billable"
          description={hasClient ? "Time on this row counts towards the client's unbilled time." : "Internal time is never billable."}
          disabled={!hasClient}
        />
      </div>
    </FormDialog>
  )
}

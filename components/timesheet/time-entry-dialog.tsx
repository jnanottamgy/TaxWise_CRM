"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, useWatch } from "react-hook-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useActionForm } from "@/hooks/use-action-form"
import { formatMinutes } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import { TimeEntrySchema, entryTimes } from "@/lib/schemas/timesheet"
import { saveTimeEntry } from "@/server/actions/timesheet"
import { searchTaskClients, searchTasks } from "@/server/actions/tasks"

/**
 * Manual time entry (§7.10): Date* · Client · Task (filtered by client) · Start/End or Duration* ·
 * Description · Billable (on for client work). Also edits an entry that isn't locked. Time can't
 * be logged for later than now, nor more than 24 hours in one entry; an approved or billed week is
 * locked, and the database refuses changes to it.
 */

export type EntryInitial = {
  id?: string
  updated_at?: string
  date?: string
  client?: { id: string; label: string } | null
  task?: { id: string; label: string } | null
  mode?: "range" | "duration"
  start?: string
  end?: string
  duration?: string
  description?: string | null
  billable?: boolean
}

export function TimeEntryDialog({ open, onOpenChange, initial = {}, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; initial?: EntryInitial; onSaved?: () => void }) {
  const router = useRouter()
  const today = todayIST()
  const f = useActionForm(TimeEntrySchema, saveTimeEntry, {
    defaultValues: {
      id: initial.id ?? "",
      expected_updated_at: initial.updated_at ?? null,
      date: initial.date ?? today,
      client_id: initial.client?.id ?? "",
      task_id: initial.task?.id ?? "",
      mode: initial.mode ?? "duration",
      start: initial.start ?? "",
      end: initial.end ?? "",
      duration: initial.duration ?? "",
      description: initial.description ?? "",
      billable: initial.billable ?? true,
    },
    successMessage: (d) => `${formatMinutes(d.minutes)} ${initial.id ? "saved" : "logged"}.`,
    onSuccess: () => {
      onOpenChange(false)
      onSaved?.()
      router.refresh()
    },
  })
  const v = useWatch({ control: f.control })
  const mode = useController({ control: f.control, name: "mode" })
  const [clientLabel, setClientLabel] = React.useState(initial.client?.label ?? "")
  const [taskLabel, setTaskLabel] = React.useState(initial.task?.label ?? "")
  const preview = entryTimes({ date: v.date ?? "", mode: (v.mode as "range" | "duration") ?? "duration", start: v.start, end: v.end, duration: v.duration })
  const hasClient = Boolean(v.client_id || v.task_id)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial.id ? "Edit time" : "Log time"}
      description="Time you've already spent. Use the timer for time as you work."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={initial.id ? "Save" : "Log time"}
      footerStart={preview.ok ? <span className="num tabular-nums">{formatMinutes(preview.minutes)}</span> : null}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DateField control={f.control} name="date" label="Date" required max={today} />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text">Time as</span>
          <ToggleGroup
            type="single"
            value={mode.field.value}
            onValueChange={(val) => val && mode.field.onChange(val)}
            variant="outline"
            className="w-full"
            aria-label="Enter the time as a duration, or a start and end"
          >
            <ToggleGroupItem value="duration" className="flex-1">
              Duration
            </ToggleGroupItem>
            <ToggleGroupItem value="range" className="flex-1">
              Start and end
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {mode.field.value === "duration" ? (
          <TextField control={f.control} name="duration" label="Duration" required placeholder="1:30" helper="1:30, 1h 30m, 90m or 1.5 (hours)." inputMode="text" autoComplete="off" className="md:col-span-2" />
        ) : (
          <>
            <TextField control={f.control} name="start" label="Start" required type="time" />
            <TextField control={f.control} name="end" label="End" required type="time" />
          </>
        )}
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
            const r = await searchTasks({ q, clientId: (f.form.getValues("client_id") as string) || null, openOnly: false })
            return r.ok ? r.data : []
          }}
          onSelectOption={(o?: ComboOption) => setTaskLabel(o?.label ?? "")}
          helper={v.client_id ? "Tasks of this client." : "Picking a task fills in its client."}
        />
        <TextareaField control={f.control} name="description" label="Description" rows={2} className="md:col-span-2" placeholder="What you worked on" />
        <SwitchField
          control={f.control}
          name="billable"
          label="Billable"
          description={hasClient ? "Counts towards the client's unbilled time." : "Internal time is never billable."}
          disabled={!hasClient}
          className="md:col-span-2"
        />
      </div>
    </FormDialog>
  )
}

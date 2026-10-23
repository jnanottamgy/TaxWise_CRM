"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { CalendarClockIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { NativeSelectField } from "@/components/tasks/native-select-field"
import { useActionForm } from "@/hooks/use-action-form"
import { TASK_PRIORITIES, type ServiceType, type TaskPriority } from "@/lib/domain/enums"
import { todayIST } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { getStatus } from "@/lib/status"
import { SERVICE_OPTIONS } from "@/lib/schemas/tasks"
import {
  AutomationSchema,
  PERIOD_TOKEN,
  RECURRING_FREQUENCIES,
  RECURRING_FREQUENCY_LABELS,
  describeSchedule,
  firstRunOnOrAfter,
  planRun,
  type RecurringConfig,
  type RecurringFrequency,
} from "@/lib/schemas/job-templates"
import { saveAutomation } from "@/server/actions/task-automations"
import { searchTaskClients } from "@/server/actions/tasks"
import type { StaffPick } from "@/components/tasks/task-form"

/**
 * A recurring task (§7.6.7): for a client, a task each period from a title with {period} (and
 * optionally a job template's steps), e.g. "GSTR-3B: {period}" on the 1st of every month for the
 * month just ended, due 19 days later. The preview shows the next task it will create.
 */

export type AutomationForEdit = {
  id: string
  client_id: string
  client_label: string
  frequency: RecurringFrequency
  config: RecurringConfig
  is_active: boolean
  updated_at: string
}

export type AutomationOptions = {
  staff: StaffPick[]
  reviewers: StaffPick[]
  templates: Array<{ id: string; name: string; service_type: ServiceType; default_lead_days: number | null }>
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export function AutomationDialog({
  open,
  onOpenChange,
  options,
  automation,
  client,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: AutomationOptions
  automation?: AutomationForEdit | null
  /** Fixed client (Client 360 → Tasks). */
  client?: { id: string; label: string } | null
}) {
  const router = useRouter()
  const c = automation?.config
  const f = useActionForm(AutomationSchema, saveAutomation, {
    defaultValues: {
      id: automation?.id ?? "",
      expected_updated_at: automation?.updated_at ?? null,
      client_id: automation?.client_id ?? client?.id ?? "",
      title: c?.title ?? "",
      description: c?.description ?? "",
      job_template_id: c?.job_template_id ?? "",
      service_type: c?.service_type ?? "",
      priority: (c?.priority ?? "medium") as TaskPriority,
      estimated_minutes: c?.estimated_minutes === null || c?.estimated_minutes === undefined ? "" : String(c.estimated_minutes),
      assignee_employee_id: c?.assignee_employee_id ?? "",
      reviewer_employee_id: c?.reviewer_employee_id ?? "",
      frequency: automation?.frequency ?? "monthly",
      run_day: String(c?.run_day ?? 1),
      run_month: c?.run_month ? String(c.run_month) : "4",
      run_weekday: c?.run_weekday ? String(c.run_weekday) : "1",
      period_offset: c?.period_offset ?? 1,
      due_after_days: String(c?.due_after_days ?? 10),
      is_active: automation?.is_active ?? true,
      starts_on: "",
    },
    successMessage: (d) => `Recurring task saved. The next one is created on ${formatDate(d.next_run_on)}.`,
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const v = useWatch({ control: f.control })
  const [clientLabel, setClientLabel] = React.useState(automation?.client_label ?? client?.label ?? "")
  const freq = (v.frequency ?? "monthly") as RecurringFrequency
  const templateId = (v.job_template_id as string) || ""
  React.useEffect(() => {
    const t = options.templates.find((x) => x.id === templateId)
    if (!t) return
    if (!f.form.getValues("service_type")) f.form.setValue("service_type", t.service_type, { shouldDirty: true })
    if (t.default_lead_days !== null && !f.form.getFieldState("due_after_days").isDirty) f.form.setValue("due_after_days", String(t.default_lead_days))
  }, [templateId, options.templates, f.form])

  const preview = (() => {
    const runDay = Number(v.run_day)
    const due = Number(v.due_after_days)
    if (!Number.isInteger(runDay) || runDay < 1 || runDay > 28 || !Number.isInteger(due) || due < 0) return null
    const schedule = {
      frequency: freq,
      run_day: runDay,
      run_month: freq === "yearly" ? Number(v.run_month) || 4 : null,
      run_weekday: freq === "weekly" ? Number(v.run_weekday) || 1 : null,
      period_offset: (Number(v.period_offset) === 0 ? 0 : 1) as 0 | 1,
      due_after_days: due,
    }
    const today = todayIST()
    const from = v.starts_on && v.starts_on > today ? v.starts_on : today
    try {
      const run = firstRunOnOrAfter(schedule, from)
      return { words: describeSchedule(schedule), plan: planRun(schedule, (v.title as string) || `Task ${PERIOD_TOKEN}`, run) }
    } catch {
      return null
    }
  })()

  const people = (list: StaffPick[]): ComboOption[] => list.map((s) => ({ value: s.id, label: s.name, description: s.designation ?? undefined }))

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={automation ? "Edit recurring task" : "New recurring task"}
      description="Creates a task each period for one client, assigned as you set it up."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={automation ? "Save" : "Set up recurring task"}
      footerStart={preview ? <span>Next: {formatDate(preview.plan.runDate)}</span> : null}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {client || automation ? (
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-sm font-medium text-text">Client</span>
            <p className="flex h-9 items-center rounded-md border border-border bg-surface-2 px-3 text-base text-text">{clientLabel}</p>
          </div>
        ) : (
          <ComboboxField
            control={f.control}
            name="client_id"
            label="Client"
            required
            className="md:col-span-2"
            placeholder="Choose a client"
            searchPlaceholder="Name or code"
            selectedLabel={clientLabel}
            loadOptions={async (q: string) => {
              const r = await searchTaskClients({ q })
              return r.ok ? r.data : []
            }}
            onSelectOption={(o?: ComboOption) => setClientLabel(o?.label ?? "")}
          />
        )}
        <TextField
          control={f.control}
          name="title"
          label="Title"
          required
          className="md:col-span-2"
          placeholder="GSTR-3B: {period}"
          helper="{period} becomes the period: Oct 2026, Q2 2026-27 or 2025-26."
        />
        <NativeSelectField
          control={f.control}
          name="job_template_id"
          label="Job template"
          helper="Its steps become each task's checklist."
          options={[{ value: "", label: "No template" }, ...options.templates.map((t) => ({ value: t.id, label: t.name }))]}
        />
        <NativeSelectField control={f.control} name="service_type" label="Service" options={[{ value: "", label: "No service" }, ...SERVICE_OPTIONS]} />
      </div>

      <h3 className="mt-6 mb-3 text-sm font-semibold text-text">Schedule</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <NativeSelectField control={f.control} name="frequency" label="How often" required options={RECURRING_FREQUENCIES.map((x) => ({ value: x, label: RECURRING_FREQUENCY_LABELS[x] }))} />
        {freq === "weekly" ? (
          <NativeSelectField control={f.control} name="run_weekday" label="Created on" required options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} />
        ) : (
          <TextField control={f.control} name="run_day" label="Created on day" required inputMode="numeric" helper={freq === "quarterly" ? "Of April, July, October and January (1–28)." : "Of the month (1–28)."} />
        )}
        {freq === "yearly" ? <NativeSelectField control={f.control} name="run_month" label="Month" required options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} /> : null}
        <NativeSelectField
          control={f.control}
          name="period_offset"
          label="For"
          options={[
            { value: "1", label: freq === "weekly" ? "The week just ended" : freq === "yearly" ? "The financial year just ended" : freq === "quarterly" ? "The quarter just ended" : "The month just ended" },
            { value: "0", label: freq === "weekly" ? "That week" : freq === "yearly" ? "That financial year" : freq === "quarterly" ? "That quarter" : "That month" },
          ]}
        />
        <TextField control={f.control} name="due_after_days" label="Due after (days)" required inputMode="numeric" helper="Days from creation to the due date." />
        <DateField control={f.control} name="starts_on" label="First run no earlier than" helper="Leave empty to start with the next date." />
      </div>

      <h3 className="mt-6 mb-3 text-sm font-semibold text-text">Task</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ComboboxField control={f.control} name="assignee_employee_id" label="Assignee" placeholder="Unassigned" options={people(options.staff)} />
        <ComboboxField control={f.control} name="reviewer_employee_id" label="Reviewer" placeholder="Any Manager" options={people(options.reviewers)} />
        <SelectField control={f.control} name="priority" label="Priority" options={TASK_PRIORITIES.map((p) => ({ value: p, label: getStatus("task_priority", p).label }))} />
        <TextField control={f.control} name="estimated_minutes" label="Estimate (minutes)" inputMode="numeric" placeholder="120" />
        <TextareaField control={f.control} name="description" label="Description" rows={2} className="md:col-span-2" />
        <SwitchField control={f.control} name="is_active" label="Active" description="Paused recurring tasks create nothing; resuming starts from the next date." className="md:col-span-2" />
      </div>

      {preview ? (
        <div className="mt-6 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm">
          <p className="flex items-center gap-2 font-medium text-text">
            <CalendarClockIcon aria-hidden="true" className="size-4 text-text-muted" />
            {preview.words}
          </p>
          <p className="mt-1 text-text">
            Next task: <span className="font-medium">{preview.plan.title}</span>, created {formatDate(preview.plan.runDate)}, due {formatDate(preview.plan.dueDate)}.
          </p>
        </div>
      ) : null}
    </FormDialog>
  )
}

export function NewAutomationButton({ options, client, size = "default", variant = "default" }: { options: AutomationOptions; client?: { id: string; label: string } | null; size?: "default" | "sm"; variant?: "default" | "outline" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        New recurring task
      </Button>
      {open ? <AutomationDialog open={open} onOpenChange={setOpen} options={options} client={client} /> : null}
    </>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useFieldArray, useWatch } from "react-hook-form"
import { CircleAlertIcon, InfoIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { ComboboxField, DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { NativeSelectField } from "@/components/tasks/native-select-field"
import { useActionForm } from "@/hooks/use-action-form"
import type { AssignmentFinding } from "@/lib/domain/assignment"
import { TASK_PRIORITIES, type ServiceType } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { CreateTaskSchema, SERVICE_OPTIONS, TASK_LIMITS, UpdateTaskSchema, periodOptionsForFy, splitEstimate } from "@/lib/schemas/tasks"
import { checkTaskAssignment, createTask, listDeadlinesForClient, searchTaskClients, searchTasks, updateTask } from "@/server/actions/tasks"
import { useDebounced } from "@/components/tasks/task-ui"

/**
 * Create / edit a task (§7.6.2): What (client, title, description, service, FY and period) · When
 * (due date, priority, estimated time) · Who (assignee, reviewer, who can't be the assignee) ·
 * Detail (checklist, or apply a job template whose steps get dates from its offsets; blocked by;
 * the compliance deadline it files; remarks). The assignment check runs as the people and the due
 * date change and shows inline before saving: blocks stop the save, warnings and call-outs inform.
 * The server runs the same check again on save.
 */

export type StaffPick = { id: string; name: string; designation: string | null; role: string }
export type TemplatePick = { id: string; name: string; service_type: ServiceType; steps: number }

export type TaskFormOptions = {
  staff: StaffPick[]
  reviewers: StaffPick[]
  templates: TemplatePick[]
  fyOptions: string[]
}

export type EditableTask = {
  id: string
  client_id: string
  client_label: string
  title: string
  description: string | null
  service_type: ServiceType | null
  financial_year: string | null
  period_label: string | null
  due_date: string | null
  priority: (typeof TASK_PRIORITIES)[number]
  estimated_minutes: number | null
  assigned_employee_id: string | null
  reviewer_employee_id: string | null
  remarks: string | null
  compliance_event_id: string | null
  updated_at: string
}

const PRIORITY_OPTIONS = TASK_PRIORITIES.map((p) => ({ value: p, label: getStatus("task_priority", p).label }))

function staffOptions(staff: StaffPick[], exclude?: string | null): ComboOption[] {
  return staff.filter((s) => s.id !== exclude).map((s) => ({ value: s.id, label: s.name, description: s.designation ?? undefined }))
}

/** The inline assignment check (§7.6.2). */
function AssignmentFindings({ findings, checking }: { findings: AssignmentFinding[]; checking: boolean }) {
  if (!findings.length && !checking) return null
  return (
    <div aria-live="polite" className="flex flex-col gap-1.5 md:col-span-2">
      {checking && !findings.length ? (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <Spinner className="size-3.5" /> Checking leave and workload…
        </p>
      ) : null}
      {findings.map((f) => (
        <p
          key={f.code}
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            f.level === "block" ? "border-danger/30 bg-danger-soft text-text" : f.level === "warn" ? "border-warning/30 bg-warning-soft text-text" : "border-border bg-surface-2 text-text",
          )}
        >
          {f.level === "block" ? (
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
          ) : f.level === "warn" ? (
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
          ) : (
            <InfoIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
          )}
          <span>
            <span className="sr-only">{f.level === "block" ? "Blocked: " : f.level === "warn" ? "Warning: " : "Note: "}</span>
            {f.message}
          </span>
        </p>
      ))}
    </div>
  )
}

function useAssignmentCheck(input: { taskId: string | null; clientId: string | null; assignee: string | null; reviewer: string | null; due: string | null }) {
  const key = JSON.stringify(input)
  const debounced = useDebounced(key, 400)
  const [state, setState] = React.useState<{ key: string; findings: AssignmentFinding[] }>({ key: "", findings: [] })
  React.useEffect(() => {
    const v = JSON.parse(debounced) as typeof input
    if (!v.assignee) return
    let live = true
    checkTaskAssignment({ task_id: v.taskId, client_id: v.clientId, assigned_employee_id: v.assignee, reviewer_employee_id: v.reviewer, due_date: v.due && /^\d{4}-\d{2}-\d{2}$/.test(v.due) ? v.due : null })
      .then((r) => {
        if (live && r.ok) setState({ key: debounced, findings: r.data })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [debounced])
  const findings = input.assignee && state.key === key ? state.findings : input.assignee ? state.findings : []
  return { findings: input.assignee ? findings : [], checking: Boolean(input.assignee) && state.key !== key }
}

// -------------------------------------------------------------------------------------------------
// Create
// -------------------------------------------------------------------------------------------------

export function NewTaskDialog({
  open,
  onOpenChange,
  options,
  client,
  defaultFy,
  templateFirst = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: TaskFormOptions
  /** Fixed client (Client 360 → Tasks). */
  client?: { id: string; label: string } | null
  defaultFy: string
  /** Reached from "Apply job template" (Client 360): the template picker comes first. */
  templateFirst?: boolean
}) {
  const router = useRouter()
  const f = useActionForm(CreateTaskSchema, createTask, {
    defaultValues: {
      client_id: client?.id ?? "",
      title: "",
      description: "",
      service_type: "",
      financial_year: defaultFy,
      period_label: "",
      due_date: "",
      priority: "medium",
      estimate_hours: "",
      estimate_minutes: "",
      assigned_employee_id: "",
      reviewer_employee_id: "",
      remarks: "",
      compliance_event_id: "",
      template_id: "",
      checklist: [],
      blocker_ids: [],
    },
    successMessage: (d) => `Task ${d.task_number} created.`,
    onSuccess: (d) => {
      onOpenChange(false)
      router.push(`/work/${d.id}`)
    },
  })
  const v = useWatch({ control: f.control })
  const check = useAssignmentCheck({
    taskId: null,
    clientId: v.client_id || null,
    assignee: v.assigned_employee_id || null,
    reviewer: v.reviewer_employee_id || null,
    due: v.due_date || null,
  })
  const blocked = check.findings.some((x) => x.level === "block")
  const checklist = useFieldArray({ control: f.control, name: "checklist" })
  const [blockers, setBlockers] = React.useState<ComboOption[]>([])
  const [clientLabel, setClientLabel] = React.useState(client?.label ?? "")

  const setBlockerIds = (next: ComboOption[]) => {
    setBlockers(next)
    f.form.setValue("blocker_ids", next.map((b) => b.value), { shouldDirty: true })
  }

  const templateField = (
    <NativeSelectField
      control={f.control}
      name="template_id"
      label="Apply job template"
      helper="Its steps join the checklist, each dated from the due date by the template's offsets."
      options={[{ value: "", label: "No template" }, ...options.templates.map((t) => ({ value: t.id, label: `${t.name} · ${t.steps} ${t.steps === 1 ? "step" : "steps"}` }))]}
      className="md:col-span-2"
    />
  )

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={templateFirst ? "New task from a job template" : "New task"}
      description={client ? `For ${client.label}` : "Assign work to the team. The assignee accepts it before work starts."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitDisabled={blocked}
      submitLabel="Create task"
      footerStart={blocked ? <span className="text-danger-text">Fix the assignment to save.</span> : null}
    >
      <FormAlert state={f} />
      {templateFirst ? (
        <Section title="Job template">
          {templateField}
          {options.templates.length === 0 ? <p className="text-sm text-text-muted md:col-span-2">No active job templates yet. A Partner or Manager adds them under Job templates.</p> : null}
        </Section>
      ) : null}
      <TaskSections f={f} v={v} options={options} clientLocked={Boolean(client)} clientLabel={clientLabel} onClientLabel={setClientLabel} check={check} mode="create" />

      <Section title="Detail">
        {templateFirst ? null : templateField}
        <div className="flex flex-col gap-2 md:col-span-2">
          <span className="text-sm font-medium text-text">Checklist</span>
          {checklist.fields.map((field, i) => (
            <div key={field.id} className="flex items-center gap-2">
              <Input aria-label={`Checklist item ${i + 1}`} maxLength={TASK_LIMITS.checklistItem} {...f.form.register(`checklist.${i}.title` as const)} placeholder="What needs doing" />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove checklist item ${i + 1}`} onClick={() => checklist.remove(i)}>
                <XIcon aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => checklist.append({ title: "" })} disabled={checklist.fields.length >= TASK_LIMITS.checklistItems}>
              <PlusIcon aria-hidden="true" />
              Add item
            </Button>
          </div>
        </div>
        <BlockersPicker value={blockers} onChange={setBlockerIds} clientId={v.client_id || null} excludeId={null} />
      </Section>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Edit
// -------------------------------------------------------------------------------------------------

export function EditTaskDialog({ open, onOpenChange, task, options }: { open: boolean; onOpenChange: (open: boolean) => void; task: EditableTask; options: TaskFormOptions }) {
  const router = useRouter()
  const est = splitEstimate(task.estimated_minutes)
  const f = useActionForm(UpdateTaskSchema, updateTask, {
    defaultValues: {
      id: task.id,
      expected_updated_at: task.updated_at,
      client_id: task.client_id,
      title: task.title,
      description: task.description ?? "",
      service_type: task.service_type ?? "",
      financial_year: task.financial_year ?? "",
      period_label: task.period_label ?? "",
      due_date: task.due_date ?? "",
      priority: task.priority,
      estimate_hours: est.hours,
      estimate_minutes: est.minutes,
      assigned_employee_id: task.assigned_employee_id ?? "",
      reviewer_employee_id: task.reviewer_employee_id ?? "",
      remarks: task.remarks ?? "",
      compliance_event_id: task.compliance_event_id ?? "",
    },
    successMessage: "Task saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const v = useWatch({ control: f.control })
  const check = useAssignmentCheck({ taskId: task.id, clientId: task.client_id, assignee: v.assigned_employee_id || null, reviewer: v.reviewer_employee_id || null, due: v.due_date || null })
  const blocked = check.findings.some((x) => x.level === "block")
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Edit task"
      description={`For ${task.client_label}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitDisabled={blocked}
      footerStart={blocked ? <span className="text-danger-text">Fix the assignment to save.</span> : null}
    >
      <FormAlert state={f} />
      <TaskSections f={f} v={v} options={options} clientLocked clientLabel={task.client_label} check={check} mode="edit" />
      <Section title="Detail">
        <TextareaField control={f.control} name="remarks" label="Remarks" rows={3} className="md:col-span-2" />
      </Section>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Shared sections
// -------------------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <h3 className="mb-3 text-sm font-semibold text-text">{title}</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the two forms share these sections; their field sets overlap exactly here */
function TaskSections({
  f,
  v,
  options,
  clientLocked,
  clientLabel,
  onClientLabel,
  check,
  mode,
}: {
  f: any
  v: any
  options: TaskFormOptions
  clientLocked: boolean
  clientLabel: string
  onClientLabel?: (label: string) => void
  check: { findings: AssignmentFinding[]; checking: boolean }
  mode: "create" | "edit"
}) {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const fy = (v.financial_year as string) || ""
  const periods = periodOptionsForFy(fy)
  const listId = React.useId()
  const [deadlines, setDeadlines] = React.useState<Array<{ value: string; label: string; description?: string }>>([])
  const clientId = (v.client_id as string) || ""
  React.useEffect(() => {
    if (!clientId) return
    let live = true
    listDeadlinesForClient({ clientId })
      .then((r) => live && r.ok && setDeadlines(r.data))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [clientId])

  return (
    <>
      <Section title="What">
        {clientLocked ? (
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
            onSelectOption={(o?: ComboOption) => {
              onClientLabel?.(o?.label ?? "")
              f.form.setValue("compliance_event_id", "")
            }}
          />
        )}
        <TextField control={f.control} name="title" label="Title" required maxLength={TASK_LIMITS.title} className="md:col-span-2" placeholder="GSTR-3B: Oct 2026" />
        <TextareaField control={f.control} name="description" label="Description" rows={3} className="md:col-span-2" />
        <NativeSelectField control={f.control} name="service_type" label="Service" options={[{ value: "", label: "No service" }, ...SERVICE_OPTIONS]} />
        <NativeSelectField control={f.control} name="financial_year" label="FY" options={[{ value: "", label: "No FY" }, ...options.fyOptions.map((y) => ({ value: y, label: y }))]} />
        <div className="md:col-span-2">
          <TextField control={f.control} name="period_label" label="Period" list={listId} placeholder={periods[5] ?? "Sep 2026"} helper="A month, a quarter or the year: Sep 2026, Q2 2026-27, 2026-27." autoComplete="off" />
          <datalist id={listId}>
            {periods.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        {clientId && deadlines.length ? (
          <NativeSelectField
            control={f.control}
            name="compliance_event_id"
            label="Deadline it files"
            helper="Filing the task records the filing against this deadline and marks it Filed."
            options={[{ value: "", label: "No deadline" }, ...deadlines.map((d) => ({ value: d.value, label: `${d.label}${d.description ? ` · ${d.description}` : ""}` }))]}
            className="md:col-span-2"
          />
        ) : null}
      </Section>

      <Section title="When">
        <DateField control={f.control} name="due_date" label="Due date" />
        <SelectField control={f.control} name="priority" label="Priority" options={PRIORITY_OPTIONS} />
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <span id={`${listId}-est`} className="text-sm font-medium text-text">
            Estimated time
          </span>
          <div className="grid max-w-xs grid-cols-2 gap-2" role="group" aria-labelledby={`${listId}-est`}>
            <TextField control={f.control} name="estimate_hours" label="Hours" inputMode="decimal" placeholder="0" />
            <TextField control={f.control} name="estimate_minutes" label="Minutes" inputMode="numeric" placeholder="0" />
          </div>
        </div>
      </Section>

      <Section title="Who">
        <ComboboxField
          control={f.control}
          name="assigned_employee_id"
          label="Assignee"
          placeholder="Unassigned"
          searchPlaceholder="Name"
          options={staffOptions(options.staff)}
          helper={mode === "create" ? "They accept or decline it before starting." : "A new assignee accepts or declines it first."}
        />
        <ComboboxField
          control={f.control}
          name="reviewer_employee_id"
          label="Reviewer"
          placeholder="Any Manager"
          searchPlaceholder="Name"
          options={staffOptions(options.reviewers, (v.assigned_employee_id as string) || null)}
          helper="Files it or sends it back. Can't be the assignee."
        />
        <AssignmentFindings findings={check.findings} checking={check.checking} />
      </Section>
    </>
  )
}

function BlockersPicker({ value, onChange, clientId, excludeId }: { value: ComboOption[]; onChange: (next: ComboOption[]) => void; clientId: string | null; excludeId: string | null }) {
  const [picker, setPicker] = React.useState<string | null>(null)
  const id = React.useId()
  return (
    <div className="flex flex-col gap-1.5 md:col-span-2">
      <label htmlFor={id} className="text-sm font-medium text-text">
        Blocked by
      </label>
      <Combobox
        id={id}
        value={picker}
        onChange={(v, o) => {
          setPicker(null)
          if (v && o && !value.some((b) => b.value === v)) onChange([...value, o])
        }}
        placeholder="Pick tasks this one waits for"
        searchPlaceholder="Task number, title or client"
        clearable={false}
        loadOptions={async (q) => {
          const r = await searchTasks({ q, clientId, excludeId, openOnly: true })
          return r.ok ? r.data : []
        }}
      />
      <p className="text-sm text-text-muted">It can&apos;t move to In progress, Under review or Filed/Done until these are Filed/Done.</p>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((b) => (
            <li key={b.value} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2.5 text-sm">
              <span className="truncate">{b.label}</span>
              <button type="button" aria-label={`Remove ${b.label}`} onClick={() => onChange(value.filter((x) => x.value !== b.value))} className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text">
                <XIcon aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

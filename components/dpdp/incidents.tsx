"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckIcon, PlusIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { FieldShell } from "@/components/app/form/field-shell"
import { CheckboxGroupField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { StatusChip } from "@/components/app/status-chip"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { useActionForm, type FormError } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STEPS,
  INCIDENT_STEP_HINTS,
  INCIDENT_STEP_LABELS,
  incidentStepsDone,
  incidentSummary,
  type IncidentFacts,
  type IncidentSeverity,
  type IncidentStep,
} from "@/lib/domain/dpdp"
import { DATA_CATEGORIES, DATA_CATEGORY_LABELS, IncidentSchema, isoToIstLocal, readIncidentActions, type DataCategory } from "@/lib/schemas/dpdp"
import { addIncidentAction, closeIncident, recordIncidentStep, saveIncident } from "@/server/actions/data-incidents"
import { toastResult } from "@/components/quality/feedback"
import type { IncidentRow } from "@/lib/data/dpdp"

const facts = (i: IncidentRow): IncidentFacts => ({
  detectedAt: i.detected_at ?? new Date().toISOString(),
  containedAt: i.contained_at,
  assessedAt: i.assessed_at,
  boardNotifiedAt: i.board_notified_at,
  principalsNotifiedAt: i.principals_notified_at,
  rootCause: i.root_cause,
  closedAt: i.closed_at,
})

function IncidentDialog({ onClose, row }: { onClose: () => void; row: IncidentRow | null }) {
  const router = useRouter()
  const f = useActionForm(IncidentSchema, saveIncident, {
    defaultValues: {
      id: row?.id ?? "",
      updatedAt: row?.updated_at ?? "",
      title: row?.title ?? "",
      detectedAt: isoToIstLocal(row?.detected_at ?? new Date().toISOString()),
      description: row?.description ?? "",
      dataCategories: (row?.data_categories ?? []) as DataCategory[],
      peopleAffectedEstimate: row?.people_affected_estimate === null || row?.people_affected_estimate === undefined ? "" : String(row.people_affected_estimate),
      severity: (row?.severity as IncidentSeverity) ?? "medium",
    },
    successMessage: row ? "Incident updated" : "Incident recorded: the Partners are told",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title={row ? "Incident details" : "Record a personal data breach"}
      description="Record it as soon as it is known. The Data Protection Board's report runs from when the firm became aware of it."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={row ? "Save" : "Record incident"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="title" label="Short title" required className="md:col-span-2" placeholder="Laptop with client files stolen" autoComplete="off" />
        <TextField control={f.control} name="detectedAt" label="Detected (IST)" required type="datetime-local" />
        <SelectField control={f.control} name="severity" label="Severity" required options={INCIDENT_SEVERITIES.map((s) => ({ value: s, label: INCIDENT_SEVERITY_LABELS[s] }))} />
        <TextareaField control={f.control} name="description" label="What happened" required rows={3} className="md:col-span-2" />
        <CheckboxGroupField control={f.control} name="dataCategories" label="Data involved" options={DATA_CATEGORIES.map((c) => ({ value: c, label: DATA_CATEGORY_LABELS[c] }))} columns={2} className="md:col-span-2" />
        <TextField control={f.control} name="peopleAffectedEstimate" label="People affected (estimate)" inputMode="numeric" />
      </div>
    </FormDialog>
  )
}

function StepDialog({ onClose, row, step }: { onClose: () => void; row: IncidentRow; step: IncidentStep }) {
  const router = useRouter()
  const [at, setAt] = React.useState(isoToIstLocal(new Date().toISOString()))
  const [text, setText] = React.useState(step === "assess" ? (row.assessment ?? "") : step === "notify_board" ? (row.board_reference ?? "") : step === "root_cause" ? (row.root_cause ?? "") : "")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const needsAt = step !== "root_cause"
  const textLabel = step === "assess" ? "Assessment" : step === "notify_board" ? "Board's acknowledgement or reference" : step === "root_cause" ? "Root cause and what changes" : null
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    setFieldErrors({})
    try {
      const r = await recordIncidentStep({ id: row.id ?? "", updatedAt: row.updated_at ?? "", step, at: needsAt ? at : null, text: text.trim() || null, undo: false })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        setFieldErrors(Object.fromEntries(Object.entries(r.fieldErrors ?? {}).map(([k, v]) => [k, v[0] ?? ""])))
        return
      }
      toastResult(r, `${INCIDENT_STEP_LABELS[step]}: recorded`)
      onClose()
      router.refresh()
    } finally {
      setPending(false)
    }
  }
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} size="sm" title={INCIDENT_STEP_LABELS[step]} description={INCIDENT_STEP_HINTS[step]} onSubmit={(e) => void submit(e)} pending={pending} submitLabel="Record step" dirty={false}>
      <FormAlert error={error} />
      <div className="flex flex-col gap-4">
        {needsAt ? (
          <FieldShell id="step-at" label="When it was done (IST)" required error={fieldErrors.at}>
            {(aria) => <Input {...aria} id="step-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
          </FieldShell>
        ) : null}
        {textLabel ? (
          <FieldShell id="step-text" label={textLabel} required={step === "assess" || step === "root_cause"} error={fieldErrors.text}>
            {(aria) => <Textarea {...aria} id="step-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} />}
          </FieldShell>
        ) : null}
      </div>
    </FormDialog>
  )
}

function ActionLog({ row, canEdit }: { row: IncidentRow; canEdit: boolean }) {
  const router = useRouter()
  const [text, setText] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const actions = readIncidentActions(row.actions).slice().reverse()
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-text">Log</p>
      {canEdit && !row.closed_at ? (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (text.trim().length < 3) return
            setPending(true)
            try {
              const r = await addIncidentAction({ id: row.id ?? "", updatedAt: row.updated_at ?? "", text: text.trim() })
              if (toastResult(r, "Added to the log")) {
                setText("")
                router.refresh()
              }
            } finally {
              setPending(false)
            }
          }}
        >
          <label htmlFor={`log-${row.id}`} className="sr-only">
            What was done
          </label>
          <Input id={`log-${row.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="What was done, and by whom" maxLength={1000} />
          <Button type="submit" variant="outline" size="default" disabled={pending || text.trim().length < 3}>
            {pending ? <Spinner /> : null}
            Add
          </Button>
        </form>
      ) : null}
      <ol className="flex flex-col gap-1.5">
        {actions.map((a, i) => (
          <li key={`${a.at}-${i}`} className="text-sm">
            <span className="text-text">{a.text}</span>
            <span className="block text-xs text-text-muted">
              {a.by_name ?? "Someone"}, {formatDateTime(a.at)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function IncidentCard({ row, canEdit, now, onEdit, onStep }: { row: IncidentRow; canEdit: boolean; now: Date; onEdit: () => void; onStep: (s: IncidentStep) => void }) {
  const router = useRouter()
  const [closing, setClosing] = React.useState<"close" | "reopen" | null>(null)
  const f = facts(row)
  const done = incidentStepsDone(f)
  const s = incidentSummary(f, now)
  const open = !row.closed_at
  // The deadline as the database computes it (dpdp.breach_board_report_hours, 0198).
  const boardDue = row.board_report_due_at ?? s.boardDueAt
  const boardLate = row.board_overdue ?? s.boardLate
  return (
    <section aria-labelledby={`inc-${row.id}`} id={`incident-${row.id}`} className="rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3 md:flex-row md:items-start md:justify-between md:px-5">
        <div className="min-w-0">
          <h3 id={`inc-${row.id}`} className="text-md font-semibold text-text">
            {row.title ?? "Incident"}
          </h3>
          <p className="mt-0.5 text-sm text-text-muted">
            Detected {formatDateTime(row.detected_at)} · {INCIDENT_SEVERITY_LABELS[(row.severity ?? "medium") as IncidentSeverity]} severity
            {row.people_affected_estimate !== null ? ` · about ${row.people_affected_estimate} ${row.people_affected_estimate === 1 ? "person" : "people"}` : ""}
          </p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          {open ? (
            boardLate ? (
              <StatusChip label="Board report late" tone="danger" meaning={`The Data Protection Board's report was due ${formatDateTime(boardDue)}.`} variant="pill" />
            ) : row.board_notified_at ? (
              <StatusChip label="Open" tone="warning" meaning={`${s.done} of ${s.total} checklist steps done.`} />
            ) : (
              <StatusChip label={`Board report due ${formatDateTime(boardDue)}`} tone="warning" meaning="The detailed report to the Data Protection Board is due within the time the DPDP Rules set; the firm works to 72 hours from becoming aware of the breach." />
            )
          ) : (
            <StatusChip label="Closed" tone="success" meaning={`Closed ${formatDateTime(row.closed_at)}: every step of the breach checklist done.`} />
          )}
          {canEdit && open ? (
            <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      <p className="px-4 pb-3 text-sm whitespace-pre-line text-text md:px-5">{row.description}</p>
      <div className="grid grid-cols-1 gap-4 border-t border-border px-4 py-4 md:px-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ol className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label="Breach checklist">
          {INCIDENT_STEPS.map((step) => {
            const isDone = done[step]
            const when = step === "contain" ? row.contained_at : step === "assess" ? row.assessed_at : step === "notify_board" ? row.board_notified_at : step === "notify_people" ? row.principals_notified_at : null
            const text = step === "assess" ? row.assessment : step === "notify_board" ? row.board_reference : step === "root_cause" ? row.root_cause : null
            return (
              <li key={step} className="flex items-start gap-3 px-3 py-2.5">
                <span aria-hidden="true" className={cn("mt-0.5 inline-flex size-4 flex-none items-center justify-center rounded-full", isDone ? "bg-success-soft text-success-text" : "ring-[1.5px] ring-inset ring-text-muted")}>
                  {isDone ? <CheckIcon className="size-3" /> : null}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">
                    {INCIDENT_STEP_LABELS[step]}
                    <span className="sr-only">{isDone ? " (done)" : " (to do)"}</span>
                  </p>
                  {isDone ? (
                    <p className="text-xs text-text-muted">
                      {when ? formatDateTime(when) : "Recorded"}
                      {text ? <span className="mt-0.5 block text-sm whitespace-pre-line text-text">{text}</span> : null}
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted">{INCIDENT_STEP_HINTS[step]}</p>
                  )}
                </div>
                {canEdit && open ? (
                  <Button type="button" variant={isDone ? "ghost" : "outline"} size="sm" onClick={() => onStep(step)}>
                    {isDone ? "Change" : "Record"}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ol>
        <ActionLog row={row} canEdit={canEdit} />
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 md:px-5">
          <p className="text-sm text-text-muted">{open ? (s.remaining.length ? `${s.remaining.length} of ${s.total} steps left before it can close.` : "Every step is done: close the incident.") : "Reopen it if something else comes to light."}</p>
          <Button type="button" variant={open ? "default" : "outline"} size="sm" disabled={open && s.remaining.length > 0} onClick={() => setClosing(open ? "close" : "reopen")}>
            {open ? "Close incident" : "Reopen"}
          </Button>
        </div>
      ) : null}
      {closing ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? setClosing(null) : undefined)}
          title={closing === "close" ? "Close this incident?" : "Reopen this incident?"}
          description={closing === "close" ? "It is contained, assessed, the Board and the people affected are told, and the root cause is recorded." : "The checklist opens again for changes."}
          confirmLabel={closing === "close" ? "Close incident" : "Reopen"}
          onConfirm={async () => {
            const r = await closeIncident({ id: row.id ?? "", updatedAt: row.updated_at ?? "", reopen: closing === "reopen" })
            if (!toastResult(r, closing === "close" ? "Incident closed" : "Incident reopened")) return false
            setClosing(null)
            router.refresh()
          }}
        />
      ) : null}
    </section>
  )
}

/**
 * Personal data breaches (§6.10): each incident with the breach checklist (contain; assess; notify
 * the Data Protection Board and the people affected; record the root cause), the Board's report
 * deadline, and a log of everything done. Open ones first. Partners record and work them (RLS
 * 0039); Managers read.
 */
export function Incidents({ rows, canEdit, focusId }: { rows: IncidentRow[]; canEdit: boolean; focusId: string | null }) {
  const [editing, setEditing] = React.useState<IncidentRow | "new" | null>(null)
  const [step, setStep] = React.useState<{ row: IncidentRow; step: IncidentStep } | null>(null)
  const [now] = React.useState(() => new Date())
  React.useEffect(() => {
    if (focusId) document.getElementById(`incident-${focusId}`)?.scrollIntoView({ block: "start" })
  }, [focusId])
  const sorted = rows.slice().sort((a, b) => Number(Boolean(a.closed_at)) - Number(Boolean(b.closed_at)) || ((b.detected_at ?? "") > (a.detected_at ?? "") ? 1 : -1))
  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            Record an incident
          </Button>
        </div>
      ) : null}
      {sorted.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState icon={<ShieldAlertIcon />} message="No personal data breach recorded. If one happens, record it at once: the Board's report runs from when the firm became aware." />
        </div>
      ) : (
        sorted.map((r) => <IncidentCard key={r.id} row={r} canEdit={canEdit} now={now} onEdit={() => setEditing(r)} onStep={(s) => setStep({ row: r, step: s })} />)
      )}
      {editing ? <IncidentDialog onClose={() => setEditing(null)} row={editing === "new" ? null : editing} /> : null}
      {step ? <StepDialog onClose={() => setStep(null)} row={step.row} step={step.step} /> : null}
    </div>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController } from "react-hook-form"
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, CircleSlashIcon, FileCheck2Icon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { NativeSelectField } from "@/components/tasks/native-select-field"
import { StatusChip } from "@/components/app/status-chip"
import { DocumentUploader } from "@/components/documents/uploader"
import { useActionForm } from "@/hooks/use-action-form"
import { getStatus } from "@/lib/status"
import { formatDate } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import type { ServiceType, TaskStatus } from "@/lib/domain/enums"
import { TASK_STATUS_NAMES, isReopen, isSendBack, type NextStatusOption } from "@/lib/domain/transitions"
import { FileTaskSchema, needsFilingCapture } from "@/lib/schemas/tasks"
import { fyChoices } from "@/lib/schemas/documents"
import { changeTaskStatus, fileTask, getFilingContext, type FilingContext } from "@/server/actions/tasks"

/**
 * Moving a task (§7.6.4, §7.6.5): the status chip with its allowed next moves, the reason dialog
 * (sending back, reopening, putting On hold), and the filing capture on Filed/Done for filing
 * work. Every move goes through change_task_status (or file_task) on the server, which applies the
 * same rules again; the menu only shows what lib/domain/transitions.ts allows, with the reason a
 * move is refused shown on the disabled item.
 */

export type MovableTask = {
  id: string
  task_number: string
  title: string
  status: TaskStatus
  service_type: ServiceType | null
  compliance_event_id: string | null
  updated_at: string
}

type Pending = { task: MovableTask; to: TaskStatus } | null

/** Opens the right dialog for a move, or makes it straight away. Render `dialogs` once. */
export function useTaskMover({ onMoved }: { onMoved?: (task: MovableTask, to: TaskStatus) => void } = {}) {
  const router = useRouter()
  const [reasonFor, setReasonFor] = React.useState<Pending>(null)
  const [filingFor, setFilingFor] = React.useState<MovableTask | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const done = React.useCallback(
    (task: MovableTask, to: TaskStatus) => {
      onMoved?.(task, to)
      router.refresh()
    },
    [onMoved, router],
  )

  const move = React.useCallback(
    async (task: MovableTask, to: TaskStatus, requiresReason: boolean) => {
      if (to === "filed_done" && needsFilingCapture(task)) {
        setFilingFor(task)
        return
      }
      if (requiresReason) {
        setReasonFor({ task, to })
        return
      }
      setBusy(task.id)
      try {
        const r = await changeTaskStatus({ id: task.id, to })
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        toast.success(`${task.task_number} moved to ${TASK_STATUS_NAMES[to]}.`)
        done(task, to)
      } catch {
        toast.error("The change didn't reach the server. Check your connection and try again.")
      } finally {
        setBusy(null)
      }
    },
    [done],
  )

  const dialogs = (
    <>
      {reasonFor ? (
        <ReasonDialog
          key={`${reasonFor.task.id}-${reasonFor.to}`}
          task={reasonFor.task}
          to={reasonFor.to}
          onClose={() => setReasonFor(null)}
          onMoved={() => {
            const p = reasonFor
            setReasonFor(null)
            done(p.task, p.to)
          }}
        />
      ) : null}
      {filingFor ? (
        <FilingDialog
          key={filingFor.id}
          task={filingFor}
          onClose={() => setFilingFor(null)}
          onFiled={() => {
            const t = filingFor
            setFilingFor(null)
            done(t, "filed_done")
          }}
        />
      ) : null}
    </>
  )
  return { move, dialogs, busy }
}

/**
 * The status chip with "Change status": allowed moves first, then refused ones (disabled, with why).
 */
export function StatusMenu({ task, options, size = "sm", align = "start" }: { task: MovableTask; options: NextStatusOption[]; size?: "sm" | "default"; align?: "start" | "end" }) {
  const mover = useTaskMover()
  const allowed = options.filter((o) => o.allowed)
  const refused = options.filter((o) => !o.allowed)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip kind="task_status" value={task.status} variant="pill" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size={size} disabled={mover.busy === task.id} aria-busy={mover.busy === task.id}>
              {mover.busy === task.id ? <Spinner /> : null}
              Change status
              <ChevronDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align} className="w-72">
            <DropdownMenuLabel className="text-xs font-medium text-text-muted">Move to</DropdownMenuLabel>
            {allowed.length === 0 ? <p className="px-2 py-1.5 text-sm text-text-muted">No moves are open to you right now.</p> : null}
            {allowed.map((o) => (
              <DropdownMenuItem key={o.status} onSelect={() => void mover.move(task, o.status, o.requiresReason)}>
                <ArrowRightIcon aria-hidden="true" className="text-text-muted" />
                <span className="flex-1">{getStatus("task_status", o.status).label}</span>
                {o.status === "filed_done" && needsFilingCapture(task) ? <span className="text-xs text-text-muted">with filing</span> : o.requiresReason ? <span className="text-xs text-text-muted">reason</span> : null}
              </DropdownMenuItem>
            ))}
            {refused.length ? <DropdownMenuSeparator /> : null}
            {refused.map((o) => (
              <DropdownMenuItem key={o.status} disabled className="flex-col items-start gap-0.5 opacity-100 data-[disabled]:opacity-100">
                <span className="flex items-center gap-2 text-text-muted">
                  <CircleSlashIcon aria-hidden="true" className="size-3.5" />
                  {getStatus("task_status", o.status).label}
                </span>
                {o.error ? <span className="pl-5.5 text-xs text-text-muted">{o.error}</span> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {mover.dialogs}
    </>
  )
}

// -------------------------------------------------------------------------------------------------
// Reason (§7.6.4: sending back, reopening, putting On hold)
// -------------------------------------------------------------------------------------------------

function reasonCopy(from: TaskStatus, to: TaskStatus): { title: string; description: string; label: string; submit: string } {
  if (isSendBack(from, to)) {
    return { title: "Send back to the preparer", description: "The assignee sees your reason and the task returns to In progress.", label: "What needs changing", submit: "Send back" }
  }
  if (isReopen(from, to)) {
    return { title: `Reopen to ${TASK_STATUS_NAMES[to]}`, description: "Reopening clears the completion date and re-arms escalation.", label: "Why it's being reopened", submit: "Reopen" }
  }
  return { title: "Put on hold", description: "The task pauses until someone moves it back to In progress.", label: "Why it's on hold", submit: "Put on hold" }
}

export function ReasonDialog({ task, to, onClose, onMoved }: { task: MovableTask; to: TaskStatus; onClose: () => void; onMoved: () => void }) {
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [pending, setPending] = React.useState(false)
  const copy = reasonCopy(task.status, to)
  const id = React.useId()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      setError({ message: "Give a reason. It is kept in the task's history." })
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await changeTaskStatus({ id: task.id, to, reason })
      if (!r.ok) {
        setError({ message: r.fieldErrors?.reason?.[0] ?? r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`${task.task_number} moved to ${TASK_STATUS_NAMES[to]}.`)
      onMoved()
    } catch {
      setError({ message: "The change didn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={copy.title}
      description={`${task.task_number} · ${task.title}`}
      onSubmit={submit}
      pending={pending}
      dirty={reason.trim().length > 0}
      submitLabel={copy.submit}
    >
      <FormAlert error={error} />
      <p className="mb-3 text-sm text-text-muted">{copy.description}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>
          {copy.label} <span className="text-danger-text">*</span>
        </Label>
        <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={500} aria-required="true" aria-invalid={Boolean(error) || undefined} autoFocus />
        <p className="num text-xs text-text-muted tabular-nums">{reason.length}/500</p>
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Filing capture (§7.6.5)
// -------------------------------------------------------------------------------------------------

export function FilingDialog({ task, onClose, onFiled }: { task: MovableTask; onClose: () => void; onFiled: () => void }) {
  const [ctx, setCtx] = React.useState<FilingContext | null>(null)
  const [loadError, setLoadError] = React.useState<{ message: string; ref?: string } | null>(null)
  React.useEffect(() => {
    let live = true
    getFilingContext({ id: task.id })
      .then((r) => {
        if (!live) return
        if (r.ok) setCtx(r.data)
        else setLoadError({ message: r.error, ref: r.ref })
      })
      .catch(() => live && setLoadError({ message: "Couldn't load the filing details. Check your connection and try again." }))
    return () => {
      live = false
    }
  }, [task.id])

  if (!ctx) {
    return (
      <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title="Record the filing" description={`${task.task_number} · ${task.title}`} submitDisabled>
        {loadError ? <FormAlert error={loadError} /> : <div className="flex items-center gap-2 py-6 text-sm text-text-muted"><Spinner /> Loading the deadline and earlier filings…</div>}
      </FormDialog>
    )
  }
  return <FilingForm ctx={ctx} onClose={onClose} onFiled={onFiled} />
}

function FilingForm({ ctx, onClose, onFiled }: { ctx: FilingContext; onClose: () => void; onFiled: () => void }) {
  const today = todayIST()
  const f = useActionForm(FileTaskSchema, fileTask, {
    defaultValues: {
      id: ctx.task.id,
      expected_updated_at: ctx.task.updated_at,
      mode: "record",
      filing_type: ctx.defaults.filing_type,
      period: ctx.defaults.period,
      financial_year: ctx.defaults.financial_year,
      filed_on: ctx.defaults.filed_on,
      acknowledgement_no: "",
      document_id: "",
      udin_record_id: "",
      shareable_with_client: true,
      notes: "",
      filing_record_id: ctx.filings[0]?.id ?? "",
      skip_reason: "",
    },
    successMessage: `${ctx.task.task_number} filed.`,
    onSuccess: () => onFiled(),
  })
  const mode = useController({ control: f.control, name: "mode" })
  const doc = useController({ control: f.control, name: "document_id" })
  const fyOpts = fyChoices(today).map((fy) => ({ value: fy, label: fy }))
  const modeId = React.useId()

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="lg"
      title="Record the filing"
      description={`${ctx.task.task_number} · ${ctx.task.title}${ctx.task.client_name ? ` · ${ctx.task.client_name}` : ""}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={mode.field.value === "skip" ? "Set Filed/Done" : "Record and file"}
    >
      <FormAlert state={f} />
      {ctx.event ? (
        <p className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text">
          <FileCheck2Icon aria-hidden="true" className="mr-1.5 inline size-4 align-[-3px] text-text-muted" />
          This marks the deadline <span className="font-medium">{ctx.event.title}</span> (due {formatDate(ctx.event.due_date)}) as Filed.
        </p>
      ) : null}

      <fieldset className="mb-5">
        <legend className="mb-2 text-sm font-medium text-text">What happened</legend>
        <RadioGroup value={mode.field.value} onValueChange={(v) => mode.field.onChange(v)} className="gap-2" aria-labelledby={modeId}>
          <ModeOption value="record" title="It was filed" hint="Record the return, period, date and acknowledgement." />
          {ctx.filings.length ? <ModeOption value="existing" title="Use the filing already recorded" hint={`${ctx.filings.length === 1 ? "One filing is" : `${ctx.filings.length} filings are`} already recorded for this work.`} /> : null}
          <ModeOption value="skip" title="Nothing was filed" hint="For work that ends without a return. Say why; it is kept on the task." />
        </RadioGroup>
      </fieldset>

      {mode.field.value === "record" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={f.control} name="filing_type" label="Return / form" required helper="As on the acknowledgement, e.g. GSTR-3B, ITR-6, 24Q, AOC-4." />
          <TextField control={f.control} name="period" label="Period" required helper="Sep 2026, Q2 2026-27 or 2025-26." />
          <SelectField control={f.control} name="financial_year" label="Financial year" required options={fyOpts} />
          <DateField control={f.control} name="filed_on" label="Filed on" required max={today} />
          <TextField control={f.control} name="acknowledgement_no" label="Acknowledgement / ARN / SRN no." className="md:col-span-2" autoComplete="off" />
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-sm font-medium text-text">Acknowledgement PDF</span>
            {doc.field.value ? (
              <p className="flex items-center gap-2 text-sm text-success-text">
                <CheckIcon aria-hidden="true" className="size-4" />
                Uploaded to the client&apos;s documents (Acknowledgements).
                <Button type="button" variant="link" size="sm" onClick={() => doc.field.onChange("")}>
                  Use another file
                </Button>
              </p>
            ) : (
              <DocumentUploader
                clientId={ctx.task.client_id}
                purpose="new_document"
                single
                fields="none"
                buttonLabel="Upload acknowledgement"
                dropzoneLabel="Drop the acknowledgement PDF here"
                defaults={{ title: `${f.form.getValues("filing_type") || "Return"} acknowledgement ${f.form.getValues("period") || ""}`.trim(), category: "acknowledgements", financialYear: f.form.getValues("financial_year") ?? "", period: f.form.getValues("period") ?? "" }}
                onUploaded={(done) => {
                  const first = done[0]
                  if (first) doc.field.onChange(first.documentId)
                }}
              />
            )}
          </div>
          {ctx.udins.length ? (
            <NativeSelectField
              control={f.control}
              name="udin_record_id"
              label="Link a UDIN"
              helper="If a certificate or report was signed for this filing."
              options={[{ value: "", label: "No UDIN" }, ...ctx.udins.map((u) => ({ value: u.id, label: `${u.udin} · ${u.document_type} · ${formatDate(u.document_date)}` }))]}
              className="md:col-span-2"
            />
          ) : (
            <p className="text-sm text-text-muted md:col-span-2">No unlinked UDINs for this client. If a report was signed, log its UDIN in Registers → UDIN, then link it from the filing.</p>
          )}
          <SwitchField control={f.control} name="shareable_with_client" label="Show the acknowledgement in the client's portal" description="The client can download it from Compliance." className="md:col-span-2" />
          <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
        </div>
      ) : mode.field.value === "existing" ? (
        <SelectField
          control={f.control}
          name="filing_record_id"
          label="Filing already recorded"
          required
          options={ctx.filings.map((r) => ({ value: r.id, label: [r.filing_type, r.period, r.filed_on ? formatDate(r.filed_on) : null, r.acknowledgement_no].filter(Boolean).join(" · ") }))}
        />
      ) : (
        <TextareaField control={f.control} name="skip_reason" label="Why there's nothing to file" required rows={3} helper="For example: the client filed it themselves, or this was advisory work." />
      )}
    </FormDialog>
  )
}

function ModeOption({ value, title, hint }: { value: string; title: string; hint: string }) {
  const id = React.useId()
  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 transition-colors duration-150 hover:bg-surface-2 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary-soft")}>
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-base font-medium text-text">{title}</span>
        <span className="block text-sm text-text-muted">{hint}</span>
      </span>
    </label>
  )
}

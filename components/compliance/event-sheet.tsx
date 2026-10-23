"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  BanIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileCheckIcon,
  FileTextIcon,
  InfoIcon,
  ListChecksIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { DefinitionList } from "@/components/app/definition-list"
import { MonoId } from "@/components/app/mono-id"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { formatDate, formatDateTime } from "@/lib/format"
import { COMPLIANCE_TYPE_LABELS, type ComplianceWorkflow } from "@/lib/domain/enums"
import { reminderDate } from "@/lib/domain/statutory-calendar"
import type { AppRole } from "@/lib/auth/roles"
import type { EventDetail } from "@/lib/data/compliance"
import { cancelComplianceEvent, changeComplianceWorkflow, createTaskForEvent, updateComplianceNotes } from "@/server/actions/compliance"
import { fileHref } from "@/components/documents/doc-urls"
import { circularUrl, displayChip, eventDisplayStatus, isDone, WORKFLOW_ORDER, type EventHint, type WorkflowMove } from "@/components/compliance/logic/event"
import { displayLabel } from "@/components/compliance/status-mark"
import { FilingDialog } from "@/components/compliance/filing-dialog"
import { EventForm } from "@/components/compliance/event-form"

/**
 * One deadline (§7.7 "Click a cell to open the event: its task, its filing record, and its
 * acknowledgement"), in a side sheet opened by `?event=<id>` on the filings grid, the calendar and
 * Client 360 → Compliance, so a notification can link straight to it. It shows the status and the
 * moves the viewer may make, the hints (Sunday, GSTR-1A / IMS, the three-year bar, ROC late fee,
 * an extension with its circular), the filing records with their acknowledgement and UDIN, the
 * linked task, notes, and the deadline's history (extensions and re-planned dates included).
 */

export interface EventSheetProps {
  detail: EventDetail | null
  /** The load failed: shown inside the sheet with its Ref. */
  errorRef?: string | null
  hints: EventHint[]
  moves: WorkflowMove[]
  role: AppRole
  today: string
  /** Where closing the sheet goes (the same page without `event`). */
  closeHref: string
  fyOptions: string[]
  reminderDays: number
}

const SOURCE_LABEL: Record<string, string> = { statutory_engine: "Statutory calendar", ops_template: "Ops template", manual: "Added by hand" }

const HINT_ICON = { danger: ShieldAlertIcon, warning: TriangleAlertIcon, info: InfoIcon, neutral: InfoIcon } as const
const HINT_TONE = { danger: "text-danger-text", warning: "text-warning-text", info: "text-info-text", neutral: "text-text-muted" } as const

export function EventSheet(props: EventSheetProps) {
  const router = useRouter()
  const [open, setOpen] = React.useState(true)
  const close = (next: boolean) => {
    setOpen(next)
    if (!next) router.replace(props.closeHref, { scroll: false })
  }
  const { detail } = props

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden p-0 sm:w-[min(100%,34rem)]"
        aria-describedby={undefined}
        onOpenAutoFocus={(ev) => {
          // Land on the title, not the first chip (its explanation would pop open).
          ev.preventDefault()
          document.getElementById("event-sheet-title")?.focus()
        }}
      >
        {detail ? (
          <EventBody {...props} detail={detail} />
        ) : (
          <>
            <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
              <SheetTitle id="event-sheet-title" tabIndex={-1} className="outline-none">
                Deadline
              </SheetTitle>
            </SheetHeader>
            {props.errorRef ? (
              <ErrorBlock message="Couldn't load this deadline." errorRef={props.errorRef} />
            ) : (
              <EmptyState message="This deadline no longer exists, or it isn't one of your clients'." />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function EventBody({ detail, hints, moves, role, today, fyOptions, reminderDays }: EventSheetProps & { detail: EventDetail }) {
  const router = useRouter()
  const e = detail.event
  const manager = role === "partner" || role === "manager"
  const display = eventDisplayStatus(e, today)
  const chip = displayChip(display)
  const done = isDone(e)
  const [filing, setFiling] = React.useState<null | { complete: boolean }>(null)
  const [editing, setEditing] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [reopenTo, setReopenTo] = React.useState<ComplianceWorkflow | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string; ref?: string; warnings?: string[] }>, success: string) => {
    setBusy(label)
    try {
      const r = await fn()
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : (r.error ?? "That didn't go through."))
        return false
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(success)
      router.refresh()
      return true
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
      return false
    } finally {
      setBusy(null)
    }
  }

  const move = (m: WorkflowMove) => {
    if (m.needsFiling) return setFiling({ complete: m.to === "completed" })
    if (m.needsReason) {
      setReason("")
      return setReopenTo(m.to)
    }
    void run(m.to, () => changeComplianceWorkflow({ eventId: e.id, to: m.to, expectedUpdatedAt: e.updated_at }), `Moved to ${displayLabel(m.to)}.`)
  }

  // The next step forward is the one filled button; the rest sit in "Move to".
  const currentIndex = WORKFLOW_ORDER.indexOf(e.workflow_status)
  const forward = moves.find((m) => WORKFLOW_ORDER.indexOf(m.to) === currentIndex + 1 && !m.reopen) ?? null
  const others = moves.filter((m) => m !== forward)

  const extendedRef = detail.override?.source_ref ?? null
  const circular = circularUrl(extendedRef)
  const remindOn = reminderDate(e.due_date, e.reminder_days)

  const facts = [
    {
      term: "Due",
      value: (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <DateText date={e.due_date} withRelative={!done && e.status !== "cancelled"} today={today} />
          {e.original_due_date && e.original_due_date !== e.due_date ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-info/25 bg-info-soft px-2 text-xs leading-5 font-medium text-info-text">
              Extended
              {circular ? (
                <a href={circular} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                  · circular <ExternalLinkIcon aria-hidden="true" className="size-3" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : role === "partner" && extendedRef ? (
                <Link href={`/settings/law?tab=extensions&q=${encodeURIComponent(e.rule_code ?? extendedRef)}`} className="underline-offset-2 hover:underline">
                  · {extendedRef}
                </Link>
              ) : extendedRef ? (
                <span className="font-normal">· {extendedRef}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      ),
    },
    ...(e.original_due_date && e.original_due_date !== e.due_date
      ? [{ term: "Statutory date", value: `${formatDate(e.original_due_date)}${extendedRef ? `, extended by ${extendedRef}` : ""}` }]
      : []),
    { term: "Period", value: e.filing_period },
    { term: "Financial year", value: e.financial_year },
    { term: "Type", value: e.form_code && e.form_code !== COMPLIANCE_TYPE_LABELS[e.type] ? `${COMPLIANCE_TYPE_LABELS[e.type]} · ${e.form_code}` : COMPLIANCE_TYPE_LABELS[e.type] },
    { term: "Planned by", value: SOURCE_LABEL[e.source] ?? e.source },
    ...(detail.rule?.source_ref || e.source_ref ? [{ term: "Legal source", value: detail.rule?.source_ref ?? e.source_ref, wide: true }] : []),
    { term: "Reminder", value: `${e.reminder_days} ${e.reminder_days === 1 ? "day" : "days"} before (${formatDate(remindOn)})` },
    ...(e.type === "roc" && e.agm_date ? [{ term: "AGM held on", value: formatDate(e.agm_date) }] : []),
    ...(e.status === "cancelled" ? [{ term: "Status", value: "Cancelled" }] : []),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="flex-none gap-2 border-b border-border px-5 pt-5 pb-4 pr-12">
        <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          {detail.client ? (
            <Link href={`/clients/${detail.client.id}?tab=compliance`} className="inline-flex min-w-0 items-center gap-1.5 hover:text-text hover:underline">
              <MonoId value={detail.client.client_code} />
              <span className="truncate">{detail.client.display_name}</span>
            </Link>
          ) : (
            <span>Firm-level deadline</span>
          )}
        </div>
        <SheetTitle id="event-sheet-title" tabIndex={-1} className="text-md leading-6 outline-none">
          {e.title}
        </SheetTitle>
        <SheetDescription className="sr-only">Deadline details, filing and history</SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip kind={chip.kind} value={chip.value} variant="pill" />
          {display === "overdue" ? <StatusChip kind="compliance_workflow" value={e.workflow_status} /> : null}
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {hints.length > 0 ? (
          <ul className="mb-4 flex flex-col gap-2" aria-label="Things to know">
            {hints.map((h, i) => {
              const Icon = HINT_ICON[h.tone]
              return (
                <li key={`${h.kind}-${i}`} className={cn("flex gap-2 text-sm leading-5", h.tone === "danger" ? "font-medium text-danger-text" : "text-text")}>
                  <Icon aria-hidden="true" className={cn("mt-0.5 size-4 flex-none", HINT_TONE[h.tone])} />
                  <span>{h.text}</span>
                </li>
              )
            })}
          </ul>
        ) : null}

        <Stepper current={e.workflow_status} cancelled={e.status === "cancelled"} />

        {moves.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {forward ? (
              <Button size="sm" onClick={() => move(forward)} disabled={busy !== null} aria-busy={busy === forward.to}>
                {busy === forward.to ? <Spinner /> : forward.needsFiling ? <FileCheckIcon aria-hidden="true" /> : null}
                {forward.needsFiling ? "Record filing" : `Move to ${displayLabel(forward.to)}`}
              </Button>
            ) : null}
            {others.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy !== null}>
                    Move to
                    <ChevronDownIcon aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel className="text-xs text-text-muted">Progress</DropdownMenuLabel>
                  {others.map((m) => (
                    <DropdownMenuItem key={m.to} onSelect={() => move(m)}>
                      {m.reopen ? `Reopen as ${displayLabel(m.to)}` : m.needsFiling ? `${displayLabel(m.to)} (record the filing)` : displayLabel(m.to)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : role === "employee" && done ? (
          <p className="mt-3 text-sm text-text-muted">Filed. A Partner or Manager can reopen it if the figures change.</p>
        ) : null}

        <section aria-labelledby="ev-facts" className="mt-5">
          <h3 id="ev-facts" className="sr-only">
            Facts
          </h3>
          <DefinitionList items={facts} />
        </section>

        <FilingSection detail={detail} manager={manager} onRecord={() => setFiling({ complete: false })} />

        <TaskSection detail={detail} manager={manager} busy={busy === "task"} onCreate={() => void run("task", () => createTaskForEvent({ eventId: e.id }), "Task created.")} />

        <NotesSection key={e.updated_at} eventId={e.id} notes={e.notes} updatedAt={e.updated_at} />

        {e.description ? (
          <section className="mt-5">
            <h3 className="text-sm font-medium text-text">About this deadline</h3>
            <p className="mt-1 text-sm whitespace-pre-line text-text-muted">{e.description}</p>
          </section>
        ) : null}

        <section aria-labelledby="ev-history" className="mt-5">
          <h3 id="ev-history" className="text-sm font-medium text-text">
            History
          </h3>
          {detail.history.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">No changes yet.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2">
              {detail.history.map((h) => (
                <li key={h.id} className="text-sm leading-5">
                  <span className="text-text">{h.description}</span>
                  <span className="block text-xs text-text-muted">
                    {h.user_name ? `${h.user_name} · ` : ""}
                    {formatDateTime(h.at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {manager ? (
        <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={e.status === "cancelled"}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
          {e.status === "cancelled" ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("restore", () => cancelComplianceEvent({ eventId: e.id, restore: true, expectedUpdatedAt: e.updated_at }), "Deadline restored.")}>
              <RotateCcwIcon aria-hidden="true" />
              Restore
            </Button>
          ) : !done ? (
            <Button size="sm" variant="destructive-outline" onClick={() => setCancelling(true)}>
              <BanIcon aria-hidden="true" />
              Cancel deadline
            </Button>
          ) : null}
        </div>
      ) : null}

      {filing ? <FilingDialog open onOpenChange={(o) => !o && setFiling(null)} detail={detail} today={today} complete={filing.complete} /> : null}
      {editing ? (
        <EventForm
          open
          onOpenChange={setEditing}
          event={e}
          fixedClient={detail.client ? { id: detail.client.id, name: detail.client.display_name, code: detail.client.client_code } : null}
          fyOptions={fyOptions.includes(e.financial_year ?? "") || !e.financial_year ? fyOptions : [e.financial_year, ...fyOptions]}
          defaultFy={e.financial_year ?? fyOptions[0]}
          reminderDays={reminderDays}
        />
      ) : null}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this deadline?"
        description="It leaves the calendar, the filings grid and the client's portal, and no reminder goes out. The record stays, and you can restore it."
        details={
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cancel-reason" className="text-sm font-medium text-text">
              Why is it no longer needed? <span className="text-danger-text">*</span>
            </label>
            <Textarea id="cancel-reason" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="GST registration cancelled from 1 Oct 2026" />
          </div>
        }
        confirmLabel="Cancel deadline"
        destructive
        onConfirm={async () => {
          if (!reason.trim()) {
            toast.error("Say why it is no longer needed.")
            return false
          }
          return run("cancel", () => cancelComplianceEvent({ eventId: e.id, reason, expectedUpdatedAt: e.updated_at }), "Deadline cancelled.")
        }}
      />
      <ConfirmDialog
        open={reopenTo !== null}
        onOpenChange={(o) => !o && setReopenTo(null)}
        title="Reopen this deadline?"
        description={reopenTo ? `It moves back to ${displayLabel(reopenTo)}. The filing record stays on file.` : ""}
        details={
          <div className="flex flex-col gap-1.5">
            <label htmlFor="reopen-reason" className="text-sm font-medium text-text">
              Reason <span className="text-danger-text">*</span>
            </label>
            <Textarea id="reopen-reason" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Client sent corrected purchase figures" />
          </div>
        }
        confirmLabel="Reopen"
        onConfirm={async () => {
          if (!reopenTo) return
          if (!reason.trim()) {
            toast.error("Say why you are reopening it.")
            return false
          }
          return run(reopenTo, () => changeComplianceWorkflow({ eventId: e.id, to: reopenTo, reason, expectedUpdatedAt: e.updated_at }), "Deadline reopened.")
        }}
      />
    </div>
  )
}

function Stepper({ current, cancelled }: { current: ComplianceWorkflow; cancelled: boolean }) {
  const at = WORKFLOW_ORDER.indexOf(current)
  return (
    <div>
      <ol aria-label="Progress" className="grid grid-cols-6 gap-1">
        {WORKFLOW_ORDER.map((w, i) => {
          const reached = i <= at
          return (
            <li key={w} className="min-w-0" aria-current={i === at ? "step" : undefined}>
              <span aria-hidden="true" className={cn("block h-1 rounded-full", cancelled ? "bg-border" : reached ? (i >= 4 ? "bg-success" : "bg-primary") : "bg-border")} />
              <span className={cn("mt-1 hidden truncate text-xs sm:block", i === at ? "font-medium text-text" : "text-text-muted")}>{displayLabel(w, true)}</span>
              <span className="sr-only sm:hidden">{displayLabel(w)}</span>
            </li>
          )
        })}
      </ol>
      <p className="mt-1 text-xs text-text-muted sm:hidden">
        Step {at + 1} of {WORKFLOW_ORDER.length}: <span className="font-medium text-text">{displayLabel(current)}</span>
      </p>
    </div>
  )
}

function FilingSection({ detail, manager, onRecord }: { detail: EventDetail; manager: boolean; onRecord: () => void }) {
  const e = detail.event
  return (
    <section aria-labelledby="ev-filing" className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <h3 id="ev-filing" className="text-sm font-medium text-text">
          Filing and acknowledgement
        </h3>
        {manager && detail.client && e.status !== "cancelled" && detail.filings.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={onRecord}>
            <PlusIcon aria-hidden="true" />
            Add a filing
          </Button>
        ) : null}
      </div>
      {detail.filings.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            size="compact"
            icon={<FileTextIcon />}
            message={e.is_statutory && detail.client ? "Not filed yet." : "No filing record for this step."}
            action={
              manager && detail.client && e.status !== "cancelled" ? (
                <Button size="xs" variant="outline" onClick={onRecord}>
                  Record filing
                </Button>
              ) : null
            }
          />
        </div>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border rounded-md border border-border">
          {detail.filings.map((f) => (
            <li key={f.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium text-text">
                  {f.filing_type}
                  {f.period ? ` · ${f.period}` : ""}
                </span>
                <span className="num text-text-muted tabular-nums">{f.filed_on ? `Filed ${formatDate(f.filed_on)}` : "Filed (date not recorded)"}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-muted">
                {f.acknowledgement_no ? (
                  <span className="inline-flex items-center gap-1">
                    Ack <MonoId value={f.acknowledgement_no} copy label="acknowledgement number" />
                  </span>
                ) : (
                  <span>No acknowledgement number</span>
                )}
                {f.document ? (
                  <a href={fileHref(f.document.id, { mode: "preview" })} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">
                    <FileTextIcon aria-hidden="true" className="size-3.5" />
                    {f.document.title}
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : detail.client ? (
                  <Link href={`/clients/${detail.client.id}?tab=documents`} className="text-primary hover:underline">
                    Add the PDF on Documents
                  </Link>
                ) : null}
                {f.udins.map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-1">
                    UDIN <MonoId value={u.udin} copy label="UDIN" />
                  </span>
                ))}
              </div>
              <p className="text-xs text-text-muted">
                {f.filed_by_external ? `Filed by ${f.filed_by_external}` : f.created_by_name ? `Recorded by ${f.created_by_name}` : "Recorded"}
                {f.shareable_with_client ? " · shown in the client portal" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TaskSection({ detail, manager, busy, onCreate }: { detail: EventDetail; manager: boolean; busy: boolean; onCreate: () => void }) {
  const t = detail.task
  return (
    <section aria-labelledby="ev-task" className="mt-5">
      <h3 id="ev-task" className="text-sm font-medium text-text">
        Task
      </h3>
      {t ? (
        <Link href={`/work/${t.id}`} className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm hover:border-text-muted/40">
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <MonoId value={t.task_number} />
              <span className="truncate text-text">{t.title}</span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">{t.assignee_name ? `Assigned to ${t.assignee_name}` : "Unassigned"}</span>
          </span>
          <StatusChip kind="task_status" value={t.status} />
        </Link>
      ) : (
        <div className="mt-2">
          <EmptyState
            size="compact"
            icon={<ListChecksIcon />}
            message="No task is linked."
            action={
              manager && detail.client && detail.event.status !== "cancelled" ? (
                <Button size="xs" variant="outline" onClick={onCreate} disabled={busy} aria-busy={busy}>
                  {busy ? <Spinner /> : null}
                  Create task
                </Button>
              ) : null
            }
          />
        </div>
      )}
    </section>
  )
}

function NotesSection({ eventId, notes, updatedAt }: { eventId: string; notes: string | null; updatedAt: string }) {
  const router = useRouter()
  const [value, setValue] = React.useState(notes ?? "")
  const [saving, setSaving] = React.useState(false)
  const dirty = value.trim() !== (notes ?? "").trim()
  const save = async () => {
    setSaving(true)
    try {
      const r = await updateComplianceNotes({ eventId, notes: value, expectedUpdatedAt: updatedAt })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      toast.success("Notes saved")
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <section aria-labelledby="ev-notes" className="mt-5">
      <label id="ev-notes" htmlFor="ev-notes-input" className="text-sm font-medium text-text">
        Notes
      </label>
      <Textarea id="ev-notes-input" rows={3} className="mt-1.5" value={value} onChange={(ev) => setValue(ev.target.value)} placeholder="What's pending from the client, who is filing, anything to remember" />
      {dirty ? (
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setValue(notes ?? "")} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving} aria-busy={saving}>
            {saving ? <Spinner /> : null}
            Save notes
          </Button>
        </div>
      ) : null}
    </section>
  )
}

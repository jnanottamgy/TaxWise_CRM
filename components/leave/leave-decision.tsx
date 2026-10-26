"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckIcon, UsersRoundIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ErrorBlock } from "@/components/app/error-block"
import { DateText } from "@/components/app/date-text"
import { StatusChip } from "@/components/app/status-chip"
import type { AppRole } from "@/lib/auth/roles"
import { formatLeaveRange } from "@/lib/domain/leave"
import type { LeaveRow } from "@/lib/data/leave"
import type { PersonOption } from "@/lib/data/people"
import { coverWindowText } from "@/lib/schemas/covers"
import { decideLeave, loadLeaveCoverContext, reassignLeaveTasks, recordNoCoverNeeded, type LeaveCoverContext } from "@/server/actions/leave"
import { CoverDialog } from "@/components/covers/cover-dialog"

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name
}

/**
 * Approve / Decline a leave request (§7.11.3), with an optional decision note. After approving, the
 * approver is asked who covers the person's clients during the leave (or records No cover needed),
 * and sees the tasks due during the leave: "Reassign before 01 Jul?".
 */
export function DecideLeaveButtons({ leave, actorRole, staff }: { leave: LeaveRow; actorRole: AppRole; staff: PersonOption[] }) {
  const router = useRouter()
  const [decision, setDecision] = React.useState<"approved" | "declined" | null>(null)
  const [note, setNote] = React.useState("")
  const [approved, setApproved] = React.useState<LeaveRow | null>(null)
  const noteId = React.useId()

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {/* Outline: these sit one per row in lists, and a column of filled buttons drowns the page's own primary action. */}
        <Button type="button" size="sm" variant="outline" onClick={() => setDecision("approved")}>
          <CheckIcon aria-hidden="true" />
          Approve
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setDecision("declined")}>
          <XIcon aria-hidden="true" />
          Decline
        </Button>
      </div>
      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDecision(null)
            setNote("")
          }
        }}
        title={decision === "approved" ? `Approve ${firstName(leave.employee_name)}'s leave?` : `Decline ${firstName(leave.employee_name)}'s leave?`}
        description={
          decision === "approved"
            ? `${leave.employee_name} is away ${formatLeaveRange(leave.start_date, leave.end_date, leave.half_day)}. Attendance shows On leave for those days, and you'll be asked who covers their clients.`
            : `${leave.employee_name} is told it's declined, with your note.`
        }
        details={
          <div className="flex flex-col gap-1.5">
            <label htmlFor={noteId} className="text-sm font-medium text-text">
              Decision note <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <Textarea id={noteId} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </div>
        }
        confirmLabel={decision === "approved" ? "Approve leave" : "Decline leave"}
        destructive={decision === "declined"}
        onConfirm={async () => {
          if (!decision) return false
          const r = await decideLeave({ id: leave.id, updated_at: leave.updated_at, decision, note: note.trim() || null })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success(decision === "approved" ? `Approved. ${r.data.daysMarked} ${r.data.daysMarked === 1 ? "day is" : "days are"} marked On leave.` : "Declined.")
          setNote("")
          if (decision === "approved") setApproved(r.data.leave)
          else router.refresh()
        }}
      />
      {approved ? (
        <AfterApprovalDialog
          leave={approved}
          actorRole={actorRole}
          staff={staff}
          onOpenChange={(o) => {
            if (!o) {
              setApproved(null)
              router.refresh()
            }
          }}
        />
      ) : null}
    </>
  )
}

/**
 * The prompt after approving (§4.7 "Leave approval", §7.11.3): "Who covers Ravi's 18 clients from
 * 23 to 25 Oct?" with Set up cover (one person, or split by client) or No cover needed (recorded),
 * and the tasks due during the leave with "Reassign before 23 Oct?".
 */
export function AfterApprovalDialog({
  leave,
  actorRole,
  staff,
  onOpenChange,
}: {
  leave: LeaveRow
  actorRole: AppRole
  staff: PersonOption[]
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [ctx, setCtx] = React.useState<{ data: LeaveCoverContext | null; error: { message: string; ref?: string } | null }>({ data: null, error: null })
  const [cover, setCover] = React.useState(false)
  const [busy, setBusy] = React.useState<"none" | "reassign" | null>(null)
  const [moves, setMoves] = React.useState<Record<string, string>>({})
  const [formError, setFormError] = React.useState<{ message: string; ref?: string } | null>(null)

  const fetchCtx = React.useCallback(async () => {
    const r = await loadLeaveCoverContext({ leave_id: leave.id })
    return r.ok ? { data: r.data, error: null } : { data: null, error: { message: r.error, ref: r.ref } }
  }, [leave.id])
  React.useEffect(() => {
    let cancelled = false
    void fetchCtx().then((next) => {
      if (!cancelled) setCtx(next)
    })
    return () => {
      cancelled = true
    }
  }, [fetchCtx])
  const load = React.useCallback(async () => {
    setCtx((c) => ({ ...c, error: null }))
    setCtx(await fetchCtx())
  }, [fetchCtx])

  const when = coverWindowText(`${leave.start_date}T00:00:00+05:30`, `${leave.end_date}T23:59:00+05:30`)
  const clientCount = ctx.data?.clients.length ?? null
  const question =
    clientCount === null
      ? `Who covers ${firstName(leave.employee_name)}'s clients, ${when}?`
      : clientCount === 0
        ? `${firstName(leave.employee_name)} has no clients to cover, ${when}.`
        : `Who covers ${firstName(leave.employee_name)}'s ${clientCount} ${clientCount === 1 ? "client" : "clients"} ${when.includes("–") ? `from ${when.replace(/\s*–\s*/, " to ")}` : `on ${when}`}?`
  const options = staff.filter((s) => s.id !== leave.employee_id)

  const noCover = async () => {
    setBusy("none")
    setFormError(null)
    try {
      const r = await recordNoCoverNeeded({ id: leave.id })
      if (!r.ok) {
        setFormError({ message: r.error, ref: r.ref })
        return
      }
      toast.success("Recorded: no cover needed.")
      onOpenChange(false)
    } finally {
      setBusy(null)
    }
  }

  const reassign = async () => {
    const chosen = Object.entries(moves).filter(([, to]) => to)
    if (chosen.length === 0) {
      setFormError({ message: "Choose who takes at least one task." })
      return
    }
    setBusy("reassign")
    setFormError(null)
    try {
      const r = await reassignLeaveTasks({ leave_id: leave.id, moves: chosen.map(([task_id, to_employee_id]) => ({ task_id, to_employee_id })) })
      if (!r.ok) {
        setFormError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      if (r.data.moved) toast.success(`${r.data.moved} ${r.data.moved === 1 ? "task" : "tasks"} reassigned. They wait for the new person's acceptance.`)
      for (const s of r.data.skipped) toast.warning(s.reason, { duration: 12_000 })
      setMoves({})
      await load()
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const select = "h-9 w-full cursor-pointer rounded-md border border-text-muted/30 bg-surface px-2 text-sm text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 pointer-coarse:h-11"

  return (
    <>
      <FormDialog
        open={!cover}
        onOpenChange={onOpenChange}
        size="lg"
        title={question}
        description="While a cover is in force, the cover person works on these clients as if on the team, and never sees fees."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Decide later
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={noCover} disabled={busy !== null}>
                {busy === "none" ? <Spinner /> : null}
                No cover needed
              </Button>
              <Button type="button" onClick={() => setCover(true)} disabled={busy !== null || clientCount === 0}>
                <UsersRoundIcon aria-hidden="true" />
                Set up cover
              </Button>
            </div>
          </div>
        }
      >
        {formError ? <FormAlert error={formError} /> : null}
        {ctx.error ? (
          <ErrorBlock message="Couldn't load their clients and tasks." errorRef={ctx.error.ref} onRetry={load} size="compact" />
        ) : !ctx.data ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <section aria-labelledby="leave-tasks-title" className="flex flex-col gap-2">
              <h3 id="leave-tasks-title" className="text-base font-semibold text-text">
                {ctx.data.tasks.length ? ctx.data.prompt : "No open tasks are due during the leave."}
              </h3>
              {ctx.data.tasks.length ? (
                <>
                  <p className="text-sm text-text-muted">
                    {ctx.data.tasks.length} open {ctx.data.tasks.length === 1 ? "task is" : "tasks are"} due while {firstName(leave.employee_name)} is away. Move any that can&apos;t wait, or leave them to the cover person.
                  </p>
                  <ul className="divide-y divide-border/70 rounded-md border border-border">
                    {ctx.data.tasks.map((t) => (
                      <li key={t.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="min-w-0">
                          <span className="block truncate text-base text-text">{t.title}</span>
                          <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                            {t.task_number}
                            {t.client_name ? ` · ${t.client_name}` : ""} · <DateText date={t.due_date} withRelative /> · <StatusChip kind="task_status" value={t.status} />
                          </span>
                        </span>
                        <select aria-label={`Reassign ${t.task_number} to`} className={`${select} sm:w-52`} value={moves[t.id] ?? ""} onChange={(e) => setMoves((m) => ({ ...m, [t.id]: e.target.value }))}>
                          <option value="">Keep with {firstName(leave.employee_name)}</option>
                          {options.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.full_name}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  </ul>
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={reassign} disabled={busy !== null || !Object.values(moves).some(Boolean)}>
                      {busy === "reassign" ? <Spinner /> : null}
                      Reassign chosen tasks
                    </Button>
                  </div>
                </>
              ) : null}
            </section>
          </div>
        )}
      </FormDialog>
      {cover ? (
        <CoverDialog
          target={{ kind: "person", employeeId: leave.employee_id, name: leave.employee_name, leave: { id: leave.id, start: leave.start_date, end: leave.end_date } }}
          actorRole={actorRole}
          open
          onOpenChange={(o) => {
            if (!o) setCover(false)
          }}
          title={question}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </>
  )
}

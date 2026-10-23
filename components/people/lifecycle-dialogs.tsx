"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowRightLeftIcon, CircleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { ErrorBlock } from "@/components/app/error-block"
import type { PersonOption } from "@/lib/data/people"
import { ROLE_LABEL } from "@/lib/auth/roles"
import { deletePerson, loadOpenWork, reassignAllWork, setPersonActive, type ReassignResult } from "@/server/actions/people"
import type { EditablePerson } from "@/components/people/person-dialogs"

type OpenWork = { open_tasks: number; review_tasks: number; owned_clients: number; team_clients: number; open_notices: number; open_leads: number }

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function workLines(w: OpenWork): string[] {
  return [
    w.open_tasks ? plural(w.open_tasks, "open task") : null,
    w.review_tasks ? plural(w.review_tasks, "task to review", "tasks to review") : null,
    w.owned_clients ? plural(w.owned_clients, "client they own", "clients they own") : null,
    w.team_clients ? `a place on ${plural(w.team_clients, "client team")}` : null,
    w.open_notices ? plural(w.open_notices, "open notice") : null,
    w.open_leads ? plural(w.open_leads, "open lead") : null,
  ].filter((x): x is string => !!x)
}

function reassignSummary(r: ReassignResult, to: string): string {
  const parts = [
    r.tasks ? plural(r.tasks, "open task") : null,
    r.reviews ? plural(r.reviews, "review") : null,
    r.clients ? plural(r.clients, "client") : null,
    r.team ? plural(r.team, "team place") : null,
    r.notices ? plural(r.notices, "notice") : null,
    r.leads ? plural(r.leads, "lead") : null,
  ].filter(Boolean)
  return parts.length ? `Moved to ${to}: ${parts.join(", ")}.` : `There was nothing to move to ${to}.`
}

function staffOptions(staff: PersonOption[], except: string): ComboOption[] {
  return staff.filter((s) => s.id !== except).map((s) => ({ value: s.id, label: s.full_name, description: [ROLE_LABEL[s.role], s.designation].filter(Boolean).join(" · ") }))
}

/**
 * "Reassign all work to…" (§4.5 point 6): one action moves open tasks, client ownership, reviewer
 * places, team places, open notices and open leads, and logs it on each client's timeline.
 */
function ReassignPicker({
  person,
  staff,
  onMoved,
}: {
  person: EditablePerson
  staff: PersonOption[]
  onMoved: (r: ReassignResult) => void
}) {
  const [to, setTo] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const options = React.useMemo(() => staffOptions(staff, person.id), [staff, person.id])
  const toName = options.find((o) => o.value === to)?.label ?? ""
  const id = React.useId()

  const move = async () => {
    if (!to) {
      setError({ message: "Choose who takes the work." })
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await reassignAllWork({ from_employee_id: person.id, to_employee_id: to })
      if (!r.ok) {
        setError({ message: r.fieldErrors?.to_employee_id?.[0] ?? r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(reassignSummary(r.data, toName))
      if (r.data.tasks_reviewer_cleared || r.data.reviews_cleared) {
        toast.warning(`${plural(r.data.tasks_reviewer_cleared + r.data.reviews_cleared, "task")} lost their reviewer, because ${toName} is now the assignee. Choose another reviewer on those tasks.`, { duration: 15_000 })
      }
      onMoved(r.data)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3">
      {error ? <FormAlert error={error} className="mb-1" /> : null}
      <label htmlFor={id} className="text-sm font-medium text-text">
        Reassign all work to
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Combobox id={id} value={to} onChange={(v) => setTo(v)} options={options} placeholder="Choose a colleague" searchPlaceholder="Search the team" className="sm:flex-1" />
        <Button type="button" onClick={move} disabled={pending || !to}>
          {pending ? <Spinner /> : <ArrowRightLeftIcon aria-hidden="true" />}
          Move the work
        </Button>
      </div>
      <p className="text-sm text-text-muted">The tasks wait for the new person&apos;s acceptance. Each client&apos;s timeline records the move.</p>
    </div>
  )
}

function useOpenWork(id: string, open: boolean) {
  const [state, setState] = React.useState<{ work: OpenWork | null; error: { message: string; ref?: string } | null }>({ work: null, error: null })
  const [loading, setLoading] = React.useState(open)
  // A fresh check each time the dialog opens (state adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setLoading(true)
  }
  const fetchWork = React.useCallback(async () => {
    const r = await loadOpenWork({ id })
    return r.ok ? { work: r.data, error: null } : { work: null, error: { message: r.error, ref: r.ref } }
  }, [id])
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchWork().then((next) => {
      if (cancelled) return
      setState(next)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, fetchWork])
  const reload = React.useCallback(async () => {
    setLoading(true)
    setState((s) => ({ ...s, error: null }))
    const next = await fetchWork()
    setState(next)
    setLoading(false)
  }, [fetchWork])
  return { loading, ...state, reload }
}

/**
 * Disable or delete (§4.5 points 6–7): the dialog shows what the person still holds; open tasks and
 * review items block it until they are moved with "Reassign all work to…". Disabling blocks
 * sign-in at once and keeps their history; a Partner can enable them again. Deleting (Partner) is
 * soft: the record stays for the history.
 */
export function RetireDialog({
  person,
  mode,
  staff,
  open,
  onOpenChange,
}: {
  person: EditablePerson
  mode: "disable" | "delete"
  staff: PersonOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { loading, work, error, reload } = useOpenWork(person.id, open)
  const [pending, setPending] = React.useState(false)
  const [formError, setFormError] = React.useState<{ message: string; ref?: string } | null>(null)

  const blocked = !!work && work.open_tasks + work.review_tasks > 0
  const lines = work ? workLines(work) : []

  const confirm = async () => {
    setPending(true)
    setFormError(null)
    try {
      const r = mode === "disable" ? await setPersonActive({ id: person.id, active: false, updated_at: person.updated_at }) : await deletePerson({ id: person.id, updated_at: person.updated_at })
      if (!r.ok) {
        setFormError({ message: r.error, ref: r.ref })
        if (r.code === "blocked") await reload()
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(mode === "disable" ? `${person.full_name} is disabled and can't sign in.` : `${person.full_name} is deleted. Their history is kept.`)
      onOpenChange(false)
      if (mode === "delete") router.push("/people")
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={mode === "disable" ? `Disable ${person.full_name}?` : `Delete ${person.full_name}?`}
      description={
        mode === "disable"
          ? "They can't sign in from now on, and their open sessions end. Their history stays, and you can enable them again."
          : "Their record is removed from the team list. Their history, time entries and the work they did stay on record."
      }
      pending={pending}
      footer={
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={pending || loading || blocked || !!error}>
            {pending ? <Spinner /> : null}
            {mode === "disable" ? "Disable" : "Delete"} {person.full_name.split(" ")[0]}
          </Button>
        </div>
      }
    >
      {formError ? <FormAlert error={formError} /> : null}
      {loading && !work ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : error ? (
        <ErrorBlock message="Couldn't check their open work." errorRef={error.ref} onRetry={reload} size="compact" />
      ) : work ? (
        <div className="flex flex-col gap-4">
          {lines.length ? (
            <div className={blocked ? "flex gap-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5" : ""}>
              {blocked ? <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" /> : null}
              <p className="text-base text-text">
                {person.full_name} still holds {lines.join(", ")}.{" "}
                {blocked ? "Move the open tasks and reviews first, so no work is lost." : "These move with Reassign all work, or you can leave them."}
              </p>
            </div>
          ) : (
            <p className="text-base text-text">{person.full_name} holds no open work.</p>
          )}
          {lines.length ? (
            <ReassignPicker
              person={person}
              staff={staff}
              onMoved={async () => {
                await reload()
                router.refresh()
              }}
            />
          ) : null}
        </div>
      ) : null}
    </FormDialog>
  )
}

/** "Reassign all work to…" on its own (from the person's menu). */
export function ReassignDialog({ person, staff, open, onOpenChange }: { person: EditablePerson; staff: PersonOption[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const { loading, work, error, reload } = useOpenWork(person.id, open)
  const lines = work ? workLines(work) : []
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Reassign ${person.full_name}'s work`}
      description="Moves their open tasks, reviews, client ownership, team places, open notices and leads to one colleague."
      footer={
        <div className="ml-auto">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      }
    >
      {loading && !work ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : error ? (
        <ErrorBlock message="Couldn't check their open work." errorRef={error.ref} onRetry={reload} size="compact" />
      ) : work ? (
        <div className="flex flex-col gap-4">
          <p className="text-base text-text">{lines.length ? `${person.full_name} holds ${lines.join(", ")}.` : `${person.full_name} holds no open work, so there is nothing to move.`}</p>
          {lines.length ? (
            <ReassignPicker
              person={person}
              staff={staff}
              onMoved={async () => {
                await reload()
                router.refresh()
              }}
            />
          ) : null}
        </div>
      ) : null}
    </FormDialog>
  )
}

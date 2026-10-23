"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CLIENT_STATUSES, type ClientStatus } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { statusChangeConsequence } from "@/lib/schemas/clients"
import { bulkChangeStatus, changeClientStatus } from "@/server/actions/clients"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { toneClasses } from "@/components/app/tones"

export type StatusTarget =
  | { kind: "one"; clientId: string; name: string; current: ClientStatus; updatedAt: string }
  | { kind: "many"; clientIds: string[] }

/**
 * Change status with a reason (§7.3.4). The dialog says what the new status means; for On hold and
 * Inactive it says that reminders to the client and automatic invoicing pause. One client (row
 * action) or a selection (bulk action, §7.3.1).
 */
export function ClientStatusDialog({
  target,
  open,
  onOpenChange,
  onDone,
}: {
  target: StatusTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const router = useRouter()
  const [to, setTo] = React.useState<ClientStatus | "">("")
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [reasonError, setReasonError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const reasonId = React.useId()
  const statusId = React.useId()

  // Each opening starts clean (state adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTo("")
      setReason("")
      setError(null)
      setReasonError(null)
    }
  }

  if (!target) return null
  const current = target.kind === "one" ? target.current : null
  const choices = CLIENT_STATUSES.filter((s) => s !== current)
  const title = target.kind === "one" ? `Change the status of ${target.name}` : `Change the status of ${target.clientIds.length} clients`

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setReasonError(null)
    if (!to) {
      setError({ message: "Choose the new status." })
      return
    }
    if (reason.trim().length < 3) {
      setReasonError("Give a reason (at least 3 characters).")
      return
    }
    setPending(true)
    try {
      if (target.kind === "one") {
        const r = await changeClientStatus({ clientId: target.clientId, to, reason, updatedAt: target.updatedAt })
        if (!r.ok) {
          setError({ message: r.error, ref: r.ref })
          if (r.fieldErrors?.reason) setReasonError(r.fieldErrors.reason[0])
          return
        }
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        toast.success(`${target.name} is now ${getStatus("client_status", to).label}.`)
      } else {
        const r = await bulkChangeStatus({ clientIds: target.clientIds, to, reason })
        if (!r.ok) {
          setError({ message: r.error, ref: r.ref })
          return
        }
        const label = getStatus("client_status", to).label
        toast.success(`${r.data.changed} ${r.data.changed === 1 ? "client is" : "clients are"} now ${label}.`)
        if (r.data.skipped.length) {
          toast.warning(
            `${r.data.skipped.length} not changed: ${r.data.skipped
              .slice(0, 3)
              .map((s) => `${s.name} (${s.reason})`)
              .join("; ")}${r.data.skipped.length > 3 ? " …" : ""}`,
            { duration: 12_000 },
          )
        }
      }
      onOpenChange(false)
      onDone?.()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      description={current ? `Now ${getStatus("client_status", current).label}. The reason is kept in the client's history.` : "The reason is kept in each client's history."}
      onSubmit={submit}
      pending={pending}
      dirty={!!to || !!reason}
      submitLabel="Change status"
    >
      <div className="flex flex-col gap-4">
        {error ? <FormAlert error={error} /> : null}
        <fieldset className="flex flex-col gap-2">
          <legend id={statusId} className="mb-1 text-sm font-medium text-text">
            New status<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
          </legend>
          <div role="radiogroup" aria-labelledby={statusId} className="grid grid-cols-2 gap-2">
            {choices.map((s) => {
              const info = getStatus("client_status", s)
              const selected = to === s
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTo(s)}
                  className={cn(
                    "flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-left text-base transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    selected ? "border-primary bg-primary-soft text-text" : "border-border bg-surface hover:bg-surface-2",
                  )}
                >
                  <span aria-hidden="true" className={cn("size-2 flex-none rounded-full", toneClasses(info.tone).dot)} />
                  {info.label}
                </button>
              )
            })}
          </div>
        </fieldset>
        {to ? (
          <p className={cn("rounded-md border px-3 py-2 text-sm", to === "on_hold" || to === "inactive" ? "border-warning/40 bg-warning-soft text-warning-text" : "border-border bg-surface-2 text-text-muted")}>
            {statusChangeConsequence(to)}
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>
            Reason<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
          </Label>
          <Textarea
            id={reasonId}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? `${reasonId}-err` : undefined}
            placeholder="For example: engagement paused until the new financial year"
          />
          {reasonError ? (
            <p id={`${reasonId}-err`} className="text-sm text-danger-text">
              {reasonError}
            </p>
          ) : null}
        </div>
      </div>
    </FormDialog>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CalendarPlusIcon, MessageSquareTextIcon, UndoIcon, XCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import type { AppRole } from "@/lib/auth/roles"
import type { CoverState } from "@/lib/domain/cover"
import { formatCoverUntil } from "@/lib/domain/cover"
import type { CoverRow } from "@/lib/data/covers"
import { COVER_REASON_LABELS, ExtendCoverSchema, ReturnNoteSchema } from "@/lib/schemas/covers"
import { endCover, extendCover, loadCoverFormContext, saveReturnNote } from "@/server/actions/covers"
import { DateTimeField } from "@/components/covers/date-time-field"
import { cn } from "@/lib/utils"
import { refreshDesktopContext } from "@/components/shell/use-desktop"

const STATE: Record<CoverState, { label: string; tone: "success" | "info" | "muted"; meaning: string }> = {
  in_force: { label: "In force", tone: "success", meaning: "In force: the cover person works on these clients now. Access ends by itself at Until." },
  scheduled: { label: "Scheduled", tone: "info", meaning: "Scheduled: the cover starts at From. Until then nothing changes." },
  ended: { label: "Ended", tone: "muted", meaning: "Ended: the cover reached its Until and access ended by itself." },
  revoked: { label: "Ended early", tone: "muted", meaning: "Ended early: someone ended the cover before its Until." },
}

export function CoverStateChip({ state }: { state: CoverState }) {
  const s = STATE[state]
  return <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
}

/** "Anita covers Ravi's clients" / "Anita covers Alpha Traders for Ravi" / "Anita covers Alpha Traders". */
export function coverSentence(c: CoverRow, perspective: "any" | "client"): React.ReactNode {
  if (c.kind === "person") return `${c.cover_name} covers ${c.absent_name ?? "a colleague"}'s clients`
  if (perspective === "client") return c.absent_name ? `${c.cover_name} covers for ${c.absent_name}` : `${c.cover_name} covers this client`
  return (
    <>
      {c.cover_name} covers{" "}
      {c.client_id && c.client_name ? (
        <Link href={`/clients/${c.client_id}`} className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {c.client_name}
        </Link>
      ) : (
        "a client"
      )}
      {c.absent_name ? ` for ${c.absent_name}` : ""}
    </>
  )
}

/**
 * Covers as a list (§4.7): who covers whom, the window, the state, the handover note, and the note
 * back. Actions by who is looking: Partners and Managers Extend and End now; the absent person
 * "I'm back, end cover"; the cover person leaves a note back once it has ended.
 */
export function CoverList({
  covers,
  viewer,
  perspective = "any",
  emptyText,
  autoReturnNoteFor,
}: {
  covers: CoverRow[]
  viewer: { role: AppRole; employeeId: string | null }
  perspective?: "any" | "client"
  emptyText: string
  /** Opens the note-back dialog for this cover (the "cover ended" notification's link). */
  autoReturnNoteFor?: string | null
}) {
  const [extend, setExtend] = React.useState<CoverRow | null>(null)
  const [end, setEnd] = React.useState<CoverRow | null>(null)
  const [note, setNote] = React.useState<CoverRow | null>(() => covers.find((c) => c.id === autoReturnNoteFor && !c.return_note) ?? null)
  const manager = viewer.role === "partner" || viewer.role === "manager"

  if (covers.length === 0) return <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">{emptyText}</p>

  return (
    <>
      <ul className="flex flex-col divide-y divide-border/70">
        {covers.map((c) => {
          const live = c.state === "in_force" || c.state === "scheduled"
          const imAbsent = viewer.employeeId !== null && viewer.employeeId === c.absent_employee_id
          const imCover = viewer.employeeId !== null && viewer.employeeId === c.cover_employee_id
          return (
            <li key={c.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="text-base font-medium text-text">{coverSentence(c, perspective)}</p>
                  <p className="num text-sm text-text-muted">
                    {c.state === "scheduled" ? `From ${formatCoverUntil(c.starts_at)} · ` : ""}
                    {c.state === "revoked" && c.revoked_at ? `Ended ${formatCoverUntil(c.revoked_at)}` : `Until ${formatCoverUntil(c.ends_at)}`} · {COVER_REASON_LABELS[c.reason]}
                    {c.include_vault ? " · Portal passwords included" : ""}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <CoverStateChip state={c.state} />
                </div>
              </div>
              {c.handover_note ? (
                <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-text">
                  <span className="font-medium">Handover: </span>
                  <span className="whitespace-pre-line">{c.handover_note}</span>
                </p>
              ) : null}
              {c.return_note ? (
                <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-text">
                  <span className="font-medium">Note back from {c.cover_name}: </span>
                  <span className="whitespace-pre-line">{c.return_note}</span>
                </p>
              ) : null}
              <p className="text-xs text-text-muted">
                Granted by {c.granted_by_name ?? "a Partner or Manager"}
                {c.revoked_by_name && c.state === "revoked" ? ` · ended by ${c.revoked_by_name}${c.revoke_reason ? ` (${c.revoke_reason})` : ""}` : ""}
              </p>
              {(live && (manager || imAbsent)) || (!live && imCover && !c.return_note) ? (
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {live && manager ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setExtend(c)}>
                      <CalendarPlusIcon aria-hidden="true" />
                      Extend
                    </Button>
                  ) : null}
                  {live && (manager || imAbsent) ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setEnd(c)}>
                      {imAbsent && !manager ? <UndoIcon aria-hidden="true" /> : <XCircleIcon aria-hidden="true" />}
                      {imAbsent ? "I'm back, end cover" : "End now"}
                    </Button>
                  ) : null}
                  {!live && imCover && !c.return_note ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setNote(c)}>
                      <MessageSquareTextIcon aria-hidden="true" />
                      Leave a note back
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {extend ? <ExtendCoverDialog cover={extend} onOpenChange={(o) => !o && setExtend(null)} /> : null}
      {end ? <EndCoverDialog cover={end} imBack={viewer.employeeId === end.absent_employee_id} onOpenChange={(o) => !o && setEnd(null)} /> : null}
      {note ? <ReturnNoteDialog cover={note} onOpenChange={(o) => !o && setNote(null)} /> : null}
    </>
  )
}

function ExtendCoverDialog({ cover, onOpenChange }: { cover: CoverRow; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [picks, setPicks] = React.useState<Array<{ key: string; label: string; endsAt: string }>>([])
  React.useEffect(() => {
    let cancelled = false
    void loadCoverFormContext({ absent_employee_id: cover.absent_employee_id }).then((r) => {
      if (!cancelled && r.ok) setPicks(r.data.quickPicks.filter((p) => Date.parse(p.endsAt) > Date.parse(cover.ends_at)))
    })
    return () => {
      cancelled = true
    }
  }, [cover.absent_employee_id, cover.ends_at])
  const f = useActionForm(ExtendCoverSchema, extendCover, {
    defaultValues: { id: cover.id, updated_at: cover.updated_at, ends_at: cover.ends_at },
    successMessage: "Cover extended.",
    onSuccess: () => {
      onOpenChange(false)
      refreshDesktopContext()
      router.refresh()
    },
  })
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      size="sm"
      title="Extend the cover"
      description={`Now until ${formatCoverUntil(cover.ends_at)}. A cover lasts at most 90 days from its start.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Extend"
    >
      <FormAlert state={f} />
      <DateTimeField control={f.control} name="ends_at" label="New Until" required>
        {picks.length ? (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {picks.map((p) => (
              <Button key={p.key} type="button" size="xs" variant="outline" onClick={() => f.form.setValue("ends_at", p.endsAt, { shouldDirty: true, shouldValidate: true })}>
                {p.label}
              </Button>
            ))}
          </div>
        ) : null}
      </DateTimeField>
    </FormDialog>
  )
}

function EndCoverDialog({ cover, imBack, onOpenChange }: { cover: CoverRow; imBack: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [reason, setReason] = React.useState("")
  const id = React.useId()
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={imBack ? "You're back: end the cover?" : `End ${cover.cover_name}'s cover now?`}
      description={`${cover.cover_name} stops seeing ${cover.kind === "client" ? (cover.client_name ?? "the client") : cover.absent_name ? `${cover.absent_name}'s clients` : "the clients"} at once. They are asked for a note back.`}
      details={
        imBack ? null : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium text-text">
              Reason <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </div>
        )
      }
      confirmLabel={imBack ? "End cover" : "End now"}
      destructive={!imBack}
      onConfirm={async () => {
        const r = await endCover({ id: cover.id, updated_at: cover.updated_at, reason: reason.trim() || null })
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return false
        }
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        toast.success("Cover ended.")
        refreshDesktopContext()
        router.refresh()
      }}
    />
  )
}

export function ReturnNoteDialog({ cover, onOpenChange }: { cover: CoverRow; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const f = useActionForm(ReturnNoteSchema, saveReturnNote, {
    defaultValues: { id: cover.id, return_note: "" },
    successMessage: "Note sent.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      size="md"
      title={`A note back to ${cover.absent_name ?? "them"}`}
      description="What you did while covering, and anything they should pick up. Optional, but it saves them asking."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Send note"
      cancelLabel="Not now"
    >
      <FormAlert state={f} />
      <TextareaField control={f.control} name="return_note" label="Note" required rows={6} className={cn("min-w-0")} />
    </FormDialog>
  )
}

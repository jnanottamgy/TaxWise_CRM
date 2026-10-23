"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { LeadStatus } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { LOST_CATEGORIES, LOST_CATEGORY_LABELS, leadMoveCheck, type LostCategory } from "@/lib/schemas/leads"
import { moveLeadStage } from "@/server/actions/leads"

export type MovableLead = { id: string; name: string; company: string | null; status: LeadStatus; converted_client_id: string | null; updated_at: string }

/**
 * Moving a lead between stages (§7.5.1), shared by the board (drag, or the card's Move menu) and the
 * lead's page (Mark lost): Lost asks why (a category for the win/loss analysis and a sentence);
 * a converted lead stays Won. Every move is the server's moveLeadStage, with the lead's updated_at.
 *
 *   const mover = useLeadMover()
 *   mover.move(lead, "contacted")
 *   {mover.dialogs}
 */
export function useLeadMover() {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [losing, setLosing] = React.useState<MovableLead | null>(null)

  const run = async (lead: MovableLead, to: LeadStatus, lost?: { category: LostCategory; reason: string }) => {
    setBusy(lead.id)
    try {
      const r = await moveLeadStage({ id: lead.id, to, updatedAt: lead.updated_at, lostCategory: lost?.category ?? null, lostReason: lost?.reason ?? "" })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return r
      }
      for (const w of r.warnings ?? []) toast.warning(w)
      toast.success(`${lead.company || lead.name} moved to ${getStatus("lead_status", to).label}.`)
      router.refresh()
      return r
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
      return null
    } finally {
      setBusy(null)
    }
  }

  const move = (lead: MovableLead, to: LeadStatus) => {
    const check = leadMoveCheck(lead, to)
    if (!check.ok) {
      toast.error(check.error)
      return
    }
    if (check.requiresReason) {
      setLosing(lead)
      return
    }
    void run(lead, to)
  }

  return {
    move,
    busy,
    dialogs: (
      <LostDialog
        lead={losing}
        onOpenChange={(o) => !o && setLosing(null)}
        onSubmit={async (category, reason) => {
          if (!losing) return { ok: false as const, error: "Choose the lead again." }
          const r = await run(losing, "lost", { category, reason })
          if (r?.ok) setLosing(null)
          return r && !r.ok ? { ok: false as const, error: r.error, ref: r.ref, fieldErrors: r.fieldErrors } : { ok: true as const }
        }}
      />
    ),
  }
}

/** Mark lost (reason*): a category and what happened, kept for the win/loss review (§7.5.1). */
export function LostDialog({
  lead,
  onOpenChange,
  onSubmit,
}: {
  lead: MovableLead | null
  onOpenChange: (open: boolean) => void
  onSubmit: (category: LostCategory, reason: string) => Promise<{ ok: true } | { ok: false; error: string; ref?: string; fieldErrors?: Record<string, string[]> }>
}) {
  const [category, setCategory] = React.useState<LostCategory | "">("")
  const [reason, setReason] = React.useState("")
  const [errors, setErrors] = React.useState<{ category?: string; reason?: string }>({})
  const [formError, setFormError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [pending, setPending] = React.useState(false)
  const reasonId = React.useId()
  const open = lead !== null

  // A fresh form each time it opens.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setCategory("")
      setReason("")
      setErrors({})
      setFormError(null)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!category) next.category = "Choose why the lead was lost."
    if (reason.trim().length < 3) next.reason = "Say briefly what happened, for the win/loss review."
    setErrors(next)
    if (next.category || next.reason || !category) return
    setPending(true)
    try {
      const r = await onSubmit(category, reason.trim())
      if (!r.ok) {
        setFormError({ message: r.error, ref: r.ref })
        setErrors({ category: r.fieldErrors?.lostCategory?.[0], reason: r.fieldErrors?.lostReason?.[0] })
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={lead ? `Mark ${lead.company || lead.name} as lost` : "Mark as lost"}
      description="The lead closes as Lost. The reason feeds the win/loss analysis; you can reopen it later."
      onSubmit={submit}
      pending={pending}
      dirty={!!category || !!reason.trim()}
      submitLabel="Mark as lost"
    >
      <div className="flex flex-col gap-5">
        {formError ? <FormAlert error={formError} /> : null}
        <fieldset className="flex flex-col gap-2" aria-describedby={errors.category ? "lost-category-error" : undefined}>
          <legend className="mb-1 text-sm font-medium text-text">
            Why<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
          </legend>
          <div role="radiogroup" aria-label="Why the lead was lost" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {LOST_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  "min-h-10 cursor-pointer rounded-md border px-3 text-left text-base transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11",
                  category === c ? "border-primary bg-primary-soft text-text" : "border-border bg-surface hover:bg-surface-2",
                )}
              >
                {LOST_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          {errors.category ? (
            <p id="lost-category-error" className="text-sm text-danger-text">
              {errors.category}
            </p>
          ) : null}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>
            What happened<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
          </Label>
          <Textarea
            id={reasonId}
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={errors.reason ? true : undefined}
            aria-describedby={errors.reason ? `${reasonId}-error` : undefined}
            placeholder="For example: went with a firm near their factory in Peenya"
          />
          {errors.reason ? (
            <p id={`${reasonId}-error`} className="text-sm text-danger-text">
              {errors.reason}
            </p>
          ) : null}
        </div>
      </div>
    </FormDialog>
  )
}

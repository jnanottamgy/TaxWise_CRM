"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, useWatch, type Control } from "react-hook-form"
import { cn } from "@/lib/utils"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { IMS_DEEMED_ACCEPTANCE_NOTE } from "@/lib/domain/recon"
import { IMS_ACTIONS, IMS_META, ImsDecisionSchema, RESOLUTION_META, ResolveLinesSchema, type ImsAction, type ImsDecisionInput, type ReconResolution, type ResolveLinesInput } from "@/lib/schemas/gst-recon"
import { decideImsAction, resolveReconLines } from "@/server/actions/gst-recon"

const RESOLVE_CHOICES: Array<{ value: ReconResolution; title: string; help: string }> = [
  { value: "accepted", title: "Settled", help: "The difference is explained and dealt with: booked, claimed, or accepted as it is. It stops carrying forward." },
  { value: "follow_up_supplier", title: "Following up the supplier", help: "The supplier has been asked to file or correct their GSTR-1. It keeps carrying forward until they do." },
  { value: "ignore", title: "Ignore", help: "No action is needed (for example, ITC the client doesn't claim). Say why in the note." },
  { value: "open", title: "Open again", help: "Undo an earlier resolution; the note is cleared." },
]

/**
 * Resolve reconciliation lines with a note (§7.8.1 "mark rows resolved with notes"): one line from
 * its detail sheet, or the selected lines of a table. All or nothing; each line's version is
 * checked, so two people resolving the same line can't overwrite each other (§13).
 */
export function ResolveDialog({
  runId,
  lines,
  initial = "accepted",
  onClose,
  onDone,
}: {
  runId: string
  lines: Array<{ id: string; updatedAt: string }>
  initial?: ReconResolution
  onClose: () => void
  onDone?: () => void
}) {
  const router = useRouter()
  const f = useActionForm(ResolveLinesSchema, resolveReconLines, {
    defaultValues: { runId, lines, resolution: initial, note: "" } satisfies ResolveLinesInput,
    successMessage: (d) => `${d.updated} ${d.updated === 1 ? "line" : "lines"} updated`,
    onSuccess: () => {
      onClose()
      onDone?.()
      router.refresh()
    },
  })
  const control = f.control as unknown as Control<ResolveLinesInput>
  const res = useController({ control, name: "resolution" })
  const note = useWatch({ control, name: "note" })
  const value = res.field.value as ReconResolution
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={lines.length === 1 ? "Resolve this line" : `Resolve ${lines.length} lines`}
      description="What happened to the difference? The note is shown on the line and in the export."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={Boolean(String(note ?? "").trim())}
      submitLabel="Save"
    >
      <FormAlert state={f} />
      <fieldset className="mb-4 flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-text">Resolution</legend>
        <RadioGroup value={value} onValueChange={(v) => res.field.onChange(v)} className="grid gap-2">
          {RESOLVE_CHOICES.map((c) => (
            <label key={c.value} className={cn("flex cursor-pointer gap-3 rounded-md border px-3 py-2.5", value === c.value ? "border-primary bg-primary-soft/40" : "border-border hover:bg-surface-2")}>
              <RadioGroupItem value={c.value} aria-label={c.title} className="mt-0.5" />
              <span className="flex flex-col">
                <span className="text-base text-text">{c.title}</span>
                <span className="text-sm text-text-muted">{c.help}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {value !== "open" ? (
        <TextareaField
          control={control}
          name="note"
          label="Note"
          required={value === "ignore"}
          rows={3}
          placeholder={value === "follow_up_supplier" ? "Asked the supplier to file the September GSTR-1" : value === "ignore" ? "Blocked credit under s.17(5)" : "Booked in October and claimed in the October GSTR-3B"}
        />
      ) : null}
      <p className="sr-only" aria-live="polite">
        {RESOLUTION_META[value].label}
      </p>
    </FormDialog>
  )
}

/**
 * The IMS decision for one GSTR-2B document (§6.7, §6.12 "IMS action list (accept / reject / keep
 * pending, with reasons)"): the app suggests an action from the match; a person confirms or changes
 * it with the reason, and that is what the client acts on in the IMS.
 */
export function ImsDialog({
  runId,
  line,
  onClose,
}: {
  runId: string
  line: { id: string; updatedAt: string; action: ImsAction | null; reason: string | null; label: string }
  onClose: () => void
}) {
  const router = useRouter()
  const f = useActionForm(ImsDecisionSchema, decideImsAction, {
    defaultValues: { runId, lineId: line.id, updatedAt: line.updatedAt, action: line.action ?? "keep_pending", reason: line.reason ?? "" } satisfies ImsDecisionInput,
    successMessage: "IMS decision saved",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const control = f.control as unknown as Control<ImsDecisionInput>
  const act = useController({ control, name: "action" })
  const value = act.field.value as ImsAction
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title="IMS decision"
      description={line.label}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={false}
      submitLabel="Save decision"
    >
      <FormAlert state={f} />
      <fieldset className="mb-4 flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-text">Action on the IMS</legend>
        <RadioGroup value={value} onValueChange={(v) => act.field.onChange(v)} className="grid gap-2">
          {IMS_ACTIONS.map((a) => (
            <label key={a} className={cn("flex cursor-pointer gap-3 rounded-md border px-3 py-2.5", value === a ? "border-primary bg-primary-soft/40" : "border-border hover:bg-surface-2")}>
              <RadioGroupItem value={a} aria-label={IMS_META[a].label} className="mt-0.5" />
              <span className="flex flex-col">
                <span className="text-base text-text">{IMS_META[a].label}</span>
                <span className="text-sm text-text-muted">{IMS_META[a].meaning.replace(/^[^:]+: /, "")}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      <TextareaField control={control} name="reason" label="Reason" required rows={3} />
      <p className="mt-3 text-sm text-text-muted">{IMS_DEEMED_ACCEPTANCE_NOTE}</p>
    </FormDialog>
  )
}

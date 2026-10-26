"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController } from "react-hook-form"
import { CheckIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { DECLINE_REASON_OPTIONS, RespondSchema } from "@/lib/schemas/tasks"
import { respondToTask } from "@/server/actions/tasks"

/**
 * Accept or Decline (§7.6.3). A newly assigned task waits for its assignee: Accept takes it on;
 * Decline asks for a reason code (and a note for "Something else"), unassigns the task and tells the
 * assigner and Managers. Shown only to the assignee; the database refuses anyone else.
 */
export function AcceptDecline({
  task,
  size = "sm",
  layout = "row",
  quiet = false,
}: {
  task: { id: string; task_number: string; title: string }
  size?: "sm" | "default"
  layout?: "row" | "stack"
  /** Outline Accept, for a list where every row has one: one filled button per region (DESIGN.md §3). */
  quiet?: boolean
}) {
  const router = useRouter()
  const [accepting, setAccepting] = React.useState(false)
  const [declining, setDeclining] = React.useState(false)

  const accept = async () => {
    setAccepting(true)
    try {
      const r = await respondToTask({ id: task.id, accept: true })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`You accepted ${task.task_number}.`)
      router.refresh()
    } catch {
      toast.error("That didn't reach the server. Check your connection and try again.")
    } finally {
      setAccepting(false)
    }
  }

  return (
    <div className={cn("flex gap-2", layout === "stack" ? "flex-col sm:flex-row" : "flex-wrap items-center")}>
      <Button size={size} variant={quiet ? "outline" : "default"} onClick={accept} disabled={accepting} aria-busy={accepting}>
        {accepting ? <Spinner /> : <CheckIcon aria-hidden="true" />}
        Accept
      </Button>
      {/* Decline is the lesser answer: a ghost button, so a list of requests isn't a wall of boxes. */}
      <Button size={size} variant="ghost" onClick={() => setDeclining(true)}>
        <XIcon aria-hidden="true" />
        Decline
      </Button>
      {declining ? <DeclineDialog task={task} onClose={() => setDeclining(false)} onDone={() => router.refresh()} /> : null}
    </div>
  )
}

function DeclineDialog({ task, onClose, onDone }: { task: { id: string; task_number: string; title: string }; onClose: () => void; onDone: () => void }) {
  const f = useActionForm(RespondSchema, respondToTask, {
    defaultValues: { id: task.id, accept: false, reason: "", note: "" },
    successMessage: `You declined ${task.task_number}. The Managers have been told.`,
    onSuccess: () => {
      onClose()
      onDone()
    },
  })
  const reason = useController({ control: f.control, name: "reason" })
  const legend = React.useId()
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title="Decline this task"
      description={`${task.task_number} · ${task.title}. It will be unassigned and go back to the Managers.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={Boolean(reason.field.value)}
      submitLabel="Decline"
    >
      <FormAlert state={f} />
      <fieldset aria-labelledby={legend} className="mb-4">
        <legend id={legend} className="mb-2 text-sm font-medium text-text">
          Reason <span className="text-danger-text">*</span>
        </legend>
        <RadioGroup value={(reason.field.value as string) ?? ""} onValueChange={(v) => reason.field.onChange(v)} className="gap-1.5" aria-invalid={reason.fieldState.error ? true : undefined}>
          {DECLINE_REASON_OPTIONS.map((o) => {
            const id = `decline-${o.value}`
            return (
              <label key={o.value} htmlFor={id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-surface-2 pointer-coarse:min-h-11">
                <RadioGroupItem id={id} value={o.value} />
                <span className="text-base text-text">{o.label}</span>
              </label>
            )
          })}
        </RadioGroup>
        {reason.fieldState.error ? <p className="mt-1 text-sm text-danger-text">{reason.fieldState.error.message}</p> : null}
      </fieldset>
      <TextareaField
        control={f.control}
        name="note"
        label="Note"
        required={reason.field.value === "other"}
        rows={3}
        helper={reason.field.value === "other" ? "Say what's in the way, so the Manager can sort it out." : "Optional: anything the Manager should know."}
      />
    </FormDialog>
  )
}

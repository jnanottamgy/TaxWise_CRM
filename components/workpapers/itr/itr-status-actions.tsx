"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, type Control, type FieldValues } from "react-hook-form"
import { toast } from "sonner"
import { CheckCheckIcon, FileDownIcon, LockIcon, PencilIcon, RotateCcwIcon, UndoIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { useActionForm } from "@/hooks/use-action-form"
import type { Regime } from "@/lib/domain/itr-rulesets"
import { ItrStatusSchema, REGIME_LABEL, itrActions, type ItrStatus } from "@/lib/schemas/itr"
import { setItrStatus } from "@/server/actions/itr"
import { taxAmount } from "@/components/workpapers/itr/itr-ui"

type Totals = Record<Regime, number>

/**
 * The computation's next steps (§7.8.2): Mark reviewed (the reviewer records the regime chosen,
 * defaulting to the recommended one), Mark final (Manager/Partner), Send back to Draft with a note,
 * Reopen a final one (Manager/Partner), Edit inputs and the PDF. The buttons follow itrActions; the
 * database decides again.
 */
export function ItrStatusActions({
  id,
  updatedAt,
  status,
  preparedBy,
  viewer,
  recommended,
  chosen,
  totals,
  view,
  hasBusiness = false,
}: {
  id: string
  updatedAt: string
  status: ItrStatus
  preparedBy: string | null
  viewer: { id: string; role: "partner" | "manager" | "employee" }
  recommended: Regime | null
  chosen: Regime | null
  totals: Totals | null
  view: "sheet" | "inputs"
  hasBusiness?: boolean
}) {
  const router = useRouter()
  const a = itrActions({ status, preparedBy }, viewer)
  const [dialog, setDialog] = React.useState<null | "review" | "regime" | "final" | "back" | "reopen">(null)

  const finalise = async () => {
    const r = await setItrStatus({ id, updatedAt, status: "final" })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    for (const w of r.warnings ?? []) toast.warning(w)
    toast.success("Marked final. The computation is locked.")
    router.refresh()
  }

  return (
    <>
      <Button variant="outline" asChild>
        <a href={`/api/pdf/itr/${id}`} target="_blank" rel="noopener">
          <FileDownIcon aria-hidden="true" />
          PDF
        </a>
      </Button>
      {a.edit && view === "sheet" ? (
        <Button variant="outline" asChild>
          <Link href={`/workpapers/itr/${id}?view=inputs`}>
            <PencilIcon aria-hidden="true" />
            Edit inputs
          </Link>
        </Button>
      ) : null}
      {a.sendBack ? (
        <Button variant="outline" onClick={() => setDialog("back")}>
          <UndoIcon aria-hidden="true" />
          Send back to Draft
        </Button>
      ) : null}
      {a.changeRegime ? (
        <Button variant="outline" onClick={() => setDialog("regime")}>
          Change regime
        </Button>
      ) : null}
      {a.reopen ? (
        <Button variant="outline" onClick={() => setDialog("reopen")}>
          <RotateCcwIcon aria-hidden="true" />
          Reopen as draft
        </Button>
      ) : null}
      {a.review ? (
        <Button onClick={() => setDialog("review")}>
          <CheckCheckIcon aria-hidden="true" />
          Mark reviewed
        </Button>
      ) : a.finalise ? (
        <Button onClick={() => setDialog("final")}>
          <LockIcon aria-hidden="true" />
          Mark final
        </Button>
      ) : null}

      {dialog === "review" || dialog === "regime" ? (
        <RegimeDialog
          id={id}
          updatedAt={updatedAt}
          recommended={recommended}
          current={dialog === "regime" ? chosen : null}
          totals={totals}
          mode={dialog}
          hasBusiness={hasBusiness}
          onClose={() => setDialog(null)}
          onDone={() => router.refresh()}
        />
      ) : null}
      {dialog === "back" || dialog === "reopen" ? (
        <NoteDialog id={id} updatedAt={updatedAt} mode={dialog} onClose={() => setDialog(null)} onDone={() => router.refresh()} />
      ) : null}
      <ConfirmDialog
        open={dialog === "final"}
        onOpenChange={(o) => setDialog(o ? "final" : null)}
        title="Mark this computation final?"
        description={`The return is filed on this computation under the ${chosen ? REGIME_LABEL[chosen].toLowerCase() : "chosen regime"}. Its figures are locked; a Manager or Partner can reopen it as a draft if something changes.`}
        confirmLabel="Mark final"
        onConfirm={finalise}
      />
    </>
  )
}

function RegimeField({ control, recommended, totals }: { control: Control<FieldValues>; recommended: Regime | null; totals: Totals | null }) {
  const { field, fieldState } = useController({ control, name: "regime" })
  const id = React.useId()
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text">
        Regime chosen <span className="text-danger-text">*</span>
      </legend>
      <RadioGroup value={(field.value as string) ?? ""} onValueChange={(v) => field.onChange(v)} aria-invalid={fieldState.error ? true : undefined} className="gap-2">
        {(["new", "old"] as const).map((r) => (
          <label key={r} htmlFor={`${id}-${r}`} className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem id={`${id}-${r}`} value={r} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block text-base font-medium text-text">
                {REGIME_LABEL[r]}
                {r === recommended ? <span className="ml-2 text-sm font-normal text-success-text">Recommended</span> : null}
              </span>
              {totals ? <span className="num block text-sm text-text-muted">Tax and interest {taxAmount(totals[r])}</span> : null}
            </span>
          </label>
        ))}
      </RadioGroup>
      {fieldState.error ? <p className="text-sm text-danger-text">{fieldState.error.message}</p> : null}
    </fieldset>
  )
}

function RegimeDialog({
  id,
  updatedAt,
  recommended,
  current,
  totals,
  mode,
  hasBusiness,
  onClose,
  onDone,
}: {
  id: string
  updatedAt: string
  recommended: Regime | null
  current: Regime | null
  totals: Totals | null
  mode: "review" | "regime"
  hasBusiness: boolean
  onClose: () => void
  onDone: () => void
}) {
  const f = useActionForm(ItrStatusSchema, setItrStatus, {
    defaultValues: { id, updatedAt, status: "reviewed", regime: current ?? recommended ?? "new", note: "" },
    successMessage: mode === "review" ? "Marked reviewed." : "Regime chosen updated.",
    onSuccess: () => {
      onClose()
      onDone()
    },
  })
  const control = f.control as unknown as Control<FieldValues>
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={mode === "review" ? "Mark the computation reviewed" : "Change the regime chosen"}
      description="You record the regime the return will be filed under. A Manager or Partner then marks it final."
      onSubmit={f.onSubmit}
      pending={f.pending}
      submitLabel={mode === "review" ? "Mark reviewed" : "Save the choice"}
    >
      <FormAlert state={f} />
      <RegimeField control={control} recommended={recommended} totals={totals} />
      {hasBusiness ? (
        <p className="mt-3 text-sm text-text-muted">
          With business or professional income, choosing the old regime needs the declaration (Form 10-IEA under the 1961 Act) by the due date, and a return to the new regime can be made only once.
        </p>
      ) : null}
    </FormDialog>
  )
}

function NoteDialog({ id, updatedAt, mode, onClose, onDone }: { id: string; updatedAt: string; mode: "back" | "reopen"; onClose: () => void; onDone: () => void }) {
  const f = useActionForm(ItrStatusSchema, setItrStatus, {
    defaultValues: { id, updatedAt, status: "draft", regime: null, note: "" },
    successMessage: mode === "back" ? "Sent back to Draft. The preparer is told." : "Reopened as a draft.",
    onSuccess: () => {
      onClose()
      onDone()
    },
  })
  const control = f.control as unknown as Control<FieldValues>
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={mode === "back" ? "Send back to Draft" : "Reopen the final computation"}
      description={
        mode === "back"
          ? "The review and the regime choice are cleared; the preparer sees your note and changes the figures."
          : "The computation unlocks as a draft. It is reviewed and marked final again after the change."
      }
      onSubmit={f.onSubmit}
      pending={f.pending}
      submitLabel={mode === "back" ? "Send back" : "Reopen"}
    >
      <FormAlert state={f} />
      <TextareaField control={control} name="note" label={mode === "back" ? "What should change?" : "Why reopen it?"} required rows={3} />
    </FormDialog>
  )
}

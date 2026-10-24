"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FileUpIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WizardDialog, type WizardStep } from "@/components/app/wizard"
import { FormAlert } from "@/components/app/form/form-alert"
import type { FormError } from "@/hooks/use-action-form"
import { replaceTrialBalance } from "@/server/actions/financial-statements"
import { TbColumnsStep, TbFileStep, stepFieldErrors, useTbImport } from "@/components/workpapers/fs/tb-import"

function ReplaceTbWizard({ id, clientId, fy, getUpdatedAt, onClose }: { id: string; clientId: string; fy: string; getUpdatedAt: () => string; onClose: () => void }) {
  const router = useRouter()
  const imp = useTbImport(clientId)
  const [step, setStep] = React.useState(0)
  const [pending, setPending] = React.useState(false)
  const [formError, setFormError] = React.useState<FormError | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const steps: WizardStep[] = [
    { id: "tb", title: "Trial balance", description: "The revised CSV or Excel", valid: Boolean(imp.tb && imp.inspected) },
    { id: "columns", title: "Columns", description: "Ledger, group, debit, credit", valid: Boolean(imp.inspected && !imp.errors) },
  ]

  const load = async () => {
    const payload = imp.payload()
    if (!payload) return
    setPending(true)
    setFormError(null)
    const r = await replaceTrialBalance({ id, updatedAt: getUpdatedAt(), ...payload })
    setPending(false)
    if (!r.ok) {
      const fe = stepFieldErrors(r.fieldErrors)
      setFieldErrors(fe)
      setFormError({ message: r.error, ref: r.ref })
      if (fe.file) setStep(0)
      return
    }
    for (const w of r.warnings ?? []) toast.warning(w)
    toast.success(r.data.unmapped ? `Trial balance loaded. ${r.data.unmapped} ${r.data.unmapped === 1 ? "ledger needs" : "ledgers need"} a Schedule III line.` : "Trial balance loaded. Every ledger is mapped.")
    onClose()
    router.refresh()
  }

  return (
    <WizardDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      dirty={Boolean(imp.tb)}
      title="Load a revised trial balance"
      steps={steps}
      current={step}
      onStepChange={setStep}
      onComplete={load}
      completeLabel="Load the trial balance"
      pending={pending}
    >
      <FormAlert error={formError} />
      {step === 0 ? (
        <TbFileStep
          imp={imp}
          clientId={clientId}
          fy={fy}
          error={fieldErrors.file ?? null}
          intro="The ledgers are read again from the new file. The choices made on this statement and the client's remembered mapping are applied first; the inputs and notes stay as they are."
        />
      ) : null}
      {step === 1 ? <TbColumnsStep imp={imp} fieldErrors={fieldErrors} /> : null}
    </WizardDialog>
  )
}

/**
 * "Load a revised trial balance" (§6.13): the client sends a corrected TB after adjustments. Draft
 * and reviewed statements only (a final one is reopened first); a reviewed statement goes back to
 * Draft. Unsaved changes on screen are saved first, since the ledgers are replaced.
 */
export function ReplaceTrialBalanceButton({ id, clientId, fy, getUpdatedAt, dirty }: { id: string; clientId: string; fy: string; getUpdatedAt: () => string; dirty: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [key, setKey] = React.useState(0)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          if (dirty) {
            toast.info("Save your changes before loading another trial balance.")
            return
          }
          setKey((k) => k + 1)
          setOpen(true)
        }}
      >
        <FileUpIcon aria-hidden="true" />
        Load a revised trial balance
      </Button>
      {open ? <ReplaceTbWizard key={key} id={id} clientId={clientId} fy={fy} getUpdatedAt={getUpdatedAt} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

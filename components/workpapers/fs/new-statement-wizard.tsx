"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { WizardDialog, type WizardStep } from "@/components/app/wizard"
import { FormAlert } from "@/components/app/form/form-alert"
import { DefinitionList } from "@/components/app/definition-list"
import type { FormError } from "@/hooks/use-action-form"
import { FS_STATUS_META, comparativeYear, yearEndedLabel } from "@/lib/schemas/financial-statements"
import { createFinancialStatement, getStatementContext, searchStatementClients, type StatementContext } from "@/server/actions/financial-statements"
import { WorkpaperClientPicker } from "@/components/workpapers/shared/client-picker"
import { TbColumnsStep, TbFileStep, stepFieldErrors, useTbImport } from "@/components/workpapers/fs/tb-import"

/**
 * New financial statements (§7.8.3 steps 1–4): client and financial year · the trial balance (into
 * the client's documents) · its columns (remembered per client) · create. The server reads the
 * trial balance, auto-maps every ledger to a Schedule III line (remembered choices first), builds
 * the statements with last year's comparatives and saves the draft; the person continues on the
 * statement, fixing what isn't mapped.
 */
export function NewStatementButton({ years, defaultFy, initialClient, autoOpen = false }: { years: string[]; defaultFy: string; initialClient?: { id: string; label: string } | null; autoOpen?: boolean }) {
  const [open, setOpen] = React.useState(autoOpen)
  const [key, setKey] = React.useState(0)
  return (
    <>
      <Button
        onClick={() => {
          setKey((k) => k + 1)
          setOpen(true)
        }}
      >
        <PlusIcon aria-hidden="true" />
        New statement
      </Button>
      {open ? <NewStatementWizard key={key} years={years} defaultFy={defaultFy} initialClient={initialClient ?? null} open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}

function NewStatementWizard({ years, defaultFy, initialClient, open, onOpenChange }: { years: string[]; defaultFy: string; initialClient: { id: string; label: string } | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  const ids = { client: React.useId(), fy: React.useId() }
  const [step, setStep] = React.useState(0)
  const [clientId, setClientId] = React.useState<string | null>(initialClient?.id ?? null)
  const [clientLabel, setClientLabel] = React.useState<string | undefined>(initialClient?.label)
  const [fy, setFy] = React.useState(defaultFy)
  const contextKey = clientId ? `${clientId}|${fy}` : null
  const [loaded, setLoaded] = React.useState<{ key: string; context: StatementContext | null; error: string | null } | null>(null)
  const context = loaded && loaded.key === contextKey ? loaded.context : null
  const contextError = loaded && loaded.key === contextKey ? loaded.error : null
  const loadingContext = contextKey !== null && loaded?.key !== contextKey
  const imp = useTbImport(clientId)
  const [creating, setCreating] = React.useState(false)
  const [formError, setFormError] = React.useState<FormError | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (!clientId || !contextKey) return
    let live = true
    void getStatementContext({ clientId, financialYear: fy }).then((r) => {
      if (!live) return
      setLoaded({ key: contextKey, context: r.ok ? r.data : null, error: r.ok ? null : r.error })
    })
    return () => {
      live = false
    }
  }, [clientId, fy, contextKey])

  const steps: WizardStep[] = [
    { id: "client", title: "Client and year", description: "Whose accounts, for which year", valid: Boolean(clientId && context && !context.existing && !loadingContext) },
    { id: "tb", title: "Trial balance", description: "CSV or Excel from the client's books", valid: Boolean(imp.tb && imp.inspected) },
    { id: "columns", title: "Columns", description: "Ledger, group, debit, credit", valid: Boolean(imp.inspected && !imp.errors) },
  ]

  const create = async () => {
    const payload = imp.payload()
    if (!clientId || !payload) return
    setCreating(true)
    setFormError(null)
    const r = await createFinancialStatement({ clientId, financialYear: fy, ...payload })
    if (!r.ok) {
      setCreating(false)
      const fe = stepFieldErrors(r.fieldErrors)
      setFieldErrors(fe)
      setFormError({ message: r.error, ref: r.ref })
      if (fe.financialYear || fe.clientId) setStep(0)
      else if (fe.file) setStep(1)
      return
    }
    for (const w of r.warnings ?? []) toast.warning(w)
    toast.success(r.data.unmapped ? `Statement started. ${r.data.unmapped} ${r.data.unmapped === 1 ? "ledger needs" : "ledgers need"} a Schedule III line.` : "Statement started. Every ledger is mapped.")
    onOpenChange(false)
    router.push(`/workpapers/financial-statements/${r.data.id}${r.data.unmapped ? "?tab=ledgers" : ""}`)
  }

  const prev = context?.previous
  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={Boolean(imp.tb)}
      title="New financial statements"
      steps={steps}
      current={step}
      onStepChange={setStep}
      onComplete={create}
      completeLabel="Create the statement"
      pending={creating}
    >
      <FormAlert error={formError} />
      {step === 0 ? (
        <div className="flex max-w-xl flex-col gap-5">
          <WorkpaperClientPicker
            id={ids.client}
            value={clientId}
            selectedLabel={clientLabel}
            search={searchStatementClients}
            onChange={(id, option) => {
              if (id !== clientId) imp.reset()
              setClientId(id)
              setClientLabel(option ? `${option.label}${option.description ? ` · ${option.description}` : ""}` : undefined)
            }}
            error={contextError ?? fieldErrors.clientId ?? null}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.fy} className="text-sm font-medium text-text">
              Financial year <span className="text-danger-text">*</span>
            </label>
            <div className="[&>div]:w-full">
              <NativeSelect id={ids.fy} value={fy} onChange={(e) => setFy(e.target.value)}>
                {years.map((y) => (
                  <NativeSelectOption key={y} value={y}>
                    FY {y} (year ended {yearEndedLabel(y)})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {fieldErrors.financialYear ? <p className="text-sm text-danger-text">{fieldErrors.financialYear}</p> : null}
          </div>
          {context ? (
            context.existing ? (
              <div role="status" className="rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-base text-text">
                {context.client.name} already has a statement for FY {fy} ({FS_STATUS_META[context.existing.status].label}). One statement is kept per client and year: open it to upload a new trial balance.{" "}
                <Link href={`/workpapers/financial-statements/${context.existing.id}`} className="text-primary hover:underline">
                  Open the FY {fy} statement
                </Link>
              </div>
            ) : (
              <DefinitionList
                items={[
                  {
                    term: "Comparatives",
                    value: prev
                      ? prev.hasFigures
                        ? `From the FY ${prev.financialYear} statement (${FS_STATUS_META[prev.status].label})`
                        : `The FY ${prev.financialYear} statement has no figures yet`
                      : `No FY ${comparativeYear(fy)} statement: the previous-year column stays empty, and the profit-to-reserves check is skipped`,
                  },
                ]}
              />
            )
          ) : null}
        </div>
      ) : null}

      {step === 1 && clientId ? <TbFileStep imp={imp} clientId={clientId} fy={fy} error={fieldErrors.file ?? null} /> : null}

      {step === 2 ? <TbColumnsStep imp={imp} fieldErrors={fieldErrors} /> : null}
    </WizardDialog>
  )
}

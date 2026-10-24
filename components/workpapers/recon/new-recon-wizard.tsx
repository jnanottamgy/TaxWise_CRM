"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangleIcon, GitCompareArrowsIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { WizardDialog, type WizardStep } from "@/components/app/wizard"
import { FormAlert } from "@/components/app/form/form-alert"
import { DefinitionList } from "@/components/app/definition-list"
import { formatCount } from "@/components/app/data-table/params"
import type { FormError } from "@/hooks/use-action-form"
import { formatDateTime } from "@/lib/format"
import { REGISTER_FIELD_SPECS, validateColumnMapping, type MappingSource, type RegisterField } from "@/lib/domain/gstr2b"
import { periodChoices, periodFinancialYear, periodLabel, periodLongLabel, type RegisterMapping } from "@/lib/schemas/gst-recon"
import { getReconContext, inspectRegister, runGstRecon, searchReconClients, type InspectedRegister, type ReconContext } from "@/server/actions/gst-recon"
import { WorkpaperClientPicker } from "@/components/workpapers/shared/client-picker"
import { SheetUpload, type UploadedSheet } from "@/components/workpapers/shared/sheet-upload"
import { ColumnMappingStep } from "@/components/workpapers/shared/column-mapping"
import { Gstr2bUpload, type UploadedGstr2b } from "@/components/workpapers/recon/gstr2b-upload"

type Initial = { clientId?: string | null; clientLabel?: string | null; period: string }

const EMPTY_MAPPING = Object.fromEntries(REGISTER_FIELD_SPECS.map((s) => [s.field, null])) as RegisterMapping

/**
 * New GST reconciliation (§7.8.1): 1 client and month · 2 the GSTR-2B JSON · 3 the purchase
 * register (into the client's documents, category GST) · 4 map the register's columns (remembered
 * per client) · 5 run. The server reads both stored files back, reconciles them and saves the run
 * with every line; the person lands on the results. Full-screen, with Back / Continue / Run always
 * visible (§0.1 rule 4).
 */
export function NewReconButton({ today, initial, autoOpen = false, label = "New reconciliation", variant = "default" }: { today: string; initial: Initial; autoOpen?: boolean; label?: string; variant?: "default" | "outline" }) {
  const [open, setOpen] = React.useState(autoOpen)
  const [key, setKey] = React.useState(0)
  return (
    <>
      <Button
        variant={variant}
        onClick={() => {
          setKey((k) => k + 1)
          setOpen(true)
        }}
      >
        {variant === "default" ? <PlusIcon aria-hidden="true" /> : <GitCompareArrowsIcon aria-hidden="true" />}
        {label}
      </Button>
      {open ? <NewReconWizard key={key} today={today} initial={initial} open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}

function NewReconWizard({ today, initial, open, onOpenChange }: { today: string; initial: Initial; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  const ids = { client: React.useId(), period: React.useId() }
  const [step, setStep] = React.useState(0)
  const [clientId, setClientId] = React.useState<string | null>(initial.clientId ?? null)
  const [clientLabel, setClientLabel] = React.useState<string | undefined>(initial.clientLabel ?? undefined)
  const [period, setPeriod] = React.useState(initial.period)
  const contextKey = clientId ? `${clientId}|${period}` : null
  const [loaded, setLoaded] = React.useState<{ key: string; context: ReconContext | null; error: string | null } | null>(null)
  const context = loaded && loaded.key === contextKey ? loaded.context : null
  const contextError = loaded && loaded.key === contextKey ? loaded.error : null
  const loadingContext = contextKey !== null && loaded?.key !== contextKey
  const [gstr2b, setGstr2b] = React.useState<UploadedGstr2b | null>(null)
  const [register, setRegister] = React.useState<UploadedSheet | null>(null)
  const [inspected, setInspected] = React.useState<InspectedRegister | null>(null)
  const [inspecting, setInspecting] = React.useState(false)
  const [mapping, setMapping] = React.useState<RegisterMapping>(EMPTY_MAPPING)
  const [sources, setSources] = React.useState<Partial<Record<RegisterField, MappingSource | null>>>({})
  const [remember, setRemember] = React.useState(true)
  const [running, setRunning] = React.useState(false)
  const [formError, setFormError] = React.useState<FormError | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})

  const choices = React.useMemo(() => periodChoices(today), [today])

  // The client and month decide the GSTIN check, an earlier run, and what carries forward.
  React.useEffect(() => {
    if (!clientId || !contextKey) return
    let live = true
    void getReconContext({ clientId, period }).then((r) => {
      if (!live) return
      setLoaded({ key: contextKey, context: r.ok ? r.data : null, error: r.ok ? null : r.error })
    })
    return () => {
      live = false
    }
  }, [clientId, period, contextKey])

  const inspect = React.useCallback(
    async (file: UploadedSheet, opts: { sheet?: string | null; headerRow?: number | null; keepMapping?: boolean } = {}) => {
      if (!clientId) return
      setInspecting(true)
      setFieldErrors((e) => ({ ...e, register: "" }))
      const r = await inspectRegister({ clientId, documentId: file.documentId, sheet: opts.sheet ?? null, headerRow: opts.headerRow ?? null })
      setInspecting(false)
      if (!r.ok) {
        setInspected(null)
        setFieldErrors((e) => ({ ...e, register: r.fieldErrors?.register?.[0] ?? r.error }))
        return
      }
      setInspected(r.data)
      if (!opts.keepMapping) {
        setMapping({ ...EMPTY_MAPPING, ...r.data.suggestion.mapping })
        setSources(r.data.suggestion.sources)
      } else {
        // Keep the person's choices that are still columns of the file.
        setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v && r.data.headers.includes(v) ? v : (r.data.suggestion.mapping[k as RegisterField] ?? null)])) as RegisterMapping)
      }
    },
    [clientId],
  )

  const mappingErrors = React.useMemo(() => {
    if (!inspected) return null
    return validateColumnMapping(mapping, inspected.headers, REGISTER_FIELD_SPECS)
  }, [mapping, inspected])

  const periodOk = !gstr2b?.preview.period || gstr2b.preview.period === period
  const steps: WizardStep[] = [
    { id: "client", title: "Client and month", description: "Whose purchases, for which month", valid: Boolean(clientId && context && !loadingContext) },
    { id: "gstr2b", title: "GSTR-2B", description: "The JSON from the GST portal", valid: Boolean(gstr2b && periodOk) },
    { id: "register", title: "Purchase register", description: "CSV or Excel from the client", valid: Boolean(register && inspected) },
    { id: "columns", title: "Columns", description: "Which column holds what", valid: Boolean(inspected && !mappingErrors) },
    { id: "run", title: "Run", description: "Match and save the results", valid: true },
  ]

  const resetFiles = () => {
    setGstr2b(null)
    setRegister(null)
    setInspected(null)
    setMapping(EMPTY_MAPPING)
    setSources({})
  }

  const run = async () => {
    if (!clientId || !gstr2b || !register || !inspected) return
    setRunning(true)
    setFormError(null)
    const r = await runGstRecon({
      clientId,
      period,
      gstr2b: gstr2b.source,
      register: { documentId: register.documentId, sheet: inspected.sheet, headerRow: inspected.headerRow },
      mapping,
      rememberMapping: remember,
    })
    if (!r.ok) {
      setRunning(false)
      const fe: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.fieldErrors ?? {})) fe[k.startsWith("mapping.") ? k.slice(8) : k] = v[0]
      setFieldErrors(fe)
      setFormError({ message: r.error, ref: r.ref })
      if (fe.period) setStep(0)
      else if (fe.gstr2b) setStep(1)
      else if (fe.register) setStep(2)
      else if (Object.keys(fe).some((k) => (REGISTER_FIELD_SPECS as readonly { field: string }[]).some((s) => s.field === k))) setStep(3)
      return
    }
    for (const w of r.warnings ?? []) toast.warning(w)
    toast.success(`Reconciled ${periodLabel(period)}: ${formatCount(r.data.entries)} lines saved${r.data.carried ? `, ${r.data.carried} carried forward` : ""}.`)
    onOpenChange(false)
    router.push(`/workpapers/gst-recon/${r.data.id}`)
  }

  const fy = periodFinancialYear(period)
  const dirty = Boolean(gstr2b || register)
  const gstinMissing = context && !context.client.gstin

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={dirty}
      title="New GST reconciliation"
      steps={steps}
      current={step}
      onStepChange={setStep}
      onComplete={run}
      completeLabel="Run the reconciliation"
      pending={running}
    >
      <FormAlert error={formError} />
      {step === 0 ? (
        <div className="flex max-w-xl flex-col gap-5">
          <WorkpaperClientPicker
            id={ids.client}
            value={clientId}
            selectedLabel={clientLabel}
            search={searchReconClients}
            onChange={(id, option) => {
              if (id !== clientId) resetFiles()
              setClientId(id)
              setClientLabel(option ? `${option.label}${option.description ? ` · ${option.description}` : ""}` : undefined)
            }}
            error={contextError ?? fieldErrors.clientId ?? null}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.period} className="text-sm font-medium text-text">
              Month <span className="text-danger-text">*</span>
            </label>
            <div className="[&>div]:w-full">
              <NativeSelect
                id={ids.period}
                value={period}
                aria-invalid={fieldErrors.period ? true : undefined}
                onChange={(e) => {
                  setPeriod(e.target.value)
                  setFieldErrors((f) => ({ ...f, period: "" }))
                }}
              >
                {choices.map((c) => (
                  <NativeSelectOption key={c.value} value={c.value}>
                    {c.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {fieldErrors.period ? <p className="text-sm text-danger-text">{fieldErrors.period}</p> : <p className="text-sm text-text-muted">The return period of the GSTR-2B. FY {fy}.</p>}
          </div>
          {context ? (
            <div className="flex flex-col gap-3">
              <DefinitionList
                items={[
                  { term: "Client GSTIN", value: context.client.gstin ?? <span className="text-warning-text">Not on file</span> },
                  {
                    term: "Carried forward",
                    value: context.previous
                      ? context.previous.openCount > 0
                        ? `${formatCount(context.previous.openCount)} open ${context.previous.openCount === 1 ? "line" : "lines"} from ${periodLongLabel(context.previous.period)}`
                        : `Nothing open from ${periodLongLabel(context.previous.period)}`
                      : "No earlier reconciliation for this client",
                  },
                ]}
              />
              {gstinMissing ? (
                <p className="flex items-start gap-2 text-sm text-warning-text">
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
                  The client has no GSTIN on file, so the GSTR-2B can&apos;t be checked against it. Add it on the client&apos;s profile.
                </p>
              ) : null}
              {context.latest ? (
                <div className="rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-sm text-text">
                  {periodLongLabel(period)} was reconciled on {formatDateTime(context.latest.createdAt)}
                  {context.latest.createdByName ? ` by ${context.latest.createdByName}` : ""}. Running it again saves a new run; the earlier one stays in the history, and its
                  resolutions and IMS decisions carry over to the same lines.{" "}
                  <Link href={`/workpapers/gst-recon/${context.latest.id}`} className="text-primary hover:underline">
                    Open the earlier run
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 1 && clientId ? (
        <div className="flex max-w-2xl flex-col gap-3">
          <h3 className="text-md font-semibold text-text">GSTR-2B for {periodLongLabel(period)}</h3>
          <Gstr2bUpload
            clientId={clientId}
            clientGstin={context?.client.gstin ?? null}
            period={period}
            uploaded={gstr2b}
            onUploaded={(u) => {
              setGstr2b(u)
              setFieldErrors((f) => ({ ...f, gstr2b: "" }))
            }}
            onReplace={() => setGstr2b(null)}
            onUsePeriod={(p) => setPeriod(p)}
            error={fieldErrors.gstr2b || null}
          />
        </div>
      ) : null}

      {step === 2 && clientId ? (
        <div className="flex max-w-2xl flex-col gap-3">
          <h3 className="text-md font-semibold text-text">Purchase register for {periodLongLabel(period)}</h3>
          <p className="text-sm text-text-muted">Every purchase document the client booked for the month: invoices, debit and credit notes. It is saved in the client&apos;s documents under GST.</p>
          <SheetUpload
            clientId={clientId}
            title={`Purchase register · ${periodLabel(period)}`}
            category="gst"
            financialYear={fy}
            period={periodLabel(period)}
            tags={["GST reconciliation"]}
            uploaded={register}
            label="Drop the purchase register here, or choose it."
            onUploaded={(f) => {
              setRegister(f)
              void inspect(f)
            }}
            onReplace={() => {
              setRegister(null)
              setInspected(null)
            }}
            error={fieldErrors.register || null}
          />
          {register && inspecting ? <p className="text-sm text-text-muted">Reading the register…</p> : null}
          {register && inspected ? (
            <p className="text-sm text-text-muted">
              Read {formatCount(inspected.rowCount)} rows under the header on row {inspected.headerRow}
              {inspected.sheet ? ` of the sheet “${inspected.sheet}”` : ""}. Check the columns next.
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 3 && inspected && register ? (
        <ColumnMappingStep
          what="Purchase register"
          fileName={inspected.fileName}
          specs={REGISTER_FIELD_SPECS}
          headers={inspected.headers}
          preview={inspected.preview}
          rowCount={inspected.rowCount}
          truncated={inspected.truncated}
          mapping={mapping}
          sources={sources}
          onChange={(field, header) => {
            setMapping((m) => ({ ...m, [field]: header }))
            setSources((s) => ({ ...s, [field]: null }))
            setFieldErrors((f) => ({ ...f, [field]: "" }))
          }}
          errors={Object.fromEntries(REGISTER_FIELD_SPECS.map((s) => [s.field, fieldErrors[s.field] || undefined])) as Partial<Record<RegisterField, string>>}
          sheets={inspected.sheets}
          sheet={inspected.sheet}
          onSheetChange={(sheet) => void inspect(register, { sheet })}
          headerRow={inspected.headerRow}
          onHeaderRowChange={(row) => void inspect(register, { sheet: inspected.sheet, headerRow: row, keepMapping: true })}
          busy={inspecting}
          remember={remember}
          onRememberChange={setRemember}
          remembered={inspected.remembered}
          note="Taxable value and at least the tax heads the register has (IGST, or CGST and SGST). Document type is optional: negative amounts are read as credit notes."
        />
      ) : null}

      {step === 4 && clientId && gstr2b && register && inspected ? (
        <div className="flex max-w-2xl flex-col gap-4">
          <h3 className="text-md font-semibold text-text">Ready to reconcile</h3>
          <DefinitionList
            items={[
              { term: "Client", value: context?.client.name ?? clientLabel ?? "" },
              { term: "Month", value: periodLongLabel(period) },
              { term: "GSTR-2B", value: `${gstr2b.source.fileName} · ${formatCount(gstr2b.preview.documents)} documents` },
              { term: "Purchase register", value: `${inspected.fileName} · ${formatCount(inspected.rowCount)} rows` },
              {
                term: "Carried forward",
                value: context?.previous && context.previous.openCount > 0 ? `${formatCount(context.previous.openCount)} open lines from ${periodLongLabel(context.previous.period)} are checked against these files` : "Nothing to carry forward",
              },
            ]}
          />
          <p className="text-sm text-text-muted">
            Documents are matched per supplier GSTIN on the document number, then on the number written differently, then on amount (±₹1 or 0.5%) and date (5 days). A pair within ₹1 on every
            tax head is Matched.
          </p>
        </div>
      ) : null}
    </WizardDialog>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, useFieldArray, useWatch, type Control } from "react-hook-form"
import { toast } from "sonner"
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { useActionForm } from "@/hooks/use-action-form"
import { useAutosave } from "@/hooks/use-autosave"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, MoneyField, SelectField, SwitchField, TextField } from "@/components/app/form/fields"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { SectionCard } from "@/components/app/section-card"
import { DraftStamp } from "@/components/app/draft-stamp"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { formatDate } from "@/lib/format"
import { taxYearLabel, type FinancialYear } from "@/lib/domain/fy"
import type { AssesseeType } from "@/lib/domain/itr"
import { AGE_BANDS, AGE_BAND_LABELS, type AgeBand, type ItrRuleSet } from "@/lib/domain/itr-rulesets"
import {
  ItrFormSchema,
  RETURN_KINDS,
  RETURN_KIND_LABEL,
  ageBandFor,
  computeStored,
  formToStoredInputs,
  type ItrFormInput,
  type ItrStatus,
  type ReturnDueDate,
  type ReturnKind,
} from "@/lib/schemas/itr"
import { deleteItrComputation, getItrClientContext, saveItrComputation, searchItrClients, type SavedItr } from "@/server/actions/itr"
import { ItrComparison, ItrSheet } from "@/components/workpapers/itr/itr-sheet"
import { BalanceText, TaxFigure } from "@/components/workpapers/itr/itr-ui"
import { REGIME_LABEL } from "@/lib/schemas/itr"

export type ItrEditorClient = {
  id: string
  label: string
  assesseeType: AssesseeType
  dateOfBirth: string | null
  taxAuditApplicable: string | null
}

export type ItrEditorProps = {
  mode: "new" | "edit"
  initial: ItrFormInput
  computation: { id: string; status: ItrStatus; updatedAt: string } | null
  client: ItrEditorClient | null
  fyOptions: FinancialYear[]
  ruleSets: Record<string, ItrRuleSet>
  dueDates: Record<string, Partial<Record<ReturnKind, ReturnDueDate>>>
  canDelete: boolean
}

type Form = ItrFormInput

let keySeq = 0
const nextKey = () => `sa${Date.now().toString(36)}${(keySeq++).toString(36)}`

const QUARTERS: Array<{ key: "q1" | "q2" | "q3" | "q4" | "afterQ4"; label: string; helper: string }> = [
  { key: "q1", label: "Advance tax: 1st instalment", helper: "Paid on or before 15 June" },
  { key: "q2", label: "2nd instalment", helper: "16 June to 15 September" },
  { key: "q3", label: "3rd instalment", helper: "16 September to 15 December" },
  { key: "q4", label: "4th instalment", helper: "16 December to 15 March" },
  { key: "afterQ4", label: "Paid 16–31 March", helper: "Counts as advance tax, not for the instalments" },
]

/**
 * The ITR computation editor (§7.8.2): client (individuals and HUFs), FY, age band (from the date
 * of birth, overridable), the income heads, the old-regime deductions, employer NPS (both regimes),
 * taxes paid by instalment, and the filing and due dates for interest. Beside it, the live
 * comparison from the same engine the server runs; the saved figures are always recomputed on the
 * server. A draft autosaves to the server every 5 seconds (§3.4) with "Draft saved · 12:41" in the
 * sticky footer.
 */
export function ItrEditor({ mode, initial, computation, client: initialClient, fyOptions, ruleSets, dueDates, canDelete }: ItrEditorProps) {
  const router = useRouter()
  const [client, setClient] = React.useState<ItrEditorClient | null>(initialClient)
  const [loadingClient, setLoadingClient] = React.useState(false)
  const [status, setStatus] = React.useState<ItrStatus>(computation?.status ?? "draft")
  const idRef = React.useRef<string | null>(computation?.id ?? null)
  const [savedId, setSavedId] = React.useState<string | null>(computation?.id ?? null)
  const updatedAtRef = React.useRef<string | null>(computation?.updatedAt ?? null)
  const chain = React.useRef<Promise<unknown>>(Promise.resolve())
  const intentRef = React.useRef<"stay" | "view">("view")
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const locked = mode === "edit" || savedId !== null

  const queued = React.useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(fn, fn)
    chain.current = run.catch(() => undefined)
    return run
  }, [])

  const afterSave = React.useCallback((r: SavedItr) => {
    const created = !idRef.current
    idRef.current = r.id
    setSavedId(r.id)
    updatedAtRef.current = r.updatedAt
    setStatus(r.status)
    if (created && typeof window !== "undefined") window.history.replaceState(null, "", `/workpapers/itr/${r.id}?view=inputs`)
  }, [])

  const f = useActionForm(
    ItrFormSchema,
    (values: Form) =>
      queued(async () => {
        const r = await saveItrComputation({ ...values, id: idRef.current, updated_at: updatedAtRef.current, intent: "save" })
        if (r.ok) afterSave(r.data)
        return r
      }),
    {
      defaultValues: initial,
      onSuccess: (r) => {
        if (r.backToDraft) toast.info("Saved. The figures changed, so the computation is back in Draft for a fresh review.")
        else toast.success("Saved and recomputed.")
        draft.clear()
        if (intentRef.current === "view") {
          setDone(true)
          router.push(`/workpapers/itr/${r.id}?view=sheet`)
        } else {
          router.refresh()
        }
      },
    },
  )
  const { control, setValue, getValues } = f.form
  const sa = useFieldArray({ control, name: "taxesPaid.selfAssessment", keyName: "_k" as never })
  const watched = useWatch({ control }) as Form
  const isDirty = f.form.formState.isDirty
  const fy = String(watched.financial_year ?? "")
  const ruleSet = ruleSets[fy] ?? null
  const huf = client?.assesseeType === "huf"
  const kind = (watched.return_kind ?? "non_business") as ReturnKind
  const yearDue = dueDates[fy] ?? {}

  // ---- The live preview (the same engine the server runs) -----------------------------------
  const watchedKey = JSON.stringify(watched)
  const preview = React.useMemo(() => {
    if (!client || !ruleSet) return null
    const parsed = ItrFormSchema.safeParse(JSON.parse(watchedKey) as unknown)
    if (!parsed.success) return { ok: false as const, message: "Complete the dates to see the computation." }
    const stored = formToStoredInputs(parsed.data, client.assesseeType)
    if (!stored.ok) return { ok: false as const, message: Object.values(stored.fieldErrors)[0]?.[0] ?? "Check the highlighted figures." }
    const c = computeStored(stored.stored, ruleSet)
    if (!c.ok) return { ok: false as const, message: Object.values(c.fieldErrors)[0]?.[0] ?? "Check the figures." }
    return { ok: true as const, result: c.result }
  }, [watchedKey, client, ruleSet])

  const autosaveOn = status === "draft" && isDirty && !done && Boolean(client) && Boolean(ruleSet) && preview?.ok === true
  const draft = useAutosave({
    key: `itr:${computation?.id ?? "new"}`,
    value: watched,
    enabled: autosaveOn,
    onServerSave: async (v) => {
      const r = await queued(() => saveItrComputation({ ...(v as Form), id: idRef.current, updated_at: updatedAtRef.current, intent: "autosave" }))
      if (r.ok) {
        afterSave(r.data)
        const now = f.form.getValues()
        if (JSON.stringify(now) === JSON.stringify(v)) f.form.reset(now, { keepErrors: true, keepTouched: true, keepIsSubmitted: true })
        return { ok: true }
      }
      return { ok: false, error: r.code === "conflict" ? r.error : `Couldn't save the draft: ${r.error}` }
    },
  })

  // ---- Client, year, age band and due date ------------------------------------------------------
  const applyDefaults = React.useCallback(
    (next: { fy: string; client: ItrEditorClient | null; kind?: ReturnKind }) => {
      const k = next.kind ?? ((getValues("return_kind") ?? "non_business") as ReturnKind)
      if (getValues("due_date_source") !== "manual") {
        const due = dueDates[next.fy]?.[k]
        if (due) setValue("due_date", due.date, { shouldDirty: true })
      }
      if (next.client && getValues("age_band_source") !== "manual") {
        const band = next.client.assesseeType === "huf" ? "below_60" : ageBandFor(next.client.dateOfBirth, next.fy)
        if (band) setValue("age_band", band, { shouldDirty: true })
      }
    },
    [dueDates, getValues, setValue],
  )

  const loadClient = async (id: string | null, label?: string) => {
    if (!id) {
      setClient(null)
      return
    }
    setLoadingClient(true)
    try {
      const r = await getItrClientContext({ clientId: id, financialYear: fy || fyOptions[0] })
      if (!r.ok) {
        toast.error(r.error)
        setValue("client_id", "", { shouldDirty: true })
        setClient(null)
        return
      }
      const c: ItrEditorClient = {
        id: r.data.client.id,
        label: label ?? `${r.data.client.client_code} · ${r.data.client.display_name}`,
        assesseeType: r.data.client.assesseeType,
        dateOfBirth: r.data.client.date_of_birth,
        taxAuditApplicable: r.data.client.tax_audit_applicable,
      }
      setClient(c)
      if (c.assesseeType === "huf") setValue("income.salaryGross", "", { shouldDirty: true })
      const nextKind = r.data.defaultKind === "audit" ? "audit" : kind
      setValue("return_kind", nextKind, { shouldDirty: true })
      applyDefaults({ fy: fy || fyOptions[0], client: c, kind: nextKind })
    } finally {
      setLoadingClient(false)
    }
  }

  const autoBand: AgeBand | null = client ? (huf ? "below_60" : ageBandFor(client.dateOfBirth, fy)) : null
  const bandManual = watched.age_band_source === "manual"
  const dueManual = watched.due_date_source === "manual"
  const ruleDue = yearDue[kind] ?? null
  const hasBusiness = String(watched.income?.businessProfession ?? "").trim() !== "" && String(watched.income?.businessProfession) !== "0"
  const seniorBand = (watched.age_band ?? "below_60") !== "below_60"
  const earlierRates = ruleSet?.capitalGains.earlierRates ? ruleSet.capitalGains : null

  const reviewed = status === "reviewed"
  const primaryLabel = reviewed ? "Save and send back to Draft" : "Save and view computation"

  const submit = (intent: "stay" | "view", e?: React.BaseSyntheticEvent) => {
    intentRef.current = intent
    return f.onSubmit(e)
  }

  return (
    <form onSubmit={(e) => void submit("view", e)} noValidate className="flex min-w-0 flex-col">
      <UnsavedChangesGuard when={isDirty && !done} />
      <FormAlert state={f} />
      {reviewed ? (
        <div role="note" className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-base text-text">
          This computation is reviewed. Saving changed figures sends it back to Draft for a fresh review, and the regime choice goes with the review. Nothing is saved until you press Save.
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          <SectionCard title="Client and year" description="Individuals and HUFs (a proprietor files as an individual).">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {locked ? (
                <div className="flex flex-col gap-1.5 md:col-span-2">
                  <span className="text-sm font-medium text-text">Client</span>
                  <p className="flex min-h-9 items-center rounded-md border border-border bg-surface-2 px-3 text-base text-text">{client?.label ?? "This client"}</p>
                </div>
              ) : (
                <ComboboxField
                  control={control}
                  name="client_id"
                  label="Client"
                  required
                  className="md:col-span-2"
                  placeholder="Choose an individual or HUF"
                  searchPlaceholder="Name, code or PAN"
                  emptyText="No individual or HUF client matches. Employees see only their own clients."
                  selectedLabel={client?.label}
                  loadOptions={async (q: string) => {
                    const r = await searchItrClients({ q })
                    return r.ok ? r.data : []
                  }}
                  onSelectOption={(o) => void loadClient(o?.value ?? null, o?.label)}
                  helper={loadingClient ? "Loading the client's details…" : client ? (huf ? "Hindu undivided family" : "Individual") : undefined}
                />
              )}
              {locked ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-text">Financial year</span>
                  <p className="flex h-9 items-center rounded-md border border-border bg-surface-2 px-3 text-base text-text">
                    FY {fy} · {taxYearLabel(fy)}
                  </p>
                </div>
              ) : (
                <SelectField
                  control={control}
                  name="financial_year"
                  label="Financial year"
                  required
                  options={fyOptions.map((y) => ({ value: y, label: `FY ${y} · ${taxYearLabel(y)}` }))}
                  helper={fyOptions.length ? "Years with an income-tax rule set on the Law & rules page." : "No rule set is recorded yet. A Partner adds it under Settings → Law & rules."}
                />
              )}
              <TextField control={control} name="label" label="Name" placeholder="For example: Return as filed" helper="Optional, to tell several computations of a year apart." />
              {!huf ? (
                <div className="flex flex-col gap-1.5">
                  <SelectField
                    control={control}
                    name="age_band"
                    label="Age band"
                    required
                    options={AGE_BANDS.map((b) => ({ value: b, label: AGE_BAND_LABELS[b] }))}
                    helper={
                      bandManual ? (
                        <>
                          Set by hand.{" "}
                          {autoBand ? (
                            <button
                              type="button"
                              className="font-medium text-text underline-offset-4 hover:underline"
                              onClick={() => {
                                setValue("age_band_source", "auto", { shouldDirty: true })
                                setValue("age_band", autoBand, { shouldDirty: true })
                              }}
                            >
                              Use the date of birth
                            </button>
                          ) : null}
                        </>
                      ) : client?.dateOfBirth ? (
                        `From the date of birth, ${formatDate(client.dateOfBirth)}: the age by 31 March.`
                      ) : (
                        "No date of birth on the client's profile. Choose the band, or add the date of birth."
                      )
                    }
                  />
                  <AgeBandWatcher control={control} autoBand={autoBand} onManual={() => setValue("age_band_source", "manual", { shouldDirty: true })} />
                </div>
              ) : null}
              <SwitchField control={control} name="resident" label="Resident in India" description="A non-resident gets no rebate and no senior-citizen slabs." className="md:col-span-2" />
              <FyWatcher control={control} onChange={(next) => applyDefaults({ fy: next, client })} />
            </div>
          </SectionCard>

          <SectionCard title="Income" description="Enter each head as computed. Leave a head blank if the client has none.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {!huf ? (
                <>
                  <MoneyField control={control} name="income.salaryGross" label="Salary or pension (gross)" helper="Before the standard deduction." />
                  <MoneyField control={control} name="income.salaryOldRegimeExemptions" label="Salary exemptions (old regime only)" helper="HRA, LTA and the like u/s 10, and professional tax." />
                </>
              ) : null}
              <MoneyField control={control} name="income.houseProperty" label="House property (net)" allowNegative helper="After 30% and interest. Enter a loss with a minus sign." />
              <MoneyField control={control} name="income.businessProfession" label="Business or profession" />
              {hasBusiness ? (
                <SwitchField
                  control={control}
                  name="presumptive"
                  label="Presumptive income (44AD / 44ADA)"
                  description="Advance tax is then due in one instalment by 15 March."
                  className="md:col-span-2"
                />
              ) : null}
              <MoneyField control={control} name="income.otherSources" label="Other sources" helper="Interest, dividends and the like, in total." />
              <MoneyField control={control} name="income.dividends" label="Of which dividends" helper="Their surcharge is capped at 15%." />
              <MoneyField control={control} name="income.stcg111a" label="Short-term gains on listed equity (111A)" />
              <MoneyField control={control} name="income.ltcg112a" label="Long-term gains on listed equity (112A)" helper="Before the annual exemption; the sheet applies it." />
              <MoneyField control={control} name="income.ltcg112" label="Other long-term gains (112)" />
            </div>
            {earlierRates ? (
              <fieldset className="mt-5 rounded-md border border-border px-4 pt-3 pb-4">
                <legend className="px-1 text-sm font-medium text-text">Gains on transfers before {formatDate(earlierRates.cutoverDate)}</legend>
                <p className="mb-3 text-sm text-text-muted">The earlier rates apply to these. Enter the rest in the fields above.</p>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <MoneyField control={control} name="income.earlierTransfers.stcg111a" label="111A, earlier" />
                  <MoneyField control={control} name="income.earlierTransfers.ltcg112a" label="112A, earlier" />
                  <MoneyField control={control} name="income.earlierTransfers.ltcg112" label="112, earlier" />
                </div>
              </fieldset>
            ) : null}
          </SectionCard>

          <SectionCard title="Deductions (old regime only)" description="Amounts claimed; the sheet applies each limit and shows what is allowed.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <MoneyField control={control} name="deductions.sec80CBasket" label="80C, 80CCC and 80CCD(1)" helper="The basket together." />
              {!huf ? <MoneyField control={control} name="deductions.sec80CCD1B" label="Own NPS contribution, 80CCD(1B)" /> : null}
              <MoneyField control={control} name="deductions.sec80D.selfFamily" label="Health insurance: self and family (80D)" />
              <div className="flex flex-col gap-2">
                <MoneyField control={control} name="deductions.sec80D.parents" label="Health insurance: parents (80D)" />
                <ParentsSeniorCheckbox control={control} />
              </div>
              <MoneyField control={control} name="deductions.sec80G" label="Donations, qualifying amount (80G)" helper="After the 50%/100% and 10%-of-income limits." />
              <MoneyField
                control={control}
                name="deductions.sec80TTA_TTB"
                label={seniorBand && !huf ? "Deposit interest (80TTB)" : "Savings interest (80TTA)"}
                helper={seniorBand && !huf ? "Resident senior citizens." : undefined}
              />
              <MoneyField control={control} name="deductions.otherOldRegime" label="Other Chapter VI-A deductions" helper="80E, 80EEA, 80U and the like, within their own limits." />
            </div>
          </SectionCard>

          <SectionCard title="Allowed in both regimes">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {!huf ? (
                <>
                  <MoneyField control={control} name="deductions.employerNps80CCD2" label="Employer NPS contribution, 80CCD(2)" />
                  <MoneyField control={control} name="deductions.basicPlusDa" label="Basic salary + DA" helper="For the 80CCD(2) limit; gross salary is used when blank." />
                  <SwitchField control={control} name="deductions.governmentEmployer" label="Central or State Government employer" className="md:col-span-2" />
                </>
              ) : null}
              <MoneyField control={control} name="deductions.otherBothRegimes" label="Other deductions both regimes allow" helper="80CCH, 80JJAA, within their own limits." />
            </div>
          </SectionCard>

          <SectionCard title="Taxes paid">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <MoneyField control={control} name="taxesPaid.tdsTcs" label="TDS and TCS" helper="As in Form 26AS / AIS." className="md:col-span-2" />
              {QUARTERS.map((q) => (
                <MoneyField key={q.key} control={control} name={`taxesPaid.advanceTax.${q.key}`} label={q.label} helper={q.helper} />
              ))}
            </div>
            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-text">Self-assessment tax</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => sa.append({ key: nextKey(), amount: "", paidOn: "" })} disabled={sa.fields.length >= 12}>
                  <PlusIcon aria-hidden="true" />
                  Add payment
                </Button>
              </div>
              {sa.fields.length === 0 ? (
                <p className="mt-2 text-sm text-text-muted">None paid yet. Payments made after the year ends, before filing, go here.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {sa.fields.map((row, i) => (
                    <li key={(row as unknown as { _k: string })._k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-3">
                      <MoneyField control={control} name={`taxesPaid.selfAssessment.${i}.amount`} label={`Payment ${i + 1}`} />
                      <DateField control={control} name={`taxesPaid.selfAssessment.${i}.paidOn`} label="Paid on" />
                      <Button type="button" variant="ghost" size="icon" className="mt-6" aria-label={`Remove payment ${i + 1}`} onClick={() => sa.remove(i)}>
                        <XIcon aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Dates for interest" description="Interest for late filing and advance tax runs to the filing date (ss.234A–234C; ss.423–425 under the 2025 Act).">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <DateField control={control} name="filing_date" label="Filing date" required helper="Today unless you are planning a later filing." />
              <SelectField
                control={control}
                name="return_kind"
                label="Kind of return"
                options={RETURN_KINDS.map((k) => ({ value: k, label: RETURN_KIND_LABEL[k] }))}
                helper={client?.taxAuditApplicable === "yes" ? "The client's tax audit is confirmed." : "Decides the due date of the return."}
              />
              <KindWatcher control={control} onChange={(k) => applyDefaults({ fy, client, kind: k })} />
              <div className="flex flex-col gap-1.5 md:col-span-2">
                {dueManual ? (
                  <DateField
                    control={control}
                    name="due_date"
                    label="Due date of the return"
                    required
                    helper={
                      <>
                        Set by hand.{" "}
                        {ruleDue ? (
                          <button
                            type="button"
                            className="font-medium text-text underline-offset-4 hover:underline"
                            onClick={() => {
                              setValue("due_date_source", "rule", { shouldDirty: true })
                              setValue("due_date", ruleDue.date, { shouldDirty: true })
                            }}
                          >
                            Use {formatDate(ruleDue.date)} from the rules
                          </button>
                        ) : null}
                      </>
                    }
                  />
                ) : (
                  <>
                    <span className="text-sm font-medium text-text">Due date of the return</span>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
                      <span className="num text-base text-text">{ruleDue ? formatDate(ruleDue.date) : formatDate(String(watched.due_date ?? ""))}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setValue("due_date_source", "manual", { shouldDirty: true })}>
                        Change
                      </Button>
                    </div>
                    <p className="text-sm text-text-muted">{ruleDue ? ruleDue.basis : "No due-date rule is recorded for this kind of return; enter the date by hand."}</p>
                  </>
                )}
              </div>
            </div>
          </SectionCard>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:self-start" aria-label="Live comparison">
          <section className="rounded-lg border border-border bg-surface">
            <div className="px-4 pt-4 pb-3">
              <h2 className="text-md leading-6 font-semibold text-text">Comparison</h2>
              <p className="mt-0.5 text-sm text-text-muted">Updates as you type. Saved figures are recomputed on the server.</p>
            </div>
            {!client ? (
              <p className="border-t border-border px-4 py-3 text-sm text-text-muted">Choose the client and the year.</p>
            ) : !ruleSet ? (
              <p className="border-t border-border px-4 py-3 text-sm text-warning-text">No income-tax rule set is recorded for FY {fy}. A Partner adds it under Settings → Law & rules.</p>
            ) : preview && !preview.ok ? (
              <p className="border-t border-border px-4 py-3 text-sm text-warning-text">{preview.message}</p>
            ) : preview && preview.ok ? (
              <div className="border-t border-border">
                <div className="px-4 py-3">
                  <p className="text-sm text-text-muted">Recommended</p>
                  <p className="text-xl leading-8 font-semibold text-text">{REGIME_LABEL[preview.result.recommendedRegime]}</p>
                  <p className="text-sm text-text-muted">
                    {preview.result.saving > 0 ? (
                      <>
                        Saves <TaxFigure value={preview.result.saving} className="font-medium text-success-text" />
                      </>
                    ) : (
                      "Both regimes cost the same."
                    )}
                  </p>
                </div>
                <dl className="border-t border-border px-4 py-2 text-sm">
                  {(["new", "old"] as const).map((r) => (
                    <div key={r} className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt className="text-text-muted">{REGIME_LABEL[r]}</dt>
                      <dd className="text-right">
                        <BalanceText balance={preview.result.regimes[r].balance} />
                        <span className="block text-xs text-text-muted">
                          Tax and interest <TaxFigure value={preview.result.regimes[r].totalTaxAndInterest} />
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </section>
        </aside>
      </div>

      {preview?.ok ? (
        <details className="group mt-6">
          <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-text underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show the full computation (preview)</span>
            <span className="hidden group-open:inline">Hide the full computation</span>
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <ItrComparison result={preview.result} />
            <ItrSheet result={preview.result} title="Computation preview, both regimes" />
          </div>
        </details>
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-3 md:-mx-6 md:px-6">
        {status === "draft" ? <DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} className="mr-auto" /> : <span className="mr-auto" />}
        {savedId && canDelete ? (
          <Button type="button" variant="ghost" size="sm" className="text-danger-text" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon aria-hidden="true" />
            <span className="max-sm:sr-only">Delete</span>
          </Button>
        ) : null}
        <Button type="button" variant="outline" asChild>
          <Link href={savedId ? `/workpapers/itr/${savedId}?view=sheet` : "/workpapers/itr"}>Cancel</Link>
        </Button>
        {!reviewed ? (
          <Button type="button" variant="outline" disabled={f.pending || !client || !ruleSet} onClick={(e) => void submit("stay", e)}>
            Save
          </Button>
        ) : null}
        <Button type="submit" disabled={f.pending || !client || !ruleSet}>
          {f.pending ? <Spinner /> : null}
          {primaryLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this computation?"
        description="The computation and its figures are removed for good. The client's other computations stay."
        confirmLabel="Delete computation"
        destructive
        onConfirm={async () => {
          const id = idRef.current
          if (!id || !updatedAtRef.current) return false
          const r = await queued(() => deleteItrComputation({ id, updatedAt: updatedAtRef.current as string }))
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          setDone(true)
          draft.clear()
          toast.success("Computation deleted.")
          router.push("/workpapers/itr")
        }}
      />
    </form>
  )
}

/** Keeps the due date and the age band on the rules when the year changes. */
function FyWatcher({ control, onChange }: { control: unknown; onChange: (fy: string) => void }) {
  const value = useWatch({ control: control as never, name: "financial_year" as never }) as unknown as string
  const prev = React.useRef(value)
  React.useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      onChange(value)
    }
  }, [value, onChange])
  return null
}

/** Keeps the due date on the rules when the kind of return changes. */
function KindWatcher({ control, onChange }: { control: unknown; onChange: (k: ReturnKind) => void }) {
  const value = useWatch({ control: control as never, name: "return_kind" as never }) as unknown as ReturnKind
  const prev = React.useRef(value)
  React.useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      onChange(value)
    }
  }, [value, onChange])
  return null
}

/** A band picked by hand (one that differs from the date of birth) is recorded as set by hand. */
function AgeBandWatcher({ control, autoBand, onManual }: { control: unknown; autoBand: AgeBand | null; onManual: () => void }) {
  const value = useWatch({ control: control as never, name: "age_band" as never }) as unknown as AgeBand
  const source = useWatch({ control: control as never, name: "age_band_source" as never }) as unknown as string
  const prev = React.useRef(value)
  React.useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      if (source !== "manual" && autoBand && value !== autoBand) onManual()
    }
  }, [value, source, autoBand, onManual])
  return null
}

function ParentsSeniorCheckbox({ control }: { control: Control<Form> }) {
  const id = React.useId()
  const { field } = useController({ control, name: "deductions.sec80D.parentsSenior" })
  const { ref: fieldRef, value, onChange, onBlur } = field
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} ref={fieldRef} checked={Boolean(value)} onCheckedChange={(v) => onChange(v === true)} onBlur={onBlur} />
      <Label htmlFor={id} className="text-sm font-normal text-text">
        Parents are senior citizens (higher limit)
      </Label>
    </div>
  )
}

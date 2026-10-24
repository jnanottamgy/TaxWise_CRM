"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useWatch, type Control, type FieldValues } from "react-hook-form"
import type { z } from "zod"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { CheckboxGroupField, DateField, MoneyField, PercentField, SelectField, TextareaField } from "@/components/app/form/fields"
import { Money } from "@/components/app/money"
import { useActionForm } from "@/hooks/use-action-form"
import type { ActionResult } from "@/lib/result"
import { parseAmount, fromPaise } from "@/lib/domain/money"
import { formatDate } from "@/lib/format"
import {
  AUDIT_STAGE_LABELS,
  MATERIALITY_BASES,
  MATERIALITY_BASIS_LABELS,
  MATERIALITY_BENCHMARKS,
  PERFORMANCE_RANGE,
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  TRIVIAL_RANGE,
  caroApplicability,
  computeMateriality,
  countsTowardsCompanyLimit,
  type AuditParams,
  type AuditStage,
  type CompanyFacts,
  type MaterialityBasis,
  type StoredMateriality,
} from "@/lib/domain/audit-stages"
import { AdvanceStageSchema, COMPANY_FLAGS, COMPANY_FLAG_LABELS, CompanyFactsSchema, LimitOverrideSchema, MaterialitySchema, ReportSchema, type CompanyFlag } from "@/lib/schemas/audits"
import { advanceStage, confirmLimitOverride, saveCompanyFacts, saveMateriality, saveReport } from "@/server/actions/audits"

// =================================================================================================
// A note-only action (not applicable, amendment reasons, stage moves, the ceiling confirmation)
// =================================================================================================

export function NoteDialog<T>({
  onClose,
  title,
  description,
  details,
  label,
  helper,
  required,
  submitLabel,
  schema,
  action,
  values,
  successMessage,
  onDone,
}: {
  onClose: () => void
  title: string
  description: React.ReactNode
  details?: React.ReactNode
  label: string
  helper?: React.ReactNode
  required: boolean
  submitLabel: string
  schema: z.ZodType<FieldValues, FieldValues>
  action: (input: never) => Promise<ActionResult<T>>
  values: Record<string, unknown>
  successMessage?: string | ((data: T) => string)
  onDone: (data: T) => void | Promise<void>
}) {
  const f = useActionForm(schema, action as (input: FieldValues) => Promise<ActionResult<T>>, {
    defaultValues: { ...values, note: "" },
    successMessage,
    onSuccess: async (data) => {
      onClose()
      await onDone(data)
    },
  })
  const control = f.control as unknown as Control<FieldValues>
  const note = useWatch({ control, name: "note" }) as unknown
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={title}
      description={description}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={Boolean(String(note ?? "").trim())}
      submitLabel={submitLabel}
    >
      <FormAlert state={f} />
      {details ? <div className="mb-4 text-sm text-text-muted">{details}</div> : null}
      <TextareaField control={control} name="note" label={label} required={required} rows={3} helper={helper} />
    </FormDialog>
  )
}

// =================================================================================================
// Stage moves: the engagement partner approves (§7.15.5)
// =================================================================================================

export function StageMoveDialog({
  onClose,
  engagementId,
  updatedAt,
  from,
  to,
  warnings,
}: {
  onClose: () => void
  engagementId: string
  updatedAt: string
  from: AuditStage
  to: AuditStage
  warnings: string[]
}) {
  const router = useRouter()
  const back = AUDIT_STAGE_ORDER.indexOf(to) < AUDIT_STAGE_ORDER.indexOf(from)
  const archiving = to === "archived"
  return (
    <NoteDialog
      onClose={onClose}
      title={back ? `Move back to ${AUDIT_STAGE_LABELS[to]}?` : archiving ? "Archive the audit file?" : `Approve the move to ${AUDIT_STAGE_LABELS[to]}?`}
      description={
        back
          ? `The engagement returns to ${AUDIT_STAGE_LABELS[to]} so its steps can be reopened. Say why; it goes in the stage log.`
          : archiving
            ? "The engagement and its working papers become read-only (SA 230). Anything added later is logged as an amendment, and the file is kept 7 years from the report date."
            : `As engagement partner you approve that ${AUDIT_STAGE_LABELS[from]} is complete. The engagement moves to ${AUDIT_STAGE_LABELS[to]}.`
      }
      details={
        warnings.length ? (
          <ul className="list-disc space-y-1 pl-4 text-warning-text">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : undefined
      }
      label={back ? "Why it goes back" : "Note for the stage log"}
      required={back}
      submitLabel={back ? `Move back to ${AUDIT_STAGE_LABELS[to]}` : archiving ? "Archive and lock the file" : `Move to ${AUDIT_STAGE_LABELS[to]}`}
      schema={AdvanceStageSchema}
      action={advanceStage}
      values={{ id: engagementId, updatedAt, to }}
      successMessage={archiving ? "Archived: the file is locked" : back ? `Moved back to ${AUDIT_STAGE_LABELS[to]}` : `Moved to ${AUDIT_STAGE_LABELS[to]}`}
      onDone={() => router.refresh()}
    />
  )
}

const AUDIT_STAGE_ORDER: readonly AuditStage[] = ["acceptance", "planning", "risk_assessment", "execution", "completion", "reporting", "archived"]

export function LimitOverrideDialog({ onClose, engagementId, message }: { onClose: () => void; engagementId: string; message: string | null }) {
  const router = useRouter()
  return (
    <NoteDialog
      onClose={onClose}
      title="Confirm a tax audit over the ceiling?"
      description={message ?? "This tax audit would take the engagement partner over the ICAI ceiling of 60 in the year."}
      details="The ICAI ceiling counts audits signed elsewhere too. Record why the firm is taking it on; the confirmation is kept with your name on the engagement and in the audit log."
      label="Why the firm takes this audit"
      required
      submitLabel="Confirm as a Partner"
      schema={LimitOverrideSchema}
      action={confirmLimitOverride}
      values={{ id: engagementId }}
      successMessage="Confirmed over the ceiling"
      onDone={() => router.refresh()}
    />
  )
}

// =================================================================================================
// Materiality (SA 320)
// =================================================================================================

const BASIS_OPTIONS = MATERIALITY_BASES.map((b) => ({ value: b, label: MATERIALITY_BASIS_LABELS[b] }))

function MaterialityPreview({ control }: { control: Control<FieldValues> }) {
  const [basis, base, pct, perf, triv] = useWatch({ control, name: ["basis", "baseAmount", "percent", "performancePercent", "trivialPercent"] }) as [MaterialityBasis, unknown, unknown, unknown, unknown]
  const parsed = parseAmount(String(base ?? ""))
  const n = (v: unknown) => {
    const x = Number(String(v ?? "").replace(/%$/, ""))
    return Number.isFinite(x) ? x : NaN
  }
  if (!parsed.ok || parsed.paise <= 0 || [pct, perf, triv].some((v) => Number.isNaN(n(v)))) {
    return <p className="text-sm text-text-muted">Enter the benchmark figure and the percentages to see the amounts.</p>
  }
  const m = computeMateriality({ basis, baseAmountPaise: parsed.paise, percent: n(pct), performancePercent: n(perf), trivialPercent: n(triv) })
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-3 divide-x divide-border rounded-md border border-border">
        {[
          { term: "Overall", paise: m.overallPaise },
          { term: "Performance", paise: m.performancePaise },
          { term: "Clearly trivial", paise: m.trivialPaise },
        ].map((x) => (
          <div key={x.term} className="px-3 py-2">
            <dt className="text-xs text-text-muted">{x.term}</dt>
            <dd className="num mt-0.5 text-base font-medium text-text">
              <Money value={fromPaise(x.paise)} />
            </dd>
          </div>
        ))}
      </dl>
      {m.warnings.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-sm text-warning-text">
          {m.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function BasisHelp({ control }: { control: Control<FieldValues> }) {
  const basis = useWatch({ control, name: "basis" }) as MaterialityBasis
  const b = MATERIALITY_BENCHMARKS[basis]
  return <>{b ? `Usually ${b.min}–${b.max}% of ${MATERIALITY_BASIS_LABELS[basis].toLowerCase()}.` : null}</>
}

export function MaterialityDialog({ onClose, engagementId, updatedAt, current }: { onClose: () => void; engagementId: string; updatedAt: string; current: StoredMateriality | null }) {
  const router = useRouter()
  const basis: MaterialityBasis = current?.basis ?? "profit_before_tax"
  const f = useActionForm(MaterialitySchema, saveMateriality, {
    defaultValues: {
      id: engagementId,
      updatedAt,
      basis,
      baseAmount: current ? String(current.base_amount) : "",
      percent: current ? String(current.percent) : String(MATERIALITY_BENCHMARKS[basis].typical),
      performancePercent: current ? String(current.performance_percent) : String(PERFORMANCE_RANGE.typical),
      trivialPercent: current ? String(current.trivial_percent) : String(TRIVIAL_RANGE.typical),
      rationale: current?.rationale ?? "",
    },
    successMessage: "Materiality saved",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const control = f.control as unknown as Control<FieldValues>
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="Materiality (SA 320)"
      description="Overall materiality from a benchmark; performance materiality and the clearly-trivial threshold as percentages of it."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save materiality"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={f.control} name="basis" label="Basis" required options={BASIS_OPTIONS} />
        <MoneyField control={f.control} name="baseAmount" label="Benchmark figure" required helper="From the year's draft financial statements." />
        <PercentField control={f.control} name="percent" label="Overall, % of the benchmark" required decimals={2} helper={<BasisHelp control={control} />} />
        <PercentField control={f.control} name="performancePercent" label="Performance, % of overall" required decimals={2} helper={`Usually ${PERFORMANCE_RANGE.min}–${PERFORMANCE_RANGE.max}%.`} />
        <PercentField control={f.control} name="trivialPercent" label="Clearly trivial, % of overall" required decimals={2} helper={`Usually up to ${TRIVIAL_RANGE.max}%.`} />
        <div className="md:col-span-2">
          <MaterialityPreview control={control} />
        </div>
        <TextareaField control={f.control} name="rationale" label="Why this basis and percentage" required rows={3} className="md:col-span-2" helper="The users of the statements, the entity's nature and any element that is especially sensitive." />
      </div>
    </FormDialog>
  )
}

// =================================================================================================
// Company facts (CARO 2020, s.141(3)(g))
// =================================================================================================

const FLAG_OPTIONS = COMPANY_FLAGS.map((k) => ({ value: k, label: COMPANY_FLAG_LABELS[k] }))

function CompanyIndication({ control, params, privateExclusionPaise }: { control: Control<FieldValues>; params: Pick<AuditParams, "smallCompany" | "caroPrivateExemption">; privateExclusionPaise: number }) {
  const [isPublic, flags, cap, turnover, cr, borrow, rev] = useWatch({ control, name: ["isPublic", "flags", "paidUpCapital", "turnover", "capitalAndReserves", "maxBorrowings", "revenue"] }) as [string, string[], unknown, unknown, unknown, unknown, unknown]
  const amount = (v: unknown) => {
    const r = parseAmount(String(v ?? ""))
    return r.ok && String(v ?? "").trim() ? fromPaise(r.paise) : null
  }
  const has = (k: CompanyFlag) => (flags ?? []).includes(k)
  const facts: CompanyFacts = {
    isPublic: isPublic === "public" ? true : isPublic === "private" ? false : null,
    isOnePersonCompany: has("isOnePersonCompany"),
    isSection8: has("isSection8"),
    isBanking: has("isBanking"),
    isInsurance: has("isInsurance"),
    isHoldingOrSubsidiary: has("isHoldingOrSubsidiary"),
    isHoldingOrSubsidiaryOfPublic: has("isHoldingOrSubsidiaryOfPublic"),
    isSpecialAct: has("isSpecialAct"),
    isDormant: has("isDormant"),
    paidUpCapital: amount(cap),
    turnover: amount(turnover),
    capitalAndReserves: amount(cr),
    maxBorrowings: amount(borrow),
    revenue: amount(rev),
  }
  const caro = caroApplicability(facts, params)
  const counts = countsTowardsCompanyLimit(facts, privateExclusionPaise, params.smallCompany)
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm text-text">
      <p>
        <span className="font-medium">CARO 2020: </span>
        {caro.reason}
      </p>
      <p>
        <span className="font-medium">Company audit limit: </span>
        {counts === null ? "record public or private and the paid-up capital to tell." : counts ? "counts towards the 20 per partner (s.141(3)(g))." : "doesn't count towards the 20 per partner."}
      </p>
    </div>
  )
}

export function CompanyFactsDialog({
  onClose,
  engagementId,
  updatedAt,
  facts,
  params,
  privateExclusionPaise,
}: {
  onClose: () => void
  engagementId: string
  updatedAt: string
  facts: CompanyFacts
  params: Pick<AuditParams, "smallCompany" | "caroPrivateExemption">
  privateExclusionPaise: number
}) {
  const router = useRouter()
  const flagged = COMPANY_FLAGS.filter((k) => facts[k])
  const f = useActionForm(CompanyFactsSchema, saveCompanyFacts, {
    defaultValues: {
      id: engagementId,
      updatedAt,
      isPublic: facts.isPublic === true ? "public" : facts.isPublic === false ? "private" : undefined,
      flags: flagged,
      paidUpCapital: facts.paidUpCapital === null ? "" : String(facts.paidUpCapital),
      turnover: facts.turnover === null ? "" : String(facts.turnover),
      capitalAndReserves: facts.capitalAndReserves === null ? "" : String(facts.capitalAndReserves),
      maxBorrowings: facts.maxBorrowings === null ? "" : String(facts.maxBorrowings),
      revenue: facts.revenue === null ? "" : String(facts.revenue),
    },
    successMessage: "Company facts saved",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const control = f.control as unknown as Control<FieldValues>
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="lg"
      title="Company facts"
      description="For the CARO 2020 indication and whether the audit counts towards the engagement partner's 20 company audits. Amounts in rupees, for the year audited."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save facts"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField
          control={control}
          name="isPublic"
          label="Public or private"
          required
          options={[
            { value: "private", label: "Private company" },
            { value: "public", label: "Public company" },
          ]}
        />
        <div className="hidden md:block" />
        <CheckboxGroupField control={control} name="flags" label="The company is" options={FLAG_OPTIONS} columns={2} className="md:col-span-2" />
        <MoneyField control={control} name="paidUpCapital" label="Paid-up capital" />
        <MoneyField control={control} name="turnover" label="Turnover" />
        <MoneyField control={control} name="capitalAndReserves" label="Paid-up capital plus reserves and surplus" helper="At the balance sheet date (CARO Para 1(2)(v))." />
        <MoneyField control={control} name="maxBorrowings" label="Highest borrowings from banks and FIs" helper="At any time in the year." />
        <MoneyField control={control} name="revenue" label="Total revenue (Schedule III)" />
        <div className="md:col-span-2">
          <CompanyIndication control={control} params={params} privateExclusionPaise={privateExclusionPaise} />
        </div>
      </div>
    </FormDialog>
  )
}

// =================================================================================================
// Report (SA 700/705), UDIN, CARO decision
// =================================================================================================

export type UdinChoice = { id: string; udin: string; document_type: string; signed_on: string; generated_on: string; audit_engagement_id: string | null }

export function ReportDialog({
  onClose,
  engagementId,
  updatedAt,
  reportType,
  reportDate,
  udinRecordId,
  caroApplicable,
  isCompanyAudit,
  caroHint,
  udins,
  today,
}: {
  onClose: () => void
  engagementId: string
  updatedAt: string
  reportType: string | null
  reportDate: string | null
  udinRecordId: string | null
  caroApplicable: boolean | null
  isCompanyAudit: boolean
  caroHint: string | null
  udins: UdinChoice[]
  today: string
}) {
  const router = useRouter()
  const f = useActionForm(ReportSchema, saveReport, {
    defaultValues: {
      id: engagementId,
      updatedAt,
      reportType: (reportType as (typeof REPORT_TYPES)[number] | null) ?? undefined,
      reportDate: reportDate ?? "",
      udinRecordId: udinRecordId ?? "",
      caroApplicable: caroApplicable === true ? "yes" : caroApplicable === false ? "no" : "",
    },
    successMessage: "Report details saved",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const udinOptions = udins.map((u) => ({ value: u.id, label: `${u.udin} · ${u.document_type}, signed ${formatDate(u.signed_on)}` }))
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="Report and UDIN"
      description="The opinion and the date the report was signed start the 60-day UDIN and file assembly periods."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save report details"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={f.control} name="reportType" label="Type of opinion" required options={REPORT_TYPES.map((r) => ({ value: r, label: REPORT_TYPE_LABELS[r] }))} />
        <DateField control={f.control} name="reportDate" label="Report date" required max={today} />
        <SelectField
          control={f.control}
          name="udinRecordId"
          label="UDIN"
          options={udinOptions}
          placeholder={udins.length ? "Not generated yet" : "No UDIN logged for this client"}
          className="md:col-span-2"
          helper={
            <>
              Generate it on the ICAI portal within 60 days of signing, then log it in the{" "}
              <Link href="/registers?tab=udin" className="font-medium text-primary hover:underline">
                UDIN register
              </Link>
              .
            </>
          }
        />
        {isCompanyAudit ? (
          <SelectField
            control={f.control}
            name="caroApplicable"
            label="CARO 2020"
            options={[
              { value: "yes", label: "Applies: report on the Order's matters" },
              { value: "no", label: "Doesn't apply to this company" },
            ]}
            placeholder="Not decided yet"
            className="md:col-span-2"
            helper={caroHint ?? undefined}
          />
        ) : null}
      </div>
    </FormDialog>
  )
}

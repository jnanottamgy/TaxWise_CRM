"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, useFieldArray, useWatch, type Control } from "react-hook-form"
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { FormAlert } from "@/components/app/form/form-alert"
import { MoneyInput } from "@/components/app/form/money-input"
import { CheckboxGroupField, DateField, MoneyField, SelectField, TextareaField } from "@/components/app/form/fields"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { useActionForm } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { formatINR } from "@/lib/domain/money"
import { formatDate } from "@/lib/format"
import { SERVICE_FREQUENCIES, SERVICE_FREQUENCY_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS, type EntityType, type ServiceType } from "@/lib/domain/enums"
import {
  CreateLetterSchema,
  LETTER_AUDIT_TYPES,
  LETTER_AUDIT_TYPE_LABEL,
  defaultLetterExpiry,
  defaultReportForm,
  defaultReportingFramework,
  isAuditLetter,
  scheduleAnnualPaise,
  type CreateLetterInput,
  type LetterAuditType,
  type ScheduleRow,
} from "@/lib/schemas/engagement-letters"
import { createLetter, loadLetterClient, updateLetter } from "@/server/actions/engagement-letters"
import { ClientPickerField } from "@/components/registers/shared"

export type LetterFormContext = {
  fyOptions: string[]
  signatories: Array<{ id: string; name: string; membershipNo: string | null }>
  /** Audit engagements of the client (when it is known), for the SA 210 link. */
  engagements: Array<{ id: string; audit_type: string; financial_year: string }>
  entityType: EntityType | null
}

type Values = CreateLetterInput

const SERVICE_OPTIONS = SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] }))
const AUDIT_OPTIONS = LETTER_AUDIT_TYPES.map((a) => ({ value: a, label: LETTER_AUDIT_TYPE_LABEL[a] }))

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface px-4 py-4 md:px-5">
      <h2 className="text-md leading-6 font-semibold text-text">{title}</h2>
      {description ? <p className="mb-4 text-sm text-text-muted">{description}</p> : <div className="mb-4" />}
      {children}
    </section>
  )
}

function ScheduleEditor({ control, onFill, filling }: { control: Control<Values>; onFill: (() => void) | null; filling: boolean }) {
  const rows = useFieldArray({ control, name: "servicesSchedule" })
  const values = (useWatch({ control, name: "servicesSchedule" }) ?? []) as Array<Partial<ScheduleRow>>
  const annual = scheduleAnnualPaise(values.filter((r): r is ScheduleRow => Boolean(r?.frequency)).map((r) => ({ frequency: r.frequency, fee: r.fee ?? null })))
  return (
    <div className="flex flex-col gap-3">
      {rows.fields.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-text-muted">No services in the schedule. Add each service with its frequency and fee, or fill it from the client&apos;s active services.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.fields.map((field, i) => (
            <ScheduleRowEditor key={field.id} control={control} index={i} onRemove={() => rows.remove(i)} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => rows.append({ service_type: "gst", description: SERVICE_TYPE_LABELS.gst, frequency: "monthly", fee: "" })} disabled={rows.fields.length >= 40}>
            <PlusIcon aria-hidden="true" />
            Add a service
          </Button>
          {onFill ? (
            <Button type="button" variant="ghost" size="sm" onClick={onFill} disabled={filling}>
              {filling ? <Spinner /> : <RefreshCwIcon aria-hidden="true" />}
              Fill from the client&apos;s services
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-text-muted">
          For the year, excl. GST: <span className="num font-medium text-text tabular-nums">{formatINR(annual)}</span>
        </p>
      </div>
    </div>
  )
}

function ScheduleRowEditor({ control, index, onRemove }: { control: Control<Values>; index: number; onRemove: () => void }) {
  const type = useController({ control, name: `servicesSchedule.${index}.service_type` })
  const desc = useController({ control, name: `servicesSchedule.${index}.description` })
  const freq = useController({ control, name: `servicesSchedule.${index}.frequency` })
  const fee = useController({ control, name: `servicesSchedule.${index}.fee` })
  const err = desc.fieldState.error?.message ?? fee.fieldState.error?.message ?? type.fieldState.error?.message ?? freq.fieldState.error?.message
  const n = index + 1
  return (
    <li className="grid grid-cols-2 gap-2 rounded-md border border-border/70 p-3 md:grid-cols-[10rem_minmax(0,1fr)_9rem_10rem_2.5rem] md:items-start md:border-0 md:p-0">
      <NativeSelect
        aria-label={`Service ${n}`}
        value={(type.field.value as string) ?? "gst"}
        onChange={(e) => {
          const v = e.target.value as ServiceType
          const prevLabel = SERVICE_TYPE_LABELS[type.field.value as ServiceType]
          type.field.onChange(v)
          if (!desc.field.value || desc.field.value === prevLabel) desc.field.onChange(SERVICE_TYPE_LABELS[v])
        }}
      >
        {SERVICE_OPTIONS.map((o) => (
          <NativeSelectOption key={o.value} value={o.value}>
            {o.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input aria-label={`Description of service ${n}`} aria-invalid={desc.fieldState.error ? true : undefined} value={(desc.field.value as string) ?? ""} onChange={desc.field.onChange} onBlur={desc.field.onBlur} className="col-span-2 md:col-span-1" maxLength={200} />
      <NativeSelect aria-label={`Frequency of service ${n}`} value={(freq.field.value as string) ?? "monthly"} onChange={(e) => freq.field.onChange(e.target.value)}>
        {SERVICE_FREQUENCIES.map((f) => (
          <NativeSelectOption key={f} value={f}>
            {SERVICE_FREQUENCY_LABELS[f]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <MoneyInput aria-label={`Fee for service ${n}, excluding GST`} aria-invalid={fee.fieldState.error ? true : undefined} value={fee.field.value as string | null | undefined} onChange={fee.field.onChange} onBlur={fee.field.onBlur} placeholder="Fee" />
      <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} aria-label={`Remove service ${n}`} className="justify-self-end">
        <Trash2Icon aria-hidden="true" className="text-text-muted" />
      </Button>
      {err ? <p className="col-span-2 text-sm text-danger-text md:col-span-5">{err}</p> : null}
    </li>
  )
}

/** Keeps the SA 210 framework and report-form fields on their defaults until someone edits them. */
function AuditDefaults({ control, setValue, entityType }: { control: Control<Values>; setValue: (name: "reportingFramework" | "reportForm", v: string) => void; entityType: EntityType | null }) {
  const auditType = useWatch({ control, name: "auditType" }) as LetterAuditType | null | ""
  const fy = useWatch({ control, name: "financialYear" }) as string
  const framework = useWatch({ control, name: "reportingFramework" }) as string | null | undefined
  const report = useWatch({ control, name: "reportForm" }) as string | null | undefined
  const last = React.useRef<{ framework: string; report: string } | null>(null)
  React.useEffect(() => {
    if (!auditType || !fy) return
    const next = { framework: defaultReportingFramework(auditType, entityType, fy), report: defaultReportForm(auditType, fy) }
    const prev = last.current
    if (!framework || (prev && framework === prev.framework)) setValue("reportingFramework", next.framework)
    if (!report || (prev && report === prev.report)) setValue("reportForm", next.report)
    last.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditType, fy, entityType])
  return null
}

/**
 * The engagement letter form (§7.15.3), full page: client, FY, services covered, scope and
 * exclusions, fee agreed (₹, excl. GST), the services schedule for non-audit work, and for an audit
 * the SA 210 terms (the kind of audit, the applicable financial reporting framework, the expected
 * form of the report) with the audit engagement it is for; the signing Partner, the expiry and
 * notes. It saves a Draft; issuing and sending happen on the letter. Fees never depend on results.
 */
export function LetterForm({
  mode,
  initial,
  letter,
  context,
  clientLabel,
}: {
  mode: "create" | "edit"
  initial: Values
  letter?: { id: string; updatedAt: string } | null
  context: LetterFormContext
  clientLabel?: string | null
}) {
  const router = useRouter()
  const [ctx, setCtx] = React.useState(context)
  const [filling, setFilling] = React.useState(false)
  const submit = React.useCallback(
    async (input: Values) => {
      if (mode === "edit" && letter) {
        const r = await updateLetter({ ...input, id: letter.id, updatedAt: letter.updatedAt })
        return r.ok ? { ...r, data: { id: r.data.id } } : r
      }
      return createLetter(input)
    },
    [mode, letter],
  )
  const f = useActionForm(CreateLetterSchema, submit, {
    defaultValues: initial,
    successMessage: mode === "edit" ? "Draft saved" : "Draft letter saved",
    onSuccess: ({ id }) => {
      router.push(`/engagement-letters/${id}`)
      router.refresh()
    },
  })
  const services = (useWatch({ control: f.control, name: "serviceTypes" }) ?? []) as ServiceType[]
  const clientId = useWatch({ control: f.control, name: "clientId" }) as string
  const fy = useWatch({ control: f.control, name: "financialYear" }) as string
  const expiresAt = useWatch({ control: f.control, name: "expiresAt" }) as string | null | undefined
  const audit = isAuditLetter(services)
  const engagementOptions = ctx.engagements.filter((e) => !fy || e.financial_year === fy).map((e) => ({ value: e.id, label: `${LETTER_AUDIT_TYPE_LABEL[e.audit_type as LetterAuditType] ?? "Audit"} · FY ${e.financial_year}` }))

  const loadClient = React.useCallback(
    async (id: string, fillServices: boolean) => {
      setFilling(true)
      try {
        const r = await loadLetterClient({ clientId: id })
        if (!r.ok) return
        setCtx((c) => ({ ...c, engagements: r.data.engagements, entityType: r.data.client.entityType }))
        if (fillServices) {
          const types = [...new Set(r.data.services.map((s) => s.service_type))]
          if (types.length) f.form.setValue("serviceTypes", types, { shouldDirty: true, shouldValidate: true })
          f.form.setValue("servicesSchedule", r.data.schedule.map((s) => ({ ...s, fee: s.fee ?? "" })), { shouldDirty: true })
        }
      } finally {
        setFilling(false)
      }
    },
    [f.form],
  )

  const defaultExpiry = fy ? defaultLetterExpiry(fy, audit) : null
  return (
    <form noValidate onSubmit={f.onSubmit} className="flex min-w-0 flex-col gap-4">
      <UnsavedChangesGuard when={f.form.formState.isDirty && !f.form.formState.isSubmitSuccessful} />
      <FormAlert state={f} className="mb-0" />
      <Card title="Client and year">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {mode === "create" ? (
            <ClientPickerField
              control={f.control}
              name="clientId"
              selectedLabel={clientLabel ?? undefined}
              onSelectOption={(o) => {
                if (o) void loadClient(o.value, true)
              }}
              helper="Its active services fill the schedule."
            />
          ) : (
            <div>
              <p className="text-sm font-medium text-text">Client</p>
              <p className="mt-1.5 text-base text-text">{clientLabel}</p>
            </div>
          )}
          <SelectField control={f.control} name="financialYear" label="FY" required options={ctx.fyOptions.map((y) => ({ value: y, label: `FY ${y}` }))} />
        </div>
        <CheckboxGroupField control={f.control} name="serviceTypes" label="Services covered" required options={SERVICE_OPTIONS} columns={3} className="mt-4" />
      </Card>

      {audit ? (
        <Card title="Audit terms (SA 210)" description="Printed as the objective and scope, each side's responsibilities, the framework and the form of report.">
          <AuditDefaults control={f.control} setValue={(n, v) => f.form.setValue(n, v, { shouldDirty: true })} entityType={ctx.entityType} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField control={f.control} name="auditType" label="Kind of audit" required options={AUDIT_OPTIONS} />
            <SelectField control={f.control} name="auditEngagementId" label="Audit engagement" options={engagementOptions} placeholder={engagementOptions.length ? "Choose the engagement" : "None for this FY yet"} helper="An audit can't move past acceptance without its letter at Issued." />
          </div>
          <TextareaField control={f.control} name="reportingFramework" label="Applicable financial reporting framework" required rows={3} className="mt-4" />
          <TextareaField control={f.control} name="reportForm" label="Expected form and content of the report" required rows={3} className="mt-4" />
        </Card>
      ) : null}

      <Card title="Scope" description="What the engagement covers, and what it doesn't.">
        <TextareaField control={f.control} name="scope" label="Scope" rows={4} placeholder="Monthly GSTR-1 and GSTR-3B, annual GSTR-9…" />
        <TextareaField control={f.control} name="exclusions" label="Exclusions" rows={3} className="mt-4" placeholder="Representation before authorities, departmental audits…" />
      </Card>

      <Card title="Fees" description="Fixed fees, excluding GST. A fee that depends on the result of the work isn't allowed (CA Act, First Schedule, Part I, Clause 10).">
        <MoneyField control={f.control} name="feeAgreed" label="Fee agreed (₹, excl. GST)" helper={audit ? "The audit fee printed in the letter." : "Leave blank to print the schedule's fees only."} className="max-w-xs" />
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium text-text">Services schedule</p>
          <ScheduleEditor control={f.control} onFill={clientId ? () => void loadClient(clientId, true) : null} filling={filling} />
        </div>
      </Card>

      <Card title="Signing and validity">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField control={f.control} name="signatoryId" label="Signing Partner" options={ctx.signatories.map((s) => ({ value: s.id, label: s.membershipNo ? `${s.name} · M. No. ${s.membershipNo}` : s.name }))} placeholder="Choose the Partner" />
          <DateField control={f.control} name="expiresAt" label="Expires on" helper={!expiresAt && defaultExpiry ? `Leave blank for ${formatDate(defaultExpiry)}, the end of ${audit ? "the year after" : "the FY"}.` : undefined} />
        </div>
        <TextareaField control={f.control} name="notes" label="Internal notes" rows={2} className="mt-4" helper="Not printed on the letter." />
      </Card>

      <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-3 md:-mx-6 md:px-6">
        <p className={cn("mr-auto text-sm text-text-muted")}>Saved as a draft. Issue and send it from the letter.</p>
        <Button asChild variant="outline">
          <Link href={letter ? `/engagement-letters/${letter.id}` : "/engagement-letters"}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
          {f.pending ? <Spinner /> : null}
          {mode === "edit" ? "Save draft" : "Save draft letter"}
        </Button>
      </div>
    </form>
  )
}

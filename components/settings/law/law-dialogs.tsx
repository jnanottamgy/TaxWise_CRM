"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useWatch } from "react-hook-form"
import { isDateString } from "@/lib/domain/fy"
import { SERVICE_FREQUENCY_LABELS, type ServiceFrequency } from "@/lib/domain/enums"
import { parseRuleSpec } from "@/lib/domain/statutory-calendar"
import { formatDate } from "@/lib/format"
import {
  ConcordanceSchema,
  DueDateRuleChangeSchema,
  formatParameterValue,
  OverrideSchema,
  ParameterAddSchema,
  ParameterChangeSchema,
  parseParameterValue,
  planSupersede,
  RULE_FREQUENCIES,
  suggestVersionCode,
  summariseParameterValue,
  type ConcordanceInput,
  type DueDateRuleChangeInput,
  type OverrideInput,
  type ParameterAddInput,
  type ParameterChangeInput,
} from "@/lib/schemas/law"
import { addOverride, addParameter, changeDueDateRule, changeParameter, removeOverride, saveConcordance } from "@/server/actions/law"
import type { ConcordanceRow, DueDateRuleRow, OverrideRow, ParameterRow } from "@/lib/data/law"
import { ComboboxField, DateField, SelectField, SwitchField, TextareaField, TextField } from "@/components/app/form/fields"
import { FormAlert } from "@/components/app/form/form-alert"
import { FormDialog } from "@/components/app/form-dialog"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { SettingPreview } from "@/components/settings/settings-card"
import { useActionForm } from "@/hooks/use-action-form"

const MONO = "[&_textarea]:font-mono [&_textarea]:text-sm [&_input]:font-mono"

function useAfterSave() {
  const router = useRouter()
  return (onDone: () => void) => () => {
    onDone()
    router.refresh()
  }
}

function inForceText(from: string, to: string | null): string {
  return to ? `${formatDate(from)} – ${formatDate(to)}` : `from ${formatDate(from)}`
}

// -------------------------------------------------------------------------------------------------
// Statutory parameter: change from a date
// -------------------------------------------------------------------------------------------------

export function ParameterChangeDialog({ row, open, onOpenChange }: { row: ParameterRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const after = useAfterSave()
  const defaults: ParameterChangeInput = {
    id: row.id,
    updated_at: row.updated_at,
    effective_from: "",
    value: formatParameterValue(row.value, { pretty: true }),
    statute: row.statute ?? "",
    section_ref: row.section_ref ?? "",
    source_ref: "",
    notes: "",
    verified: true,
  }
  const f = useActionForm(ParameterChangeSchema, changeParameter, {
    defaultValues: defaults,
    successMessage: "Change saved. The earlier value stays in the history.",
    onSuccess: after(() => onOpenChange(false)),
  })
  const v = useWatch({ control: f.control }) as Partial<ParameterChangeInput>
  const from = v.effective_from ?? ""
  const plan = isDateString(from) ? planSupersede(row, from) : null
  const parsed = parseParameterValue(String(v.value ?? ""))

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Change ${row.key}`}
      description={`In force ${inForceText(row.effective_from, row.effective_to)}: ${summariseParameterValue(row.value, 80)}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save change"
      size="lg"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DateField control={f.control} name="effective_from" label="Takes effect from" required helper="The current row closes the day before. History is never overwritten." />
        <TextField control={f.control} name="source_ref" label="Source" required helper="Finance Act, notification or circular, with its date." />
        <TextareaField control={f.control} name="value" label="New value" required rows={3} className={`md:col-span-2 ${MONO}`} helper='A number (10, 50000), text, or JSON such as {"rate": 10, "threshold": 50000}.' />
        <TextField control={f.control} name="statute" label="Statute" />
        <TextField control={f.control} name="section_ref" label="Section" />
        <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
        <div className="md:col-span-2">
          <SwitchField control={f.control} name="verified" label="I've checked this against the source" description="Saved as verified, with your name and today's date. Leave off to list it as awaiting confirmation." />
        </div>
        <SettingPreview label="What happens">
          {plan?.ok ? (
            <>
              From <span className="num font-medium">{formatDate(from)}</span> the value is{" "}
              <span className="font-mono">{parsed.ok ? summariseParameterValue(parsed.value, 80) : "…"}</span>. The row in force since {formatDate(row.effective_from)} closes on{" "}
              <span className="num">{formatDate(plan.closeOldOn)}</span>
              {row.effective_to ? <>, and the new row ends on {formatDate(row.effective_to)} like it did</> : null}.
            </>
          ) : plan && !plan.ok ? (
            <span className="text-danger-text">{plan.error}</span>
          ) : (
            <span className="text-text-muted">Choose the date the change takes effect.</span>
          )}
        </SettingPreview>
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Statutory parameter: add a new key
// -------------------------------------------------------------------------------------------------

export function ParameterAddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const after = useAfterSave()
  const defaults: ParameterAddInput = {
    key: "",
    value: "",
    effective_from: "",
    effective_to: "",
    statute: "",
    section_ref: "",
    source_ref: "",
    notes: "",
    verified: true,
  }
  const f = useActionForm(ParameterAddSchema, addParameter, {
    defaultValues: defaults,
    successMessage: "Parameter added",
    onSuccess: after(() => {
      onOpenChange(false)
      f.form.reset(defaults)
    }),
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a statutory parameter"
      description="A rate, threshold or limit the app reads, with the date it applies from and its legal source."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Add parameter"
      size="lg"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="key" label="Key" required className={`md:col-span-2 ${MONO}`} helper="Lower-case words joined by dots, like tds.professional_fees.rate." autoCapitalize="none" spellCheck={false} />
        <TextareaField control={f.control} name="value" label="Value" required rows={3} className={`md:col-span-2 ${MONO}`} helper='A number, text, or JSON such as {"rate": 10, "threshold": 50000}.' />
        <DateField control={f.control} name="effective_from" label="In force from" required />
        <DateField control={f.control} name="effective_to" label="Until" helper="Leave empty while it is current." />
        <TextField control={f.control} name="statute" label="Statute" helper="e.g. Income-tax Act, 2025" />
        <TextField control={f.control} name="section_ref" label="Section" />
        <TextField control={f.control} name="source_ref" label="Source" required className="md:col-span-2" helper="Finance Act, notification or circular, with its date." />
        <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
        <div className="md:col-span-2">
          <SwitchField control={f.control} name="verified" label="I've checked this against the source" description="Leave off to list it as awaiting partner confirmation." />
        </div>
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Due-date rule: change from a date
// -------------------------------------------------------------------------------------------------

function jsonPreview(text: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = String(text ?? "").trim()
  if (!t) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(t) as unknown }
  } catch {
    return { ok: false, error: "Not valid JSON yet." }
  }
}

export function RuleChangeDialog({ row, open, onOpenChange }: { row: DueDateRuleRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const after = useAfterSave()
  const defaults: DueDateRuleChangeInput = {
    id: row.id,
    updated_at: row.updated_at,
    effective_from: "",
    new_code: "",
    title: row.title,
    form_code: row.form_code ?? "",
    frequency: row.frequency as ServiceFrequency,
    rule: JSON.stringify(row.rule ?? {}, null, 2),
    applies_to: JSON.stringify(row.applies_to ?? {}, null, 2),
    reminder_days: String(row.reminder_days),
    source_ref: "",
    verified: true,
  }
  const f = useActionForm(DueDateRuleChangeSchema, changeDueDateRule, {
    defaultValues: defaults,
    successMessage: (d) => `New version ${d.code} saved. The earlier rule stays in the history.`,
    onSuccess: after(() => onOpenChange(false)),
  })
  const v = useWatch({ control: f.control }) as Partial<DueDateRuleChangeInput>
  const from = v.effective_from ?? ""
  const plan = isDateString(from) ? planSupersede(row, from) : null

  // Suggest a code for the new version until the Partner types one.
  const codeTouched = f.form.formState.dirtyFields.new_code
  React.useEffect(() => {
    if (!codeTouched && isDateString(from)) f.form.setValue("new_code", suggestVersionCode(row.code, from), { shouldDirty: false })
  }, [from, codeTouched, row.code, f.form])

  const ruleJson = jsonPreview(v.rule)
  const ruleCheck = ruleJson.ok ? parseRuleSpec(ruleJson.value, (v.frequency ?? row.frequency) as ServiceFrequency) : null

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Change ${row.code}`}
      description={`${row.title} · in force ${inForceText(row.effective_from, row.effective_to)}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save new version"
      size="lg"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DateField control={f.control} name="effective_from" label="Applies to periods from" required helper="The current version closes the day before." />
        <TextField control={f.control} name="new_code" label="Code for the new version" required className={MONO} autoCapitalize="characters" spellCheck={false} />
        <TextField control={f.control} name="title" label="Title" required className="md:col-span-2" />
        <TextField control={f.control} name="form_code" label="Form" />
        <SelectField control={f.control} name="frequency" label="Frequency" required options={RULE_FREQUENCIES.map((x) => ({ value: x, label: SERVICE_FREQUENCY_LABELS[x] }))} />
        <TextareaField
          control={f.control}
          name="rule"
          label="Due-date rule"
          required
          rows={4}
          className={`md:col-span-2 ${MONO}`}
          helper='e.g. {"monthOffset": 1, "day": 20} or {"fixed": "07-31", "yearOffset": 1}.'
        />
        <TextareaField control={f.control} name="applies_to" label="Applies to" rows={3} className={`md:col-span-2 ${MONO}`} helper='e.g. {"serviceTypes": ["gst"], "gstScheme": "monthly"}. Empty applies to everyone with the service.' />
        <TextField control={f.control} name="reminder_days" label="Reminder days" required inputMode="numeric" />
        <TextField control={f.control} name="source_ref" label="Source" required helper="Notification or circular, with its date." />
        <div className="md:col-span-2">
          <SwitchField control={f.control} name="verified" label="I've checked this against the source" description="Leave off to list it as awaiting partner confirmation." />
        </div>
        <SettingPreview label="What happens">
          <ul className="flex flex-col gap-0.5">
            <li>
              {plan?.ok ? (
                <>
                  Periods from <span className="num font-medium">{formatDate(from)}</span> use the new version; {row.code} closes on <span className="num">{formatDate(plan.closeOldOn)}</span>. Events already generated keep their dates until the next top-up regenerates them.
                </>
              ) : plan && !plan.ok ? (
                <span className="text-danger-text">{plan.error}</span>
              ) : (
                <span className="text-text-muted">Choose the date the new version applies from.</span>
              )}
            </li>
            <li className={ruleCheck && !ruleCheck.ok ? "text-danger-text" : "text-text-muted"}>
              {!ruleJson.ok ? ruleJson.error : ruleCheck?.ok ? "The rule reads correctly." : ruleCheck?.error}
            </li>
          </ul>
        </SettingPreview>
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Government extension
// -------------------------------------------------------------------------------------------------

export function OverrideAddDialog({
  open,
  onOpenChange,
  rules,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  rules: Array<{ code: string; title: string; form_code: string | null }>
}) {
  const after = useAfterSave()
  const defaults: OverrideInput = { rule_code: "", period_label: "", original_due: "", extended_due: "", scope: "", source_ref: "" }
  const f = useActionForm(OverrideSchema, addOverride, {
    defaultValues: defaults,
    successMessage: (d) => (d.moved > 0 ? `Extension saved. ${d.moved} unfiled event${d.moved === 1 ? "" : "s"} moved to the new date.` : "Extension saved."),
    onSuccess: after(() => {
      onOpenChange(false)
      f.form.reset(defaults)
    }),
  })
  const v = useWatch({ control: f.control }) as Partial<OverrideInput>
  const rule = rules.find((r) => r.code === v.rule_code)
  const options = rules.map((r) => ({ value: r.code, label: r.code, description: r.title }))

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record a government extension"
      description="Every unfiled event for this rule and period moves to the extended date; its history cites the circular."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save and move events"
      size="lg"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ComboboxField control={f.control} name="rule_code" label="Rule" required options={options} placeholder="Choose the rule" searchPlaceholder="Code, form or title" className="md:col-span-2" />
        <TextField control={f.control} name="period_label" label="Period" required helper="Exactly as on the events: Sep 2026, Q2 2026-27 or AY 2026-27." />
        <TextField control={f.control} name="scope" label="Who it covers" helper="e.g. All assessees required to furnish a tax audit report." />
        <DateField control={f.control} name="original_due" label="Original due date" required />
        <DateField control={f.control} name="extended_due" label="Extended to" required />
        <TextField control={f.control} name="source_ref" label="Circular or notification" required className="md:col-span-2" helper="e.g. CBDT Circular 07/2026 dated 28 Sep 2026." />
        <SettingPreview label="What happens">
          {rule && v.period_label && isDateString(v.original_due ?? "") && isDateString(v.extended_due ?? "") ? (
            <>
              Unfiled <span className="font-medium">{rule.form_code ?? rule.code}</span> events for <span className="font-medium">{v.period_label}</span> move from{" "}
              <span className="num">{formatDate(v.original_due ?? "")}</span> to <span className="num font-medium">{formatDate(v.extended_due ?? "")}</span>; their reminders are planned again from the new date. Filed and cancelled events don&apos;t move.
            </>
          ) : (
            <span className="text-text-muted">Choose the rule, the period and both dates.</span>
          )}
        </SettingPreview>
      </div>
    </FormDialog>
  )
}

export function RemoveOverrideDialog({ row, open, onOpenChange }: { row: OverrideRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove the extension for ${row.rule_code} · ${row.period_label}?`}
      description={`Unfiled events it moved go back to ${formatDate(row.original_due)}, with a history line saying why. Use this only for an extension entered by mistake.`}
      confirmLabel="Remove extension"
      destructive
      onConfirm={async () => {
        const r = await removeOverride({ id: row.id })
        if (!r.ok) {
          toast.error(r.error)
          return false
        }
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        toast.success(r.data.moved > 0 ? `Extension removed. ${r.data.moved} event${r.data.moved === 1 ? "" : "s"} moved back.` : "Extension removed.")
        router.refresh()
      }}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Section concordance
// -------------------------------------------------------------------------------------------------

export function ConcordanceDialog({ row, open, onOpenChange }: { row: ConcordanceRow | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const after = useAfterSave()
  const defaults: ConcordanceInput = {
    id: row?.id ?? null,
    updated_at: row?.updated_at ?? null,
    topic: row?.topic ?? "",
    old_section: row?.old_section ?? "",
    new_section: row?.new_section ?? "",
    old_form: row?.old_form ?? "",
    new_form: row?.new_form ?? "",
    source_ref: row?.source_ref ?? "",
    verified: row?.verified ?? false,
  }
  const f = useActionForm(ConcordanceSchema, saveConcordance, {
    defaultValues: defaults,
    successMessage: row ? "Concordance row saved" : "Concordance row added",
    onSuccess: after(() => {
      onOpenChange(false)
      if (!row) f.form.reset(defaults)
    }),
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={row ? `Edit ${row.topic}` : "Add a concordance row"}
      description="How a provision of the Income-tax Act, 1961 maps to the Income-tax Act, 2025. Labels and PDFs pick the version that matches the record's tax year."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={row ? "Save row" : "Add row"}
      size="lg"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="topic" label="Topic" required className="md:col-span-2" />
        <TextField control={f.control} name="old_section" label="1961 Act section" helper="e.g. s.44AB" />
        <TextField control={f.control} name="new_section" label="2025 Act section" helper="e.g. s.63" />
        <TextField control={f.control} name="old_form" label="1961 Act form" helper="e.g. Form 3CA/3CB + 3CD" />
        <TextField control={f.control} name="new_form" label="2025 Act form" helper="e.g. Form 26" />
        <TextField control={f.control} name="source_ref" label="Source" className="md:col-span-2" helper="The CBDT mapping or rules it comes from." />
        <div className="md:col-span-2">
          <SwitchField control={f.control} name="verified" label="Checked against the CBDT's published mapping" description="Unchecked rows show as awaiting partner confirmation; PDFs then print the old section with “(corresponding provision of the Income-tax Act, 2025)”." />
        </div>
      </div>
    </FormDialog>
  )
}

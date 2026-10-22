"use client"

import { useWatch } from "react-hook-form"
import { cn } from "@/lib/utils"
import { checkSeriesPrefix, formatSeriesNumber, NUMBERING_DEFAULTS, SERIES, type SeriesKey } from "@/lib/domain/numbering"
import { NumberingSchema, type NumberingInput } from "@/lib/schemas/settings"
import { saveNumbering } from "@/server/actions/settings"
import type { FirmSettingsRow, LastChange } from "@/lib/data/settings"
import { TextField } from "@/components/app/form/fields"
import { SettingsCard } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"

export interface SeriesView {
  key: SeriesKey
  /** The number the counter gives next (an FY-scoped series that hasn't been used this FY: 1). */
  next_value: number
  updated_at: string | null
  /** The FY the counter last numbered in (FY-scoped series). */
  financial_year: string | null
}

const SERIES_LABEL: Record<SeriesKey, string> = {
  invoice: "Invoices",
  credit_note: "Credit notes",
  quotation: "Quotations",
  receipt: "Receipts",
  client_code: "Client codes",
  task: "Tasks",
  lead: "Leads",
}

const MAX = NUMBERING_DEFAULTS.gstDocumentMaxLength

/**
 * Settings → Numbering (§7.21, §0.1 rule 6): each series' prefix and the next number, with the next
 * document number as it will print and its length against GST Rule 46's 16 characters. Numbers
 * themselves only ever come from the locked counter in the database; this page moves the counter.
 */
export function NumberingForm({ row, series, lastChange, fy }: { row: FirmSettingsRow; series: SeriesView[]; lastChange: LastChange; fy: string }) {
  const defaults: NumberingInput = {
    updated_at: row.updated_at,
    invoice_prefix: row.invoice_prefix,
    credit_note_prefix: row.credit_note_prefix,
    quotation_prefix: row.quotation_prefix,
    receipt_prefix: row.receipt_prefix,
    client_code_prefix: row.client_code_prefix,
    series: series.map((s) => ({ key: s.key, next_value: String(s.next_value), updated_at: s.updated_at, loaded_next_value: s.next_value })),
  }
  const f = useSettingsForm(NumberingSchema, saveNumbering, defaults, { savedMessage: "Numbering saved" })
  const v = useWatch({ control: f.control }) as Partial<NumberingInput>

  return (
    <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save numbering">
      <SettingsCard
        title="Document series"
        description={`Invoices, credit notes, quotations and receipts restart at 1 each financial year and read prefix/${fy.slice(2)}/0001. GST allows at most ${MAX} characters: letters, digits, - and /.`}
        columns={1}
        bodyClassName="gap-y-0 px-0 py-0 md:px-0 md:py-0"
      >
        <div role="table" aria-label="Document series" className="min-w-0">
          <div role="row" className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_7.5rem_minmax(0,1.4fr)] gap-4 border-b border-border px-5 py-2 text-xs text-text-muted md:grid">
            <span role="columnheader">Series</span>
            <span role="columnheader">Prefix</span>
            <span role="columnheader" className="text-right">
              Next number
            </span>
            <span role="columnheader" className="text-right">
              Next document number
            </span>
          </div>
          {series.map((s, i) => {
            const def = SERIES[s.key]
            const prefixName = def.prefixSetting
            const prefix = prefixName ? String(v[prefixName] ?? "") : def.defaultPrefix
            const nextRaw = String(v.series?.[i]?.next_value ?? "")
            const next = /^\d+$/.test(nextRaw.trim()) ? Number(nextRaw) : null
            const prefixCheck = checkSeriesPrefix(s.key, prefix, { fy })
            let sample: string | null = null
            try {
              sample = prefixCheck.ok && next && next >= 1 ? formatSeriesNumber(s.key, { seq: next, prefix: prefixCheck.prefix, fy }) : null
            } catch {
              sample = null
            }
            const tooLong = sample !== null && sample.length > MAX
            const lowered = next !== null && next < s.next_value
            const raised = next !== null && next > s.next_value
            return (
              <div
                role="row"
                key={s.key}
                className="grid grid-cols-1 gap-3 border-b border-border px-4 py-3.5 last:border-b-0 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_7.5rem_minmax(0,1.4fr)] md:items-start md:gap-4 md:px-5"
              >
                <div role="cell" className="min-w-0 md:pt-2">
                  <p className="text-base font-medium text-text">{SERIES_LABEL[s.key]}</p>
                  <p className="text-sm text-text-muted">
                    {def.fyScoped
                      ? s.financial_year && s.financial_year !== fy
                        ? `Last used in FY ${s.financial_year}; restarts at 1 for FY ${fy}.`
                        : `FY ${fy}`
                      : "One running series"}
                  </p>
                </div>
                <div role="cell" className="min-w-0">
                  <span aria-hidden="true" className="mb-1 block text-xs text-text-muted md:hidden">
                    Prefix
                  </span>
                  {prefixName ? (
                    <TextField control={f.control} name={prefixName} label={`${SERIES_LABEL[s.key]} prefix`} hideLabel autoCapitalize="characters" spellCheck={false} maxLength={14} />
                  ) : (
                    <p className="pt-2 font-mono text-base text-text" aria-label={`${SERIES_LABEL[s.key]} prefix, fixed`}>
                      {def.defaultPrefix} <span className="font-sans text-sm text-text-muted">(fixed)</span>
                    </p>
                  )}
                </div>
                <div role="cell" className="min-w-0">
                  <span aria-hidden="true" className="mb-1 block text-xs text-text-muted md:hidden">
                    Next number
                  </span>
                  <TextField
                    control={f.control}
                    name={`series.${i}.next_value`}
                    label={`Next ${def.noun} number`}
                    hideLabel
                    inputMode="numeric"
                    className="[&_input]:text-right [&_input]:tabular-nums"
                  />
                </div>
                <div role="cell" className="min-w-0 md:pt-2 md:text-right" aria-live="polite">
                  {sample ? (
                    <>
                      <p className={cn("font-mono text-base break-all", tooLong ? "text-danger-text" : "text-text")}>{sample}</p>
                      <p className={cn("num text-sm", tooLong ? "text-danger-text" : "text-text-muted")}>
                        {sample.length} of {MAX} characters
                        {lowered ? " · lowered: checked against numbers already issued" : raised && (s.key === "invoice" || s.key === "credit_note") && s.next_value > 1 ? " · skips numbers" : ""}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-text-muted">{prefixCheck.ok ? "Enter a whole number from 1." : "Fix the prefix to see the number."}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </SettingsCard>
      <p className="text-sm text-text-muted">
        Changing a prefix doesn&apos;t touch documents already issued: they keep their numbers. A counter can be lowered only when none of the numbers in between have been issued.
      </p>
    </SettingsForm>
  )
}

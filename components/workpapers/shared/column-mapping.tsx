"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { formatCount } from "@/components/app/data-table/params"
import type { FieldSpec, MappingSource } from "@/lib/domain/gstr2b"
import { HEADER_SCAN_ROWS } from "@/components/workpapers/shared/sheet"

const SOURCE_TEXT: Record<MappingSource, { label: string; tone: string; title: string }> = {
  saved: { label: "Remembered", tone: "text-success-text", title: "The column chosen for this client last time." },
  exact: { label: "Matched", tone: "text-text-muted", title: "The header is one of the usual names for this field." },
  partial: { label: "Guessed: check", tone: "text-warning-text", title: "The header contains a usual name for this field. Check it is the right column." },
}

export type MappingStepProps<F extends string> = {
  /** "Purchase register" / "Trial balance", for the headings. */
  what: string
  fileName: string
  specs: readonly FieldSpec<F>[]
  headers: string[]
  preview: string[][]
  rowCount: number
  truncated: boolean
  mapping: Record<F, string | null>
  sources: Partial<Record<F, MappingSource | null>>
  onChange: (field: F, header: string | null) => void
  errors?: Partial<Record<F, string>>
  sheets: string[]
  sheet: string | null
  onSheetChange: (sheet: string) => void
  headerRow: number
  onHeaderRowChange: (row: number) => void
  /** The file is being read again (another sheet or header row). */
  busy?: boolean
  remember: boolean
  onRememberChange: (v: boolean) => void
  /** True when the mapping started from the client's saved one. */
  remembered: boolean
  /** A note under the fields (e.g. "debit and credit, or one balance column"). */
  note?: React.ReactNode
  /** Extra controls under the fields (e.g. which side a positive balance is). */
  extra?: React.ReactNode
}

/**
 * The column-mapping step (§6.12 "through a column-mapping step", §6.13, §7.8.1 step 3, §7.8.3
 * step 3), shared by the purchase register and the trial balance: for every field, the file's
 * column that holds it (suggested from the client's remembered mapping, then the usual header
 * names), the sheet and header row when the file has title rows above the table, and a preview of
 * the first rows with the chosen columns marked. Two columns on desktop, stacked on a phone; the
 * preview scrolls inside its own frame.
 */
export function ColumnMappingStep<F extends string>(props: MappingStepProps<F>) {
  const { what, fileName, specs, headers, preview, rowCount, truncated, mapping, sources, onChange, errors, sheets, sheet, onSheetChange, headerRow, onHeaderRowChange, busy, remember, onRememberChange, remembered, note, extra } = props
  const baseId = React.useId()
  const used = new Map<string, string>()
  for (const s of specs) {
    const h = mapping[s.field]
    if (h) used.set(h, s.label)
  }

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text-muted">
            {fileName} · {formatCount(rowCount)} {rowCount === 1 ? "row" : "rows"}
            {truncated ? " (only the first 1,00,000 are read)" : ""}
          </p>
          <p className="text-sm text-text-muted">
            {remembered ? `Started from the columns chosen for this client last time.` : `Choose the column that holds each field. The choice is remembered for this client.`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {sheets.length > 1 ? (
            <div className="col-span-2 flex min-w-0 flex-col gap-1.5 sm:col-span-1">
              <label htmlFor={`${baseId}-sheet`} className="text-sm font-medium text-text">
                Sheet
              </label>
              <div className="[&>div]:w-full">
                <NativeSelect id={`${baseId}-sheet`} value={sheet ?? ""} disabled={busy} onChange={(e) => onSheetChange(e.target.value)}>
                  {sheets.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {s}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          ) : null}
          <div className="col-span-2 flex min-w-0 flex-col gap-1.5 sm:col-span-1">
            <label htmlFor={`${baseId}-header`} className="text-sm font-medium text-text">
              Header row
            </label>
            <div className="[&>div]:w-full">
              <NativeSelect id={`${baseId}-header`} value={String(headerRow)} disabled={busy} onChange={(e) => onHeaderRowChange(Number(e.target.value))}>
                {Array.from({ length: HEADER_SCAN_ROWS }, (_, i) => i + 1).map((n) => (
                  <NativeSelectOption key={n} value={String(n)}>
                    Row {n}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
        </div>

        <fieldset className="flex min-w-0 flex-col gap-3" disabled={busy}>
          <legend className="mb-1 text-md font-semibold text-text">Columns in the {what.toLowerCase()}</legend>
          {specs.map((s) => {
            const id = `${baseId}-${s.field}`
            const err = errors?.[s.field]
            const source = sources[s.field] ?? null
            const value = mapping[s.field] ?? ""
            return (
              <div key={s.field} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor={id} className="text-sm font-medium text-text">
                    {s.label}
                    {s.required ? <span className="text-danger-text"> *</span> : null}
                  </label>
                  {source && value ? (
                    <span className={cn("text-xs", SOURCE_TEXT[source].tone)} title={SOURCE_TEXT[source].title}>
                      {SOURCE_TEXT[source].label}
                    </span>
                  ) : null}
                </div>
                <div className="[&>div]:w-full">
                  <NativeSelect
                    id={id}
                    value={value}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={err ? `${id}-error` : undefined}
                    onChange={(e) => onChange(s.field, e.target.value === "" ? null : e.target.value)}
                  >
                    <NativeSelectOption value="">{s.required ? "Choose a column" : "Not in this file"}</NativeSelectOption>
                    {headers.map((h) => (
                      <NativeSelectOption key={h} value={h} disabled={used.has(h) && h !== value}>
                        {h}
                        {used.has(h) && h !== value ? ` (used for ${used.get(h)?.toLowerCase()})` : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                {err ? (
                  <p id={`${id}-error`} className="text-sm text-danger-text">
                    {err}
                  </p>
                ) : null}
              </div>
            )
          })}
        </fieldset>
        {note ? <p className="text-sm text-text-muted">{note}</p> : null}
        {extra}
        <label className="flex items-start gap-2 text-sm text-text">
          <Checkbox checked={remember} onCheckedChange={(v) => onRememberChange(v === true)} className="mt-0.5" />
          <span>Remember these columns for this client</span>
        </label>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-md font-semibold text-text">First rows</h3>
          {busy ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
              <Spinner className="size-3.5" /> Reading the file
            </span>
          ) : null}
        </div>
        <div className="max-h-[min(28rem,50dvh)] overflow-auto rounded-lg border border-border bg-surface">
          <table className="w-max min-w-full border-collapse text-sm">
            <caption className="sr-only">The first rows of the {what.toLowerCase()}, with the chosen columns marked</caption>
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                {headers.map((h) => {
                  const field = used.get(h)
                  return (
                    <th key={h} scope="col" className={cn("h-9 border-b border-border px-3 text-left align-bottom font-normal whitespace-nowrap text-text-muted", field && "text-text")}>
                      <span className="block">{h}</span>
                      <span className={cn("block text-xs", field ? "font-medium text-primary" : "text-text-muted/70")}>{field ?? "Not used"}</span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {preview.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(1, headers.length)} className="px-3 py-4 text-text-muted">
                    No rows under the header. Choose another header row or sheet.
                  </td>
                </tr>
              ) : (
                preview.map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    {row.map((cell, j) => (
                      <td key={j} className={cn("h-9 max-w-[16rem] truncate px-3 whitespace-nowrap", used.has(headers[j] ?? "") ? "text-text" : "text-text-muted")} title={cell}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

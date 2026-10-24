"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { formatCount } from "@/components/app/data-table/params"
import { validateColumnMapping, type MappingSource } from "@/lib/domain/gstr2b"
import { TB_FIELD_SPECS, type TbField } from "@/lib/domain/schedule3"
import { yearEndedLabel } from "@/lib/schemas/financial-statements"
import { inspectTrialBalance, type InspectedTrialBalance } from "@/server/actions/financial-statements"
import { SheetUpload, type UploadedSheet } from "@/components/workpapers/shared/sheet-upload"
import { ColumnMappingStep } from "@/components/workpapers/shared/column-mapping"

export type TbMapping = Record<TbField, string | null>
const EMPTY_MAPPING = Object.fromEntries(TB_FIELD_SPECS.map((s) => [s.field, null])) as TbMapping

/** The mapping is complete with the ledger name and either debit and credit, or one balance column. */
export function tbMappingErrors(mapping: TbMapping, headers: string[]): Partial<Record<TbField, string>> | null {
  const base = validateColumnMapping(mapping, headers, TB_FIELD_SPECS)
  const out: Partial<Record<TbField, string>> = {}
  for (const [k, v] of Object.entries(base ?? {})) out[k as TbField] = v[0]
  if (!(mapping.debit && mapping.credit) && !mapping.balance) out.debit = "Choose the debit and credit columns, or one closing-balance column."
  return Object.keys(out).length ? out : null
}

/**
 * The trial balance being imported (§7.8.3 steps 2–3): the uploaded file, what the server read from
 * it (sheets, header row, preview, the suggested columns remembered per client), the columns the
 * person chose, and which side a bare balance is. Shared by "New statement" and "Load a revised
 * trial balance".
 */
export function useTbImport(clientId: string | null) {
  const [tb, setTb] = React.useState<UploadedSheet | null>(null)
  const [inspected, setInspected] = React.useState<InspectedTrialBalance | null>(null)
  const [inspecting, setInspecting] = React.useState(false)
  const [inspectError, setInspectError] = React.useState<string | null>(null)
  const [mapping, setMapping] = React.useState<TbMapping>(EMPTY_MAPPING)
  const [sources, setSources] = React.useState<Partial<Record<TbField, MappingSource | null>>>({})
  const [positive, setPositive] = React.useState<"debit" | "credit">("debit")
  const [remember, setRemember] = React.useState(true)

  const inspect = async (file: UploadedSheet, opts: { sheet?: string | null; headerRow?: number | null; keepMapping?: boolean } = {}) => {
    if (!clientId) return
    setInspecting(true)
    setInspectError(null)
    const r = await inspectTrialBalance({ clientId, documentId: file.documentId, sheet: opts.sheet ?? null, headerRow: opts.headerRow ?? null })
    setInspecting(false)
    if (!r.ok) {
      setInspected(null)
      setInspectError(r.fieldErrors?.file?.[0] ?? (r.ref ? `${r.error} (Ref ${r.ref})` : r.error))
      return
    }
    setInspected(r.data)
    setPositive(r.data.positiveBalanceIs)
    if (!opts.keepMapping) {
      setMapping({ ...EMPTY_MAPPING, ...r.data.suggestion.mapping })
      setSources(r.data.suggestion.sources)
    } else {
      setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v && r.data.headers.includes(v) ? v : (r.data.suggestion.mapping[k as TbField] ?? null)])) as TbMapping)
    }
  }

  return {
    tb,
    inspected,
    inspecting,
    inspectError,
    mapping,
    sources,
    positive,
    remember,
    setPositive,
    setRemember,
    errors: inspected ? tbMappingErrors(mapping, inspected.headers) : null,
    uploaded: (file: UploadedSheet) => {
      setTb(file)
      void inspect(file)
    },
    reset: () => {
      setTb(null)
      setInspected(null)
      setInspectError(null)
    },
    reread: (opts: { sheet?: string | null; headerRow?: number | null; keepMapping?: boolean }) => {
      if (tb) void inspect(tb, opts)
    },
    choose: (field: TbField, header: string | null) => {
      setMapping((m) => ({ ...m, [field]: header }))
      setSources((s) => ({ ...s, [field]: null }))
    },
    /** What the create and replace actions take. */
    payload: () =>
      tb && inspected
        ? { file: { documentId: tb.documentId, sheet: inspected.sheet, headerRow: inspected.headerRow }, mapping, positiveBalanceIs: positive, rememberMapping: remember }
        : null,
  }
}

export type TbImportState = ReturnType<typeof useTbImport>

/** Upload the trial balance into the client's documents and read it. */
export function TbFileStep({ imp, clientId, fy, error, intro }: { imp: TbImportState; clientId: string; fy: string; error?: string | null; intro?: React.ReactNode }) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h3 className="text-md font-semibold text-text">Trial balance for FY {fy}</h3>
      <p className="text-sm text-text-muted">
        {intro ?? (
          <>
            The closing trial balance for the year ended {yearEndedLabel(fy)}: every ledger with its group and its debit or credit balance. Tally&apos;s &ldquo;Trial Balance&rdquo; export works as it is.
          </>
        )}
      </p>
      <SheetUpload
        clientId={clientId}
        title={`Trial balance · FY ${fy}`}
        category="other"
        financialYear={fy}
        period={null}
        tags={["Trial balance", "Financial statements"]}
        uploaded={imp.tb}
        label="Drop the trial balance here, or choose it."
        onUploaded={imp.uploaded}
        onReplace={imp.reset}
        error={imp.inspectError ?? error ?? null}
      />
      {imp.tb && imp.inspecting ? <p className="text-sm text-text-muted">Reading the trial balance…</p> : null}
      {imp.tb && imp.inspected ? (
        <p className="text-sm text-text-muted">
          Read {formatCount(imp.inspected.rowCount)} rows under the header on row {imp.inspected.headerRow}
          {imp.inspected.sheet ? ` of the sheet “${imp.inspected.sheet}”` : ""}. Check the columns next.
        </p>
      ) : null}
    </div>
  )
}

/** Which column holds what (remembered per client), and which side a bare balance is. */
export function TbColumnsStep({ imp, fieldErrors }: { imp: TbImportState; fieldErrors: Record<string, string> }) {
  const inspected = imp.inspected
  if (!inspected || !imp.tb) return null
  const usesBalance = Boolean(imp.mapping.balance && !(imp.mapping.debit && imp.mapping.credit))
  return (
    <ColumnMappingStep
      what="Trial balance"
      fileName={inspected.fileName}
      specs={TB_FIELD_SPECS}
      headers={inspected.headers}
      preview={inspected.preview}
      rowCount={inspected.rowCount}
      truncated={inspected.truncated}
      mapping={imp.mapping}
      sources={imp.sources}
      onChange={imp.choose}
      errors={{ ...(imp.errors ?? {}), ...Object.fromEntries(TB_FIELD_SPECS.map((s) => [s.field, fieldErrors[s.field]]).filter(([, v]) => v)) }}
      sheets={inspected.sheets}
      sheet={inspected.sheet}
      onSheetChange={(sheet) => imp.reread({ sheet })}
      headerRow={inspected.headerRow}
      onHeaderRowChange={(row) => imp.reread({ sheet: inspected.sheet, headerRow: row, keepMapping: true })}
      busy={imp.inspecting}
      remember={imp.remember}
      onRememberChange={imp.setRemember}
      remembered={inspected.remembered}
      note="Use the closing debit and credit columns, or one closing-balance column (with Dr / Cr, or signed). Opening balances are left out."
      extra={
        usesBalance ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text">A balance without Dr or Cr is</legend>
            <RadioGroup value={imp.positive} onValueChange={(v) => imp.setPositive(v === "credit" ? "credit" : "debit")} className="grid grid-cols-2 gap-2">
              {(["debit", "credit"] as const).map((side) => (
                <label key={side} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm", imp.positive === side ? "border-primary bg-primary-soft/40" : "border-border hover:bg-surface-2")}>
                  <RadioGroupItem value={side} aria-label={side === "debit" ? "Positive is debit" : "Positive is credit"} />
                  {side === "debit" ? "Positive = debit" : "Positive = credit"}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
        ) : null
      }
    />
  )
}

/** Server field errors keyed as the steps show them ("mapping.debit" → "debit"). */
export function stepFieldErrors(fieldErrors: Record<string, string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fieldErrors ?? {})) out[k.startsWith("mapping.") ? k.slice(8) : k] = v[0]
  return out
}

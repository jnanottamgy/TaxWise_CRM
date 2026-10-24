"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Papa from "papaparse"
import { CircleAlertIcon, CircleCheckIcon, DownloadIcon, FileUpIcon, TriangleAlertIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { cn } from "@/lib/utils"
import { todayIST } from "@/lib/domain/fy"
import {
  FILING_IMPORT_COLUMNS,
  FILING_IMPORT_MAX_ROWS,
  FILING_IMPORT_TEMPLATE_CSV,
  checkFilingImport,
  mapFilingHeaders,
  type FilingImportCheck,
  type FilingImportKey,
  type FilingImportRow,
} from "@/lib/schemas/registers"
import { importPriorFilings } from "@/server/actions/filing-history"
import { searchClientsForRegisters } from "@/server/actions/registrations"

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(FILING_IMPORT_TEMPLATE_CSV)}`
const MAX_BYTES = 2 * 1024 * 1024
const SKIP = "__skip__"

type Parsed = { fileName: string; headers: string[]; data: Array<Record<string, string>> }
type Step =
  | { kind: "choose" }
  | { kind: "map"; parsed: Parsed; mapping: Partial<Record<FilingImportKey, string>> }
  | { kind: "report"; parsed: Parsed; checks: FilingImportCheck[]; valid: FilingImportRow[] }
  | { kind: "done"; inserted: number; skipped: number }

async function searchClients(q: string): Promise<ComboOption[]> {
  const r = await searchClientsForRegisters({ q })
  if (!r.ok) throw new Error(r.error)
  return r.data
}

/**
 * "Import prior filings" (§7.15.2) for a client moving from another CA: a CSV with FY, form, period,
 * filed on, acknowledgement no. and previous firm (the template, or the firm typed here for every
 * row). Headings are matched for you and can be changed; every row is checked (FY or AY, the form
 * cleaned, dates day first and not in the future) and only valid rows go in, in one transaction that
 * skips what is already on record. Partners and Managers.
 */
export function ImportFilingsDialog({ fixedClient, variant = "outline" }: { fixedClient?: { id: string; name: string } | null; variant?: "default" | "outline" }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [clientId, setClientId] = React.useState<string | null>(fixedClient?.id ?? null)
  const [clientLabel, setClientLabel] = React.useState<string | undefined>(fixedClient?.name)
  const [firm, setFirm] = React.useState("")
  const [step, setStep] = React.useState<Step>({ kind: "choose" })
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [busy, setBusy] = React.useState<"parse" | "import" | null>(null)
  const [showOk, setShowOk] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const ids = { client: React.useId(), firm: React.useId() }

  const reset = () => {
    setStep({ kind: "choose" })
    setError(null)
    setShowOk(false)
    if (!fixedClient) {
      setClientId(null)
      setClientLabel(undefined)
    }
    setFirm("")
    if (inputRef.current) inputRef.current.value = ""
  }
  const close = () => {
    setOpen(false)
    if (step.kind === "done") router.refresh()
    reset()
  }

  const read = (file: File) => {
    setError(null)
    if (!/\.csv$/i.test(file.name)) {
      setError({ message: "Choose a CSV file. In Excel, use File → Save as → CSV (Comma delimited)." })
      return
    }
    if (file.size > MAX_BYTES) {
      setError({ message: `The file is larger than 2 MB. Import at most ${FILING_IMPORT_MAX_ROWS.toLocaleString("en-IN")} filings at a time.` })
      return
    }
    setBusy("parse")
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        setBusy(null)
        const headers = (res.meta.fields ?? []).filter((h) => h.length > 0)
        if (headers.length === 0) return setError({ message: "The first row of the file must name the columns. Download the template to see them." })
        if (res.data.length === 0) return setError({ message: "The file has a header row but no filings under it." })
        if (res.data.length > FILING_IMPORT_MAX_ROWS) return setError({ message: `The file has ${res.data.length.toLocaleString("en-IN")} rows. Import at most ${FILING_IMPORT_MAX_ROWS.toLocaleString("en-IN")} at a time.` })
        setStep({ kind: "map", parsed: { fileName: file.name, headers, data: res.data }, mapping: mapFilingHeaders(headers) })
      },
      error: () => {
        setBusy(null)
        setError({ message: "The file couldn't be read. Check it's a CSV file and try again." })
      },
    })
  }

  const runCheck = () => {
    if (step.kind !== "map") return
    if (!clientId) return setError({ message: "Choose the client these filings belong to." })
    const missing = FILING_IMPORT_COLUMNS.filter((c) => c.required && !step.mapping[c.key] && !(c.key === "filed_by_external" && firm.trim()))
    if (missing.length) return setError({ message: `Choose which column holds the ${missing.map((c) => c.label).join(" and ")}${missing.some((c) => c.key === "filed_by_external") ? ", or type the previous firm above" : ""}.` })
    setError(null)
    const { checks, valid } = checkFilingImport(step.parsed.data, { mapping: step.mapping, defaultFirm: firm, today: todayIST() })
    setStep({ kind: "report", parsed: step.parsed, checks, valid })
  }

  const doImport = async () => {
    if (step.kind !== "report" || !clientId || step.valid.length === 0) return
    setBusy("import")
    setError(null)
    try {
      const r = await importPriorFilings({ clientId, fileName: step.parsed.fileName, rows: step.valid })
      if (!r.ok) return setError({ message: r.error, ref: r.ref })
      setStep({ kind: "done", inserted: r.data.inserted, skipped: r.data.skipped })
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setBusy(null)
    }
  }

  const footer =
    step.kind === "done" ? (
      <div className="ml-auto">
        <Button onClick={close}>Done</Button>
      </div>
    ) : (
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" onClick={step.kind === "choose" ? close : reset} disabled={busy !== null}>
          {step.kind === "choose" ? "Cancel" : "Start again"}
        </Button>
        {step.kind === "choose" ? (
          <Button onClick={() => inputRef.current?.click()} disabled={busy !== null}>
            {busy === "parse" ? <Spinner /> : <FileUpIcon aria-hidden="true" />}
            Choose CSV file
          </Button>
        ) : step.kind === "map" ? (
          <Button onClick={runCheck}>Check rows</Button>
        ) : (
          <Button onClick={doImport} disabled={busy !== null || step.valid.length === 0}>
            {busy === "import" ? <Spinner /> : <UploadIcon aria-hidden="true" />}
            {step.valid.length === 0 ? "Nothing to import" : `Import ${step.valid.length.toLocaleString("en-IN")} ${step.valid.length === 1 ? "filing" : "filings"}`}
          </Button>
        )}
      </div>
    )

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <UploadIcon aria-hidden="true" />
        Import prior filings
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return
          if (!o) close()
          else setOpen(true)
        }}
        size="lg"
        title="Import prior filings"
        description="A client's filing history from their previous CA. Every row is checked first; only valid rows are imported."
        footer={footer}
        pending={busy !== null}
      >
        {error ? <FormAlert error={error} className="mb-4" /> : null}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) read(file)
          }}
        />

        {step.kind !== "done" ? (
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.client}>
                Client<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
              </Label>
              {fixedClient ? (
                <p id={ids.client} className="flex h-9 items-center text-base text-text">
                  {fixedClient.name}
                </p>
              ) : (
                <Combobox
                  id={ids.client}
                  value={clientId}
                  onChange={(v, o) => {
                    setClientId(v)
                    setClientLabel(o?.label)
                  }}
                  loadOptions={searchClients}
                  selectedLabel={clientLabel}
                  placeholder="Choose a client"
                  searchPlaceholder="Name, code or PAN"
                  clearable={false}
                  aria-required
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.firm}>Previous firm</Label>
              <Input id={ids.firm} value={firm} onChange={(e) => setFirm(e.target.value)} placeholder="For rows without a Previous firm column" maxLength={160} />
            </div>
          </div>
        ) : null}

        {step.kind === "choose" ? (
          <div className="flex flex-col gap-3 text-base">
            <p className="text-text">
              Columns: <span className="font-medium">FY</span>, <span className="font-medium">Form</span>, Period, Filed on, Acknowledgement no., <span className="font-medium">Previous firm</span>, Notes. Dates are read day first (31/07/2025); an AY is read as its FY.
            </p>
            <div>
              <Button asChild variant="outline" size="sm">
                <a href={TEMPLATE_HREF} download="taxwise-prior-filings-template.csv">
                  <DownloadIcon aria-hidden="true" />
                  Download the template
                </a>
              </Button>
            </div>
          </div>
        ) : null}

        {step.kind === "map" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              {step.parsed.fileName} · {step.parsed.data.length.toLocaleString("en-IN")} {step.parsed.data.length === 1 ? "row" : "rows"}. Check which column holds what.
            </p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Column mapping</caption>
                <thead>
                  <tr className="bg-surface-2 text-left text-xs text-text-muted">
                    <th scope="col" className="px-3 py-2 font-medium">Field</th>
                    <th scope="col" className="px-3 py-2 font-medium">Column in the file</th>
                  </tr>
                </thead>
                <tbody>
                  {FILING_IMPORT_COLUMNS.map((c) => (
                    <tr key={c.key} className="border-t border-border/70">
                      <td className="px-3 py-1.5 whitespace-nowrap text-text">
                        {c.label}
                        {c.required ? <span className="ml-0.5 text-danger-text">*</span> : null}
                      </td>
                      <td className="px-3 py-1.5">
                        <select
                          aria-label={`Column for ${c.label}`}
                          className="h-9 w-full max-w-xs rounded-md border border-border bg-surface px-2 text-sm text-text focus-visible:outline-2 focus-visible:outline-ring"
                          value={step.mapping[c.key] ?? SKIP}
                          onChange={(e) => setStep({ ...step, mapping: { ...step.mapping, [c.key]: e.target.value === SKIP ? undefined : e.target.value } })}
                        >
                          <option value={SKIP}>{c.key === "filed_by_external" ? "Use the firm typed above" : "Not in the file"}</option>
                          {step.parsed.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {step.kind === "report" ? <Report checks={step.checks} valid={step.valid.length} showOk={showOk} onToggleOk={() => setShowOk((v) => !v)} /> : null}

        {step.kind === "done" ? (
          <div className="flex flex-col gap-2 text-base">
            <p className="flex items-center gap-2 text-text">
              <CircleCheckIcon aria-hidden="true" className="size-5 text-success-text" />
              {step.inserted.toLocaleString("en-IN")} {step.inserted === 1 ? "filing" : "filings"} added to {clientLabel ?? fixedClient?.name ?? "the client"}&apos;s history
              {step.skipped ? `; ${step.skipped.toLocaleString("en-IN")} already on record and left as they were` : ""}.
            </p>
            <p className="text-sm text-text-muted">They show as Inherited in the filing history, with the previous firm.</p>
          </div>
        ) : null}
      </FormDialog>
    </>
  )
}

function Report({ checks, valid, showOk, onToggleOk }: { checks: FilingImportCheck[]; valid: number; showOk: boolean; onToggleOk: () => void }) {
  const invalid = checks.filter((c) => c.errors.length).length
  const warned = checks.filter((c) => !c.errors.length && c.warnings.length).length
  const shown = checks.filter((c) => showOk || c.errors.length || c.warnings.length)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-border">
        {[
          { label: "Ready to import", value: valid, tone: "text-text" },
          { label: "With problems", value: invalid, tone: invalid ? "text-danger-text" : "text-text" },
          { label: "With warnings", value: warned, tone: "text-text" },
        ].map((k, i) => (
          <div key={k.label} className={cn("px-4 py-3", i > 0 && "border-l border-border")}>
            <div className="text-sm text-text-muted">{k.label}</div>
            <div className={cn("num text-xl font-semibold tabular-nums", k.tone)}>{k.value.toLocaleString("en-IN")}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-text-muted">{invalid ? "Rows with problems are left out. Fix them in the file and import it again." : "Every row can be imported."}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onToggleOk}>
          {showOk ? "Show only rows to look at" : "Show every row"}
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">Nothing to look at: every row is ready.</p>
      ) : (
        <ul className="flex max-h-[min(22rem,45dvh)] flex-col divide-y divide-border/70 overflow-y-auto rounded-lg border border-border">
          {shown.map((c) => (
            <li key={c.line} className="flex gap-3 px-3 py-2">
              <span className="num w-14 flex-none text-sm text-text-muted tabular-nums">Line {c.line}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {c.errors.length ? (
                    <CircleAlertIcon aria-hidden="true" className="size-4 flex-none text-danger-text" />
                  ) : c.warnings.length ? (
                    <TriangleAlertIcon aria-hidden="true" className="size-4 flex-none text-warning-text" />
                  ) : (
                    <CircleCheckIcon aria-hidden="true" className="size-4 flex-none text-success-text" />
                  )}
                  <span className="truncate text-base font-medium text-text">{c.row ? `${c.row.filing_type}${c.row.period ? ` · ${c.row.period}` : ""} · FY ${c.row.financial_year}` : c.errors.length ? "Left out" : "Repeats an earlier line"}</span>
                  <span className="sr-only">{c.errors.length ? "left out" : c.warnings.length ? "imported, with warnings" : "ready"}</span>
                </div>
                {c.errors.map((e) => (
                  <p key={e} className="text-sm text-danger-text">
                    {e}
                  </p>
                ))}
                {c.warnings.map((w) => (
                  <p key={w} className="text-sm text-warning-text">
                    {w}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

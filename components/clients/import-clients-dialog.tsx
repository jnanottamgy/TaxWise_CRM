"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import Papa from "papaparse"
import { CircleAlertIcon, CircleCheckIcon, DownloadIcon, FileUpIcon, TriangleAlertIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { cn } from "@/lib/utils"
import {
  IMPORT_COLUMNS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATE_CSV,
  autoMapHeaders,
  missingImportKeys,
  type ImportKey,
  type RawImportRow,
} from "@/lib/schemas/clients"
import { importClients, previewClientImport, type ImportOutcome, type ImportReportRow } from "@/server/actions/client-import"

type Parsed = { fileName: string; headers: string[]; data: Array<Record<string, string>> }
type Step =
  | { kind: "choose" }
  | { kind: "map"; parsed: Parsed; mapping: Record<string, ImportKey | null> }
  | { kind: "report"; parsed: Parsed; rows: RawImportRow[]; report: ImportReportRow[]; valid: number }
  | { kind: "done"; outcome: ImportOutcome }

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE_CSV)}`
const SKIP = "__skip__"

function mapRows(parsed: Parsed, mapping: Record<string, ImportKey | null>): RawImportRow[] {
  return parsed.data.map((r) => {
    const out: RawImportRow = {}
    for (const h of parsed.headers) {
      const key = mapping[h]
      if (key && typeof r[h] === "string") out[key] = r[h]
    }
    return out
  })
}

/**
 * Import clients from CSV (§7.3.4): a downloadable template, header mapping (headers are matched
 * automatically and can be changed), a row-level validation report checked against the firm's
 * data (invalid PAN/GSTIN, duplicate code/PAN/GSTIN, unknown owner, unknown group …), then
 * "Import N valid rows". Partner/Manager.
 */
export function ImportClientsDialog() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [step, setStep] = React.useState<Step>({ kind: "choose" })
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [busy, setBusy] = React.useState<"parse" | "check" | "import" | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [showOk, setShowOk] = React.useState(false)

  const reset = () => {
    setStep({ kind: "choose" })
    setError(null)
    setShowOk(false)
    if (inputRef.current) inputRef.current.value = ""
  }

  const read = (file: File) => {
    setError(null)
    if (!/\.csv$/i.test(file.name)) {
      setError({ message: "Choose a CSV file. In Excel, use File → Save as → CSV (Comma delimited)." })
      return
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setError({ message: `The file is larger than 2 MB. Import at most ${IMPORT_MAX_ROWS.toLocaleString("en-IN")} clients at a time.` })
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
        if (headers.length === 0) {
          setError({ message: "The first row of the file must name the columns. Download the template to see them." })
          return
        }
        if (res.data.length === 0) {
          setError({ message: "The file has a header row but no clients under it." })
          return
        }
        if (res.data.length > IMPORT_MAX_ROWS) {
          setError({ message: `The file has ${res.data.length.toLocaleString("en-IN")} rows. Import at most ${IMPORT_MAX_ROWS.toLocaleString("en-IN")} at a time.` })
          return
        }
        setStep({ kind: "map", parsed: { fileName: file.name, headers, data: res.data }, mapping: autoMapHeaders(headers) })
      },
      error: () => {
        setBusy(null)
        setError({ message: "The file couldn't be read. Check it's a CSV file and try again." })
      },
    })
  }

  const check = async () => {
    if (step.kind !== "map") return
    const missing = missingImportKeys(step.mapping)
    if (missing.length) {
      setError({ message: `Choose which column holds the ${missing.map((k) => IMPORT_COLUMNS.find((c) => c.key === k)?.header ?? k).join(" and ")}.` })
      return
    }
    const rows = mapRows(step.parsed, step.mapping)
    setBusy("check")
    setError(null)
    try {
      const r = await previewClientImport({ rows, fileName: step.parsed.fileName })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      setStep({ kind: "report", parsed: step.parsed, rows, report: r.data.report, valid: r.data.valid })
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    if (step.kind !== "report") return
    setBusy("import")
    setError(null)
    try {
      const r = await importClients({ rows: step.rows, fileName: step.parsed.fileName })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      setStep({ kind: "done", outcome: r.data })
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setBusy(null)
    }
  }

  const close = () => {
    setOpen(false)
    reset()
  }

  const footer =
    step.kind === "choose" ? (
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="button" onClick={() => inputRef.current?.click()} disabled={busy !== null}>
          {busy === "parse" ? <Spinner /> : <UploadIcon aria-hidden="true" />}
          Choose CSV file
        </Button>
      </div>
    ) : step.kind === "map" ? (
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={reset} disabled={busy !== null}>
          Choose another file
        </Button>
        <Button type="button" onClick={() => void check()} disabled={busy !== null}>
          {busy === "check" ? <Spinner /> : null}
          Check {step.parsed.data.length.toLocaleString("en-IN")} rows
        </Button>
      </div>
    ) : step.kind === "report" ? (
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={reset} disabled={busy !== null}>
          Choose another file
        </Button>
        <Button type="button" onClick={() => void doImport()} disabled={busy !== null || step.valid === 0}>
          {busy === "import" ? <Spinner /> : null}
          {step.valid === 0 ? "Nothing to import" : `Import ${step.valid.toLocaleString("en-IN")} valid ${step.valid === 1 ? "row" : "rows"}`}
        </Button>
      </div>
    ) : (
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" onClick={close}>
          Done
        </Button>
      </div>
    )

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <FileUpIcon aria-hidden="true" />
        <span className="max-sm:sr-only">Import CSV</span>
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return
          if (!o) close()
          else setOpen(true)
        }}
        size="xl"
        title="Import clients"
        description="Add many clients from a CSV file. Every row is checked first; only valid rows are imported."
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
            const f = e.target.files?.[0]
            if (f) read(f)
          }}
        />

        {step.kind === "choose" ? (
          <div className="flex flex-col gap-4 text-base">
            <p className="text-text">
              Start from the template so the columns match. Only <span className="font-medium">display_name</span> is required; leave{" "}
              <span className="font-mono text-sm">client_code</span> blank to take the next TW-C number.
            </p>
            <div>
              <Button asChild variant="outline" size="sm">
                <a href={TEMPLATE_HREF} download="taxwise-clients-template.csv">
                  <DownloadIcon aria-hidden="true" />
                  Download the template
                </a>
              </Button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Template columns</caption>
                <thead>
                  <tr className="bg-surface-2 text-left text-xs text-text-muted">
                    <th scope="col" className="px-3 py-2 font-medium">Column</th>
                    <th scope="col" className="px-3 py-2 font-medium">What goes in it</th>
                  </tr>
                </thead>
                <tbody>
                  {IMPORT_COLUMNS.map((c) => (
                    <tr key={c.key} className="border-t border-border/70">
                      <td className="px-3 py-1.5 font-mono whitespace-nowrap text-text">
                        {c.header}
                        {c.required ? <span className="ml-0.5 text-danger-text">*</span> : null}
                      </td>
                      <td className="px-3 py-1.5 text-text-muted">{c.hint || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {step.kind === "map" ? (
          <div className="flex flex-col gap-3">
            <p className="text-base text-text">
              <span className="font-medium">{step.parsed.fileName}</span> has {step.parsed.data.length.toLocaleString("en-IN")} rows. Check which column each heading goes to.
            </p>
            <ul className="flex flex-col divide-y divide-border/70 rounded-lg border border-border">
              {step.parsed.headers.map((h) => {
                const id = `map-${h}`
                const sample = step.parsed.data.find((r) => r[h]?.trim())?.[h] ?? ""
                return (
                  <li key={h} className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
                    <label htmlFor={id} className="min-w-0">
                      <span className="block truncate text-base font-medium text-text">{h}</span>
                      {sample ? <span className="block truncate text-sm text-text-muted">e.g. {sample}</span> : null}
                    </label>
                    <select
                      id={id}
                      value={step.mapping[h] ?? SKIP}
                      onChange={(e) => {
                        const v = e.target.value === SKIP ? null : (e.target.value as ImportKey)
                        const next = { ...step.mapping }
                        if (v) for (const k of Object.keys(next)) if (next[k] === v) next[k] = null
                        next[h] = v
                        setStep({ ...step, mapping: next })
                      }}
                      className="h-9 w-full cursor-pointer rounded-md border border-text-muted/30 bg-surface px-3 text-base text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 pointer-coarse:h-11"
                    >
                      <option value={SKIP}>Don&apos;t import</option>
                      {IMPORT_COLUMNS.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.header}
                          {c.required ? " *" : ""}
                        </option>
                      ))}
                    </select>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}

        {step.kind === "report" ? (
          <ImportReport report={step.report} showOk={showOk} onToggleOk={() => setShowOk((v) => !v)} />
        ) : null}

        {step.kind === "done" ? <ImportDone outcome={step.outcome} /> : null}
      </FormDialog>
    </>
  )
}

function ImportReport({ report, showOk, onToggleOk }: { report: ImportReportRow[]; showOk: boolean; onToggleOk: () => void }) {
  const valid = report.filter((r) => r.ok).length
  const invalid = report.length - valid
  const warned = report.filter((r) => r.ok && r.warnings.length).length
  const shown = report.filter((r) => showOk || !r.ok || r.warnings.length)
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
        <p className="text-sm text-text-muted">{invalid ? "Rows with problems are left out. Fix them in the file and import it again later." : "Every row can be imported."}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onToggleOk}>
          {showOk ? "Show only rows to look at" : "Show every row"}
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">Nothing to look at: every row is ready.</p>
      ) : (
        <ul className="flex max-h-[min(22rem,45dvh)] flex-col divide-y divide-border/70 overflow-y-auto rounded-lg border border-border">
          {shown.map((r) => (
            <li key={r.row} className="flex gap-3 px-3 py-2">
              <span className="num w-14 flex-none text-sm text-text-muted tabular-nums">Row {r.row}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {r.ok ? (
                    r.warnings.length ? (
                      <TriangleAlertIcon aria-hidden="true" className="size-4 flex-none text-warning-text" />
                    ) : (
                      <CircleCheckIcon aria-hidden="true" className="size-4 flex-none text-success-text" />
                    )
                  ) : (
                    <CircleAlertIcon aria-hidden="true" className="size-4 flex-none text-danger-text" />
                  )}
                  <span className="truncate text-base font-medium text-text">{r.name}</span>
                  <span className="sr-only">{r.ok ? (r.warnings.length ? "imported, with warnings" : "ready") : "left out"}</span>
                </div>
                {r.errors.map((e) => (
                  <p key={e} className="text-sm text-danger-text">
                    {e}
                  </p>
                ))}
                {r.warnings.map((w) => (
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

function ImportDone({ outcome }: { outcome: ImportOutcome }) {
  const failed = outcome.results.filter((r) => !r.ok)
  return (
    <div className="flex flex-col gap-3 text-base">
      <p className="flex items-center gap-2 text-text">
        <CircleCheckIcon aria-hidden="true" className="size-5 text-success-text" />
        {outcome.imported.toLocaleString("en-IN")} {outcome.imported === 1 ? "client" : "clients"} imported
        {outcome.skipped || outcome.failed ? `; ${(outcome.skipped + outcome.failed).toLocaleString("en-IN")} left out` : ""}.
      </p>
      <p className="text-sm text-text-muted">
        Imported clients have no deadlines yet. Open each one and use Generate deadlines on its Compliance tab, or add services and team on its Profile.
      </p>
      {failed.length ? (
        <ul className="flex max-h-60 flex-col divide-y divide-border/70 overflow-y-auto rounded-lg border border-border">
          {failed.map((r) => (
            <li key={r.row} className="flex gap-3 px-3 py-2 text-sm">
              <span className="num w-14 flex-none text-text-muted tabular-nums">Row {r.row}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-text">{r.name}</span>
                <span className="block text-danger-text">{r.error}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <Link href="/clients?sort=onboarded_at&dir=desc" className="text-primary hover:underline">
          See the newest clients
        </Link>
      </p>
    </div>
  )
}

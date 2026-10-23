"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FileUpIcon, UploadIcon } from "lucide-react"
import { formatDate } from "@/lib/format"
import { formatINR } from "@/lib/domain/money"
import { TDS_SOURCES, TDS_SOURCE_LABEL, type TdsSource } from "@/lib/schemas/collections"
import { importTdsStatement, previewTdsImport, type TdsPreview } from "@/server/actions/tds-credits"
import type { FormError } from "@/hooks/use-action-form"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TdsMatchChip } from "@/components/collections/ui"

/**
 * Import Form 26AS / AIS (§7.9.9). Choose the statement (the 26AS text file from TRACES, or the
 * AIS / Form 168 TDS table saved as CSV) and the financial year; the app reads it, matches each TDS
 * line to our receipts by the deductor's TAN and amount, and shows the result before anything is
 * saved: matched (the credits become Reflected), amount differs, and not in our books. Importing the
 * same statement again skips the lines already imported.
 */

const MAX_BYTES = 900 * 1024
const FORMAT_LABEL: Record<TdsPreview["format"], string> = { "26as_text": "Form 26AS text file", table: "TDS table", unknown: "The file" }

export function TdsImportButton({ fy, fyOptions }: { fy: string; fyOptions: string[] }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UploadIcon aria-hidden="true" />
        Import 26AS / AIS
      </Button>
      {open ? <TdsImportDialog fy={fy} fyOptions={fyOptions} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function TdsImportDialog({ fy, fyOptions, onClose }: { fy: string; fyOptions: string[]; onClose: () => void }) {
  const router = useRouter()
  const [source, setSource] = React.useState<TdsSource>("26as")
  const [financialYear, setFinancialYear] = React.useState(fy)
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null)
  const [preview, setPreview] = React.useState<TdsPreview | null>(null)
  const [error, setError] = React.useState<FormError | null>(null)
  const [pending, setPending] = React.useState(false)
  const ids = { source: React.useId(), fy: React.useId(), file: React.useId() }

  const reset = () => {
    setPreview(null)
    setError(null)
  }

  const choose = async (f: File | undefined) => {
    reset()
    if (!f) {
      setFile(null)
      return
    }
    if (f.size > MAX_BYTES) {
      setFile(null)
      setError({ message: "The file is larger than 900 KB. Download one financial year at a time and import that." })
      return
    }
    try {
      setFile({ name: f.name, text: await f.text() })
    } catch {
      setFile(null)
      setError({ message: "We couldn't read that file. Download it again and choose it once more." })
    }
  }

  const input = file ? { fileName: file.name, text: file.text, source, financialYear } : null

  const check = async () => {
    if (!input || pending) return
    setPending(true)
    setError(null)
    try {
      const r = await previewTdsImport(input)
      if (!r.ok) {
        setError({ message: r.fieldErrors?.text?.[0] ?? r.fieldErrors?.financialYear?.[0] ?? r.error, ref: r.ref })
        return
      }
      setPreview(r.data)
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const save = async () => {
    if (!input || pending) return
    setPending(true)
    setError(null)
    try {
      const r = await importTdsStatement(input)
      if (!r.ok) {
        setError({ message: r.fieldErrors?.financialYear?.[0] ? r.error : (r.fieldErrors?.text?.[0] ?? r.error), ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      const d = r.data
      const parts = [
        `${d.reflected} ${d.reflected === 1 ? "credit" : "credits"} now reflected`,
        d.mismatches ? `${d.mismatches} with a different amount` : null,
        d.unmatched ? `${d.unmatched} not in our books` : null,
        d.duplicates ? `${d.duplicates} already imported and skipped` : null,
      ].filter(Boolean)
      toast.success(`${TDS_SOURCE_LABEL[source]} imported: ${parts.join(", ")}.`, { duration: 10_000 })
      onClose()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const fyMismatch = preview?.detectedFy && preview.detectedFy !== financialYear ? preview.detectedFy : null

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o && !pending ? onClose() : undefined)}
      size="lg"
      title="Import Form 26AS / AIS"
      description="Each TDS line is matched to our receipts by the deductor's TAN and amount. Nothing is saved until you import."
      pending={pending}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {preview ? (
            <Button type="button" onClick={save} disabled={pending || preview.counts.lines === 0 || Boolean(fyMismatch)}>
              {pending ? "Importing…" : `Import ${preview.counts.lines} ${preview.counts.lines === 1 ? "line" : "lines"}`}
            </Button>
          ) : (
            <Button type="button" onClick={check} disabled={pending || !file}>
              {pending ? "Reading…" : "Check the file"}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <FormAlert error={error} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.source} className="text-sm font-medium text-text">
              Statement
            </label>
            <Select
              value={source}
              onValueChange={(v) => {
                setSource(v as TdsSource)
                reset()
              }}
              disabled={pending}
            >
              <SelectTrigger id={ids.source} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TDS_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {TDS_SOURCE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.fy} className="text-sm font-medium text-text">
              Financial year
            </label>
            <Select
              value={financialYear}
              onValueChange={(v) => {
                setFinancialYear(v)
                reset()
              }}
              disabled={pending}
            >
              <SelectTrigger id={ids.fy} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fyOptions.map((f) => (
                  <SelectItem key={f} value={f}>
                    FY {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.file} className="text-sm font-medium text-text">
            File <span className="text-danger-text">*</span>
          </label>
          <label
            htmlFor={ids.file}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border px-3 py-3 text-sm text-text-muted hover:border-text-muted focus-within:outline-2 focus-within:outline-ring"
          >
            <FileUpIcon aria-hidden="true" className="size-5 flex-none" />
            <span className="min-w-0 flex-1 truncate">{file ? <span className="text-text">{file.name}</span> : "Choose the 26AS text file (.txt) or the AIS TDS table (.csv)"}</span>
            <input id={ids.file} type="file" accept=".txt,.csv,text/plain,text/csv" className="sr-only" disabled={pending} onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          <p className="text-sm text-text-muted">
            From TRACES, download Form 26AS as a text file. From the AIS, open the TDS / TCS section and download it as CSV. Up to 900 KB, one financial year.
          </p>
        </div>

        {preview ? <PreviewResult preview={preview} fyMismatch={fyMismatch} financialYear={financialYear} /> : null}
      </div>
    </FormDialog>
  )
}

function PreviewResult({ preview, fyMismatch, financialYear }: { preview: TdsPreview; fyMismatch: string | null; financialYear: string }) {
  const c = preview.counts
  if (c.lines === 0) {
    return (
      <div role="note" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-text">
        <p className="font-medium">No TDS lines were found in this file.</p>
        <p className="mt-0.5 text-text-muted">
          Check it is the 26AS text file, or the AIS TDS table saved as CSV with the TAN, the date and the TDS amount as columns.
          {preview.problems.length ? ` ${preview.problems.length} ${preview.problems.length === 1 ? "line" : "lines"} couldn't be read.` : ""}
        </p>
      </div>
    )
  }
  return (
    <section aria-label="What the file holds" className="flex flex-col gap-3">
      {fyMismatch ? (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-text">
          This file is for FY {fyMismatch}, not FY {financialYear}. Choose FY {fyMismatch} above and check it again.
        </div>
      ) : null}
      <p className="text-base text-text">
        {FORMAT_LABEL[preview.format]}
        {preview.detectedFy ? ` for FY ${preview.detectedFy}` : ""}: <span className="num font-medium">{c.lines}</span> TDS {c.lines === 1 ? "line" : "lines"}.
      </p>
      <dl className="grid grid-cols-3 divide-x divide-border rounded-md border border-border text-sm">
        <div className="px-3 py-2">
          <dt className="text-text-muted">Matched</dt>
          <dd className="num text-lg font-medium text-text">{c.matched}</dd>
        </div>
        <div className="px-3 py-2">
          <dt className="text-text-muted">Amount differs</dt>
          <dd className="num text-lg font-medium text-text">{c.mismatches}</dd>
        </div>
        <div className="px-3 py-2">
          <dt className="text-text-muted">Not in our books</dt>
          <dd className="num text-lg font-medium text-text">{c.unmatched}</dd>
        </div>
      </dl>
      <div className="max-h-72 overflow-auto rounded-md border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">TDS lines in the file and how each matched</caption>
          <thead className="sticky top-0 bg-surface text-left text-text-muted">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-medium">
                Deductor
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Date
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                TDS
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Match
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {preview.lines.map((l) => (
              <tr key={l.lineNo} className="align-top">
                <td className="px-3 py-2">
                  <span className="block text-text">{l.clientName ?? l.deductorName ?? "Deductor not named"}</span>
                  <span className="block font-mono text-xs text-text-muted">
                    {l.tan}
                    {l.section ? ` · ${l.section}` : ""}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text">{l.transactionDate ? formatDate(l.transactionDate) : "—"}</td>
                <td className="num whitespace-nowrap px-3 py-2 text-right text-text tabular-nums">{formatINR(l.tdsPaise)}</td>
                <td className="px-3 py-2">
                  <TdsMatchChip status={l.status} />
                  {l.status !== "matched" && l.note ? <span className="mt-0.5 block text-xs text-text-muted">{l.note}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.lines > preview.lines.length ? <p className="text-sm text-text-muted">Showing the first {preview.lines.length} of {c.lines} lines; all are imported.</p> : null}
      {preview.problems.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-text-muted">
            {c.problems} {c.problems === 1 ? "line" : "lines"} couldn&apos;t be read and {c.problems === 1 ? "is" : "are"} left out
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-text-muted">
            {preview.problems.map((p) => (
              <li key={`${p.lineNo}-${p.message}`}>
                Line {p.lineNo}: {p.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}

"use client"

import * as React from "react"
import { AlertTriangleIcon, CheckIcon, FileJson2Icon, RotateCcwIcon, UploadIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { formatCount } from "@/components/app/data-table/params"
import { formatDate } from "@/lib/format"
import { formatFileSize } from "@/lib/domain/files"
import { GSTR2B_SECTION_LABELS, GSTR2B_SECTIONS, parseGstr2b } from "@/lib/domain/gstr2b"
import { checkPortalGstin } from "@/lib/domain/recon"
import { MAX_SOURCE_BYTES, periodLabel, type Gstr2bSource } from "@/lib/schemas/gst-recon"
import { prepareGstr2bUpload } from "@/server/actions/gst-recon"
import { hashFile, putFile } from "@/components/documents/upload-transport"

/** What the browser read from the file, for the preview and the checks before the run. */
export type Gstr2bPreview = {
  gstin: string | null
  period: string | null
  generatedOn: string | null
  documents: number
  counts: Record<string, number>
  problems: string[]
  warnings: number
}

export type UploadedGstr2b = { source: Gstr2bSource; preview: Gstr2bPreview }

type State =
  | { kind: "idle" }
  | { kind: "reading"; fileName: string }
  | { kind: "uploading"; fileName: string; progress: number }
  | { kind: "failed"; message: string }

/**
 * The GSTR-2B JSON step (§7.8.1 step 2, §6.12): the file is read in the browser first, so the
 * person sees at once which GSTIN and month it is for and how many documents it holds; then it is
 * stored privately in the client's folder (a signed upload URL issued after the client check). The
 * server reads the stored file again and parses it itself when the reconciliation runs.
 */
export function Gstr2bUpload({
  clientId,
  clientGstin,
  period,
  uploaded,
  onUploaded,
  onReplace,
  onUsePeriod,
  error,
}: {
  clientId: string
  clientGstin: string | null
  period: string
  uploaded: UploadedGstr2b | null
  onUploaded: (u: UploadedGstr2b) => void
  onReplace: () => void
  /** Switch the reconciliation to the file's month. */
  onUsePeriod: (period: string) => void
  error?: string | null
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const hintId = React.useId()
  const [over, setOver] = React.useState(false)
  const [state, setState] = React.useState<State>({ kind: "idle" })

  const choose = async (files: FileList | File[]) => {
    const file = Array.from(files)[0]
    if (!file) return
    if (!/\.json$/i.test(file.name)) {
      setState({ kind: "failed", message: "Choose the GSTR-2B JSON file downloaded from the GST portal (it ends in .json)." })
      return
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setState({ kind: "failed", message: "Files can be at most 25 MB." })
      return
    }
    setState({ kind: "reading", fileName: file.name })
    try {
      const text = await file.text()
      const parsed = parseGstr2b(text)
      if (!parsed.ok) {
        setState({ kind: "failed", message: parsed.diagnostics.find((d) => d.level === "error")?.message ?? "This file doesn't look like a GSTR-2B download." })
        return
      }
      const sha256 = await hashFile(file)
      const prepared = await prepareGstr2bUpload({ clientId, fileName: file.name, size: file.size, sha256 })
      if (!prepared.ok) {
        setState({ kind: "failed", message: prepared.error })
        return
      }
      setState({ kind: "uploading", fileName: file.name, progress: 0 })
      await putFile(prepared.data.signedUrl, file, "application/json", (f) => setState({ kind: "uploading", fileName: file.name, progress: Math.round(f * 100) }))
      const problems = parsed.diagnostics.filter((d) => d.level === "error" || d.level === "warning").map((d) => d.message)
      onUploaded({
        source: { path: prepared.data.path, fileName: file.name, size: file.size, sha256 },
        preview: {
          gstin: parsed.gstin,
          period: parsed.period,
          generatedOn: parsed.generatedOn,
          documents: parsed.rows.length,
          counts: parsed.counts,
          problems: problems.slice(0, 5),
          warnings: problems.length,
        },
      })
      setState({ kind: "idle" })
    } catch (err) {
      setState({ kind: "failed", message: err instanceof Error && err.message ? err.message : "The file couldn't be read. Choose it again." })
    }
  }

  if (uploaded) {
    const p = uploaded.preview
    const gstinWarning = checkPortalGstin(p.gstin, clientGstin)
    const wrongMonth = p.period !== null && p.period !== period
    const sections = GSTR2B_SECTIONS.filter((s) => (p.counts[s] ?? 0) > 0)
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <FileJson2Icon aria-hidden="true" className="mt-0.5 size-5 flex-none text-text-muted" />
            <div className="min-w-0">
              <p className="truncate text-base text-text" title={uploaded.source.fileName}>
                {uploaded.source.fileName}
              </p>
              <p className="inline-flex items-center gap-1 text-sm text-success-text">
                <CheckIcon aria-hidden="true" className="size-3.5" /> Uploaded · {formatFileSize(uploaded.source.size)}
              </p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-text-muted">For GSTIN</dt>
                <dd className="num text-text">{p.gstin ?? "Not stated in the file"}</dd>
                <dt className="text-text-muted">Return period</dt>
                <dd className="text-text">{p.period ? periodLabel(p.period) : "Not stated in the file"}</dd>
                {p.generatedOn ? (
                  <>
                    <dt className="text-text-muted">Generated on</dt>
                    <dd className="num text-text">{formatDate(p.generatedOn)}</dd>
                  </>
                ) : null}
                <dt className="text-text-muted">Documents</dt>
                <dd className="num text-text">
                  {formatCount(p.documents)}
                  {sections.length ? <span className="text-text-muted"> · {sections.map((s) => `${GSTR2B_SECTION_LABELS[s]} ${formatCount(p.counts[s])}`).join(", ")}</span> : null}
                </dd>
              </dl>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onReplace}>
            <RotateCcwIcon aria-hidden="true" />
            Use another file
          </Button>
        </div>
        {wrongMonth ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-base text-text">
            <span className="flex items-start gap-2">
              <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
              This GSTR-2B is for {periodLabel(p.period)}, but the reconciliation is for {periodLabel(period)}.
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => p.period && onUsePeriod(p.period)}>
              Reconcile {periodLabel(p.period)} instead
            </Button>
          </div>
        ) : null}
        {gstinWarning ? (
          <div role="status" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-base text-text">
            <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
            <span>{gstinWarning.message}</span>
          </div>
        ) : null}
        {p.warnings > 0 ? (
          <details className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
            <summary className="cursor-pointer text-text">
              {formatCount(p.warnings)} {p.warnings === 1 ? "thing" : "things"} in the file to know about
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-text-muted">
              {p.problems.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
              {p.warnings > p.problems.length ? <li>The full list is on the reconciliation once it runs.</li> : null}
            </ul>
          </details>
        ) : null}
      </div>
    )
  }

  const busy = state.kind === "reading" || state.kind === "uploading"
  const message = state.kind === "failed" ? state.message : (error ?? null)
  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          if (busy) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          if (!busy && e.dataTransfer.files?.length) void choose(e.dataTransfer.files)
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-2/50 px-4 py-6 text-center transition-colors duration-150",
          over && "border-primary bg-primary-soft",
          message && "border-danger/50",
        )}
      >
        <FileJson2Icon aria-hidden="true" className="size-5 text-text-muted" />
        <p className="text-base text-text">Drop the GSTR-2B JSON for {periodLabel(period)} here, or choose it.</p>
        <p id={hintId} className="text-sm text-text-muted">
          From the GST portal: Returns → GSTR-2B → Download JSON. Up to 25 MB.
        </p>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            if (e.target.files?.length) void choose(e.target.files)
            e.target.value = ""
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} aria-describedby={hintId} onClick={() => inputRef.current?.click()}>
          {busy ? <Spinner /> : <UploadIcon aria-hidden="true" />}
          {state.kind === "reading" ? "Reading the file" : state.kind === "uploading" ? "Uploading" : "Choose file"}
        </Button>
      </div>
      {state.kind === "uploading" ? (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <div className="flex justify-between text-sm text-text-muted">
            <span className="truncate">{state.fileName}</span>
            <span className="num tabular-nums">{state.progress}%</span>
          </div>
          <Progress value={state.progress} aria-label={`Uploading ${state.fileName}`} />
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm text-danger-text">
          {message}
        </p>
      ) : null}
    </div>
  )
}

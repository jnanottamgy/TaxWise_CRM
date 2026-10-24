"use client"

import * as React from "react"
import { CheckIcon, FileSpreadsheetIcon, RotateCcwIcon, UploadIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { formatFileSize } from "@/lib/domain/files"
import type { DocumentCategory } from "@/lib/domain/enums"
import { useDocumentUpload } from "@/components/documents/uploader"

/** A spreadsheet in the client's vault, ready to read. */
export type UploadedSheet = { documentId: string; fileName: string; size: number }

const SHEET_EXTENSIONS = /\.(csv|xlsx)$/i
const ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/**
 * Upload one CSV or Excel (.xlsx) file into the client's document vault (§7.14) for a workpaper:
 * the purchase register (§7.8.1, category GST) or the trial balance (§7.8.3). The file is checked
 * by its bytes, hashed, uploaded through a signed URL and confirmed by the server (the documents
 * module's flow); it then sits in the client's Documents tab with the given title, FY and period.
 * Drag and drop, with a "Choose file" button beside it (keyboard and touch).
 */
export function SheetUpload({
  clientId,
  title,
  category,
  financialYear,
  period,
  tags,
  uploaded,
  onUploaded,
  onReplace,
  label,
  error,
}: {
  clientId: string
  /** The document's title in the vault: "Purchase register · Sep 2026". */
  title: string
  category: DocumentCategory
  financialYear: string | null
  period: string | null
  tags: string[]
  /** The file already uploaded in this flow (shown with Replace). */
  uploaded: UploadedSheet | null
  onUploaded: (file: UploadedSheet) => void
  onReplace: () => void
  label: string
  error?: string | null
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const hintId = React.useId()
  const [over, setOver] = React.useState(false)
  const [typeError, setTypeError] = React.useState<string | null>(null)
  const up = useDocumentUpload({
    clientId,
    purpose: "new_document",
    single: true,
    source: "staff",
    defaults: { title, category, financialYear: financialYear ?? "", period: period ?? "", tags },
    onUploaded: (done) => {
      const d = done[0]
      if (d) onUploaded({ documentId: d.documentId, fileName: d.fileName, size: d.fileSize })
    },
  })

  const row = up.rows[0] ?? null
  const ready = row?.status === "ready"
  const { start, busy } = up
  // Start as soon as the file passes the checks: there is nothing else to fill in.
  React.useEffect(() => {
    if (ready && !busy) void start()
  }, [ready, busy, start])

  const choose = (files: FileList | File[]) => {
    const list = Array.from(files)
    const file = list[0]
    if (!file) return
    if (!SHEET_EXTENSIONS.test(file.name)) {
      setTypeError("Choose a CSV or Excel (.xlsx) file. An old .xls file: open it in Excel and save it as .xlsx first.")
      return
    }
    setTypeError(null)
    up.reset()
    up.addFiles([file])
  }

  if (uploaded) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <FileSpreadsheetIcon aria-hidden="true" className="size-5 flex-none text-text-muted" />
          <div className="min-w-0">
            <p className="truncate text-base text-text" title={uploaded.fileName}>
              {uploaded.fileName}
            </p>
            <p className="inline-flex items-center gap-1 text-sm text-success-text">
              <CheckIcon aria-hidden="true" className="size-3.5" /> In the client&apos;s documents · {formatFileSize(uploaded.size)}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            up.reset()
            onReplace()
          }}
        >
          <RotateCcwIcon aria-hidden="true" />
          Use another file
        </Button>
      </div>
    )
  }

  const problem = typeError ?? (row?.status === "rejected" || row?.status === "failed" ? row.reason : null) ?? error ?? null
  return (
    <div className="flex flex-col gap-3">
      <FormAlert error={up.formError} className="mb-0" />
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
          if (!busy && e.dataTransfer.files?.length) choose(e.dataTransfer.files)
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-2/50 px-4 py-6 text-center transition-colors duration-150",
          over && "border-primary bg-primary-soft",
          problem && "border-danger/50",
        )}
      >
        <FileSpreadsheetIcon aria-hidden="true" className="size-5 text-text-muted" />
        <p className="text-base text-text">{label}</p>
        <p id={hintId} className="text-sm text-text-muted">
          CSV or Excel (.xlsx), up to 25 MB. It is saved in the client&apos;s documents.
        </p>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => {
            if (e.target.files?.length) choose(e.target.files)
            e.target.value = ""
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} aria-describedby={hintId} onClick={() => inputRef.current?.click()}>
          <UploadIcon aria-hidden="true" />
          Choose file
        </Button>
      </div>
      {row && row.status !== "rejected" ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface px-3 py-2" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-text" title={row.fileName}>
              {row.fileName}
            </span>
            <span className="inline-flex flex-none items-center gap-1.5 text-text-muted">
              {row.status === "failed" ? (
                <span className="font-medium text-danger-text">Failed</span>
              ) : row.status === "done" ? (
                <span className="inline-flex items-center gap-1 font-medium text-success-text">
                  <CheckIcon aria-hidden="true" className="size-3.5" /> Saved
                </span>
              ) : (
                <>
                  <Spinner className="size-3.5" />
                  {row.status === "uploading" ? <span className="num tabular-nums">{row.progress}%</span> : row.status === "saving" ? "Checking the file" : "Checking"}
                </>
              )}
            </span>
          </div>
          {row.status === "uploading" ? <Progress value={row.progress} aria-label={`Uploading ${row.fileName}`} /> : null}
          {row.duplicates.length > 0 && row.status !== "failed" ? (
            <p className="text-sm text-text-muted">The client&apos;s documents already hold this file ({row.duplicates[0].title}); it is saved again for this workpaper.</p>
          ) : null}
          {row.status === "failed" ? (
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => void start()}>
                <RotateCcwIcon aria-hidden="true" />
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-danger-text">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

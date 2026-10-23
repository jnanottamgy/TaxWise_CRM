"use client"

/**
 * Uploading into a client's document vault (§7.14), reusable wherever a file goes into the vault:
 * the Documents tab, the client portal's request items (§7.22), task attachments, files saved from
 * WhatsApp (§7.25.6). Built on the two server actions in server/actions/documents.ts
 * (requestUploadSlots → PUT to the signed URL → confirmUpload).
 *
 *   // Full control (the vault dialog does this):
 *   const up = useDocumentUpload({ clientId, purpose: "new_document", defaults: { category: "gst", financialYear: "2026-27" } })
 *   <UploadDropzone onFiles={up.addFiles} multiple disabled={up.busy} />
 *   <UploadFileList upload={up} fields="full" allowConfidential />
 *   <Button onClick={() => up.start()} disabled={!up.canStart}>Upload</Button>
 *
 *   // Inline, one file, its own button (a portal request item, a task attachment):
 *   <DocumentUploader clientId={clientId} purpose="request_item" requestItemId={item.id}
 *     defaults={{ title: item.title, category: "other" }} fields="none" onUploaded={(done) => router.refresh()} />
 *
 * What it does for each file: reads the first bytes and checks the type by magic bytes, the 25 MB
 * limit and the name (lib/domain/files.ts checkFile), refusing with the reason; hashes it (SHA-256)
 * and warns when the client's vault already holds it; then reserves a slot, uploads with progress,
 * and confirms (the server checks the whole file again). Failed files can be retried; nothing that
 * failed the server's check is kept. Drag and drop always has a "Choose files" button beside it
 * (WCAG 2.2 single-pointer alternative), and on phones the picker offers the camera.
 */

import * as React from "react"
import { toast } from "sonner"
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, FileUpIcon, RotateCcwIcon, UploadIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { TagInput } from "@/components/app/form/tag-input"
import { DatePicker } from "@/components/app/form/date-picker"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import type { FormError } from "@/hooks/use-action-form"
import { formatDate } from "@/lib/format"
import type { DocumentCategory } from "@/lib/domain/enums"
import {
  ACCEPT_ATTRIBUTE,
  ALLOWED_TYPES_SENTENCE,
  MAX_FILES_PER_UPLOAD,
  SNIFF_BYTES,
  checkFile,
  findDuplicates as findBatchDuplicates,
  formatFileSize,
  titleFromFileName,
  type FileKind,
} from "@/lib/domain/files"
import { CATEGORY_OPTIONS, fyChoices, type DuplicateMatch, type FinishedUpload, type StaffUploadSource, type UploadPurpose } from "@/lib/schemas/documents"
import { confirmUpload, discardUpload, findDuplicates, requestUploadSlots } from "@/server/actions/documents"
import { FileTypeMark } from "@/components/documents/file-type-mark"
import { hashFile, putFile, readHead, UploadTransportError } from "@/components/documents/upload-transport"

// -------------------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------------------

export type UploadRowStatus = "checking" | "ready" | "rejected" | "uploading" | "saving" | "done" | "failed"

export interface UploadMeta {
  title: string
  category: DocumentCategory
  /** "" when not set. */
  financialYear: string
  period: string
  description: string
  tags: string[]
  isConfidential: boolean
  expiryDate: string
  renewalDate: string
  changeNote: string
}

export interface UploadRow {
  key: string
  file: File
  status: UploadRowStatus
  /** Why it was refused or failed, in a sentence. */
  reason: string | null
  /** A note about the file ("Saved as .heic: …"). */
  note: string | null
  kind: FileKind | null
  mimeType: string | null
  /** The cleaned name it will be stored under. */
  fileName: string
  sha256: string | null
  /** Documents of this client with the same SHA-256 (the duplicate warning). */
  duplicates: DuplicateMatch[]
  /** An earlier file of this same upload with the same contents. */
  sameAsKey: string | null
  progress: number
  meta: UploadMeta
  /** A field error from the server for this file ("files.2.title"). */
  fieldErrors: Partial<Record<keyof UploadMeta, string>>
  result: FinishedUpload | null
}

export interface UploadOptions {
  clientId: string
  purpose?: UploadPurpose
  /** new_version: the document that gets the new version. */
  documentId?: string | null
  /** request_item: the item the file answers. */
  requestItemId?: string | null
  /** Staff uploading against a request item for the client: accept it at once. */
  acceptItem?: boolean
  /** Staff: where the file came from (staff, email, whatsapp). Portal uploads are always the portal's. */
  source?: StaffUploadSource
  defaults?: Partial<Pick<UploadMeta, "title" | "category" | "financialYear" | "period" | "tags" | "isConfidential">>
  /** One file only (versions and request items); a new choice replaces the old one. */
  single?: boolean
  /** Called once a run finishes, with the files that were saved. */
  onUploaded?: (done: FinishedUpload[]) => void | Promise<void>
}

export interface DocumentUpload {
  rows: UploadRow[]
  addFiles: (files: FileList | File[]) => void
  remove: (key: string) => void
  update: (key: string, patch: Partial<UploadMeta>) => void
  applyToAll: (patch: Partial<Pick<UploadMeta, "category" | "financialYear">>) => void
  /** Uploads every ready (and failed) file. Resolves with the files saved in this run. */
  start: () => Promise<FinishedUpload[]>
  cancel: () => void
  reset: () => void
  busy: boolean
  canStart: boolean
  /** A refusal for the whole upload (permission, rate limit), with its Ref. */
  formError: FormError | null
  counts: { total: number; ready: number; rejected: number; done: number; failed: number; active: number }
}

let keySeq = 0
const nextKey = () => `u${Date.now().toString(36)}${(keySeq++).toString(36)}`

const UPLOAD_CONCURRENCY = 3

function emptyMeta(defaults: UploadOptions["defaults"]): UploadMeta {
  return {
    title: defaults?.title ?? "",
    category: defaults?.category ?? "other",
    financialYear: defaults?.financialYear ?? "",
    period: defaults?.period ?? "",
    description: "",
    tags: defaults?.tags ?? [],
    isConfidential: defaults?.isConfidential ?? false,
    expiryDate: "",
    renewalDate: "",
    changeNote: "",
  }
}

/** The headless upload state machine behind every uploader (see the file header). */
export function useDocumentUpload(opts: UploadOptions): DocumentUpload {
  const [rows, setRows] = React.useState<UploadRow[]>([])
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState<FormError | null>(null)
  const rowsRef = React.useRef<UploadRow[]>([])
  const aborts = React.useRef(new Map<string, AbortController>())
  const optsRef = React.useRef(opts)
  React.useEffect(() => {
    optsRef.current = opts
  })

  const commit = React.useCallback((next: UploadRow[] | ((prev: UploadRow[]) => UploadRow[])) => {
    setRows((prev) => {
      const value = typeof next === "function" ? next(prev) : next
      rowsRef.current = value
      return value
    })
  }, [])
  const patchRow = React.useCallback(
    (key: string, patch: Partial<UploadRow> | ((r: UploadRow) => Partial<UploadRow>)) =>
      commit((prev) => prev.map((r) => (r.key === key ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r))),
    [commit]
  )

  const lookUpDuplicates = React.useCallback(
    async (hashed: Array<{ key: string; sha256: string }>) => {
      if (hashed.length === 0) return
      let inVault: DuplicateMatch[] = []
      try {
        const res = await findDuplicates({ clientId: optsRef.current.clientId, hashes: hashed.map((h) => h.sha256).slice(0, MAX_FILES_PER_UPLOAD) })
        if (res.ok) inVault = res.data
      } catch {
        inVault = []
      }
      // The updater sees every row as it is now (the hashes just set included), in their order.
      commit((prev) => {
        const known = new Map<string, DuplicateMatch>()
        for (const d of [...prev.flatMap((r) => r.duplicates), ...inVault]) known.set(`${d.documentId}:${d.version}`, d)
        const map = findBatchDuplicates(
          prev.filter((r) => r.sha256 && r.status !== "rejected").map((r) => ({ key: r.key, sha256: r.sha256 })),
          [...known.values()]
        )
        return prev.map((r) => {
          const d = map.get(r.key)
          return d ? { ...r, duplicates: d.inVault, sameAsKey: d.sameAsKey } : { ...r, duplicates: [], sameAsKey: null }
        })
      })
    },
    [commit]
  )

  const addFiles = React.useCallback(
    (list: FileList | File[]) => {
      const o = optsRef.current
      const files = Array.from(list)
      if (files.length === 0) return
      setFormError(null)
      const chosen = o.single ? files.slice(0, 1) : files
      const existing = o.single ? [] : rowsRef.current.filter((r) => r.status !== "done")
      const room = Math.max(0, MAX_FILES_PER_UPLOAD - existing.length)
      const fresh: UploadRow[] = chosen.map((file, i) => ({
        key: nextKey(),
        file,
        status: i < room ? "checking" : "rejected",
        reason: i < room ? null : `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`,
        note: null,
        kind: null,
        mimeType: null,
        fileName: file.name,
        sha256: null,
        duplicates: [],
        sameAsKey: null,
        progress: 0,
        meta: emptyMeta(o.defaults),
        fieldErrors: {},
        result: null,
      }))
      commit([...existing, ...fresh])

      void (async () => {
        const checked: Array<{ key: string; sha256: string }> = []
        for (const row of fresh) {
          if (row.status !== "checking") continue
          try {
            const head = await readHead(row.file)
            const check = checkFile({ name: row.file.name, size: row.file.size, bytes: head, complete: row.file.size <= SNIFF_BYTES })
            if (!check.ok) {
              patchRow(row.key, { status: "rejected", reason: check.reason })
              continue
            }
            const sha = await hashFile(row.file)
            patchRow(row.key, (r) => ({
              status: "ready",
              kind: check.kind,
              mimeType: check.mime,
              fileName: check.fileName,
              note: check.note,
              sha256: sha,
              meta: { ...r.meta, title: r.meta.title || (o.purpose === "new_version" ? "" : titleFromFileName(check.fileName)) },
            }))
            checked.push({ key: row.key, sha256: sha })
          } catch {
            patchRow(row.key, { status: "rejected", reason: "This file couldn't be read. Check it opens on your computer, then try again." })
          }
        }
        if (checked.length) await lookUpDuplicates(checked)
      })()
    },
    [commit, patchRow, lookUpDuplicates]
  )

  const remove = React.useCallback(
    (key: string) => {
      aborts.current.get(key)?.abort()
      commit((prev) => prev.filter((r) => r.key !== key))
    },
    [commit]
  )

  const update = React.useCallback(
    (key: string, patch: Partial<UploadMeta>) =>
      patchRow(key, (r) => ({
        meta: { ...r.meta, ...patch },
        fieldErrors: Object.fromEntries(Object.entries(r.fieldErrors).filter(([k]) => !(k in patch))),
      })),
    [patchRow]
  )

  const applyToAll = React.useCallback(
    (patch: Partial<Pick<UploadMeta, "category" | "financialYear">>) =>
      commit((prev) => prev.map((r) => (r.status === "ready" || r.status === "failed" ? { ...r, meta: { ...r.meta, ...patch } } : r))),
    [commit]
  )

  const start = React.useCallback(async (): Promise<FinishedUpload[]> => {
    const o = optsRef.current
    const eligible = rowsRef.current.filter((r) => r.status === "ready" || r.status === "failed")
    if (eligible.length === 0) return []
    // Titles are required for a new document; check here so the person sees it on the row.
    const missing = o.purpose === "new_version" ? [] : eligible.filter((r) => !r.meta.title.trim())
    if (missing.length) {
      for (const r of missing) patchRow(r.key, { fieldErrors: { ...r.fieldErrors, title: "Give the document a title." } })
      setFormError({ message: missing.length === 1 ? "One file needs a title." : `${missing.length} files need a title.`, client: true })
      return []
    }
    setBusy(true)
    setFormError(null)
    for (const r of eligible) patchRow(r.key, { status: "uploading", progress: 0, reason: null, fieldErrors: {} })

    const finished: FinishedUpload[] = []
    try {
      const slotsRes = await requestUploadSlots({
        clientId: o.clientId,
        purpose: o.purpose ?? "new_document",
        documentId: o.documentId ?? null,
        requestItemId: o.requestItemId ?? null,
        acceptItem: o.acceptItem ?? false,
        source: o.source ?? "staff",
        files: eligible.map((r) => ({
          key: r.key,
          fileName: r.fileName,
          size: r.file.size,
          mimeType: r.mimeType as string,
          sha256: r.sha256,
          title: r.meta.title.trim() || titleFromFileName(r.fileName),
          category: r.meta.category,
          financialYear: r.meta.financialYear || null,
          period: r.meta.period || null,
          description: r.meta.description || null,
          tags: r.meta.tags,
          isConfidential: r.meta.isConfidential,
          expiryDate: r.meta.expiryDate || null,
          renewalDate: r.meta.renewalDate || null,
          changeNote: r.meta.changeNote || null,
        })),
      })
      if (!slotsRes.ok) {
        const byIndex = new Map<number, Partial<Record<keyof UploadMeta, string>>>()
        for (const [name, messages] of Object.entries(slotsRes.fieldErrors ?? {})) {
          const m = /^files\.(\d+)\.(\w+)$/.exec(name)
          if (!m) continue
          const field = m[2] as keyof UploadMeta
          const list = byIndex.get(Number(m[1])) ?? {}
          list[field] = messages[0]
          byIndex.set(Number(m[1]), list)
        }
        eligible.forEach((r, i) => patchRow(r.key, { status: "failed", progress: 0, fieldErrors: byIndex.get(i) ?? {}, reason: byIndex.has(i) ? "Check this file's details." : null }))
        setFormError({ message: slotsRes.error, ref: slotsRes.ref })
        return []
      }

      const queue = [...slotsRes.data.slots]
      const work = async () => {
        for (let slot = queue.shift(); slot; slot = queue.shift()) {
          const row = rowsRef.current.find((r) => r.key === slot!.key)
          if (!row) {
            await discardUpload({ uploadId: slot.uploadId, reason: "The file was removed before it uploaded." })
            continue
          }
          const abort = new AbortController()
          aborts.current.set(row.key, abort)
          try {
            await putFile(slot.signedUrl, row.file, slot.mimeType, (f) => patchRow(row.key, { progress: Math.round(f * 100) }), abort.signal)
          } catch (err) {
            await discardUpload({ uploadId: slot.uploadId, reason: err instanceof UploadTransportError ? err.message : "The upload didn't finish." })
            patchRow(row.key, { status: "failed", reason: err instanceof UploadTransportError ? err.message : "The upload didn't finish. Try again." })
            continue
          } finally {
            aborts.current.delete(row.key)
          }
          patchRow(row.key, { status: "saving", progress: 100 })
          const res = await confirmUpload({ uploadId: slot.uploadId })
          if (!res.ok) {
            patchRow(row.key, { status: "failed", reason: res.ref ? `${res.error} (Ref ${res.ref})` : res.error })
            continue
          }
          for (const w of res.warnings ?? []) toast.warning(w, { duration: 12_000 })
          finished.push(res.data)
          patchRow(row.key, { status: "done", result: res.data })
        }
      }
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, work))
    } catch {
      for (const r of rowsRef.current) if (r.status === "uploading" || r.status === "saving") patchRow(r.key, { status: "failed", reason: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setBusy(false)
    }
    if (finished.length) await o.onUploaded?.(finished)
    return finished
  }, [patchRow])

  const cancel = React.useCallback(() => {
    for (const a of aborts.current.values()) a.abort()
  }, [])

  const reset = React.useCallback(() => {
    for (const a of aborts.current.values()) a.abort()
    commit([])
    setFormError(null)
  }, [commit])

  const counts = React.useMemo(() => {
    const c = { total: rows.length, ready: 0, rejected: 0, done: 0, failed: 0, active: 0 }
    for (const r of rows) {
      if (r.status === "ready") c.ready++
      else if (r.status === "rejected") c.rejected++
      else if (r.status === "done") c.done++
      else if (r.status === "failed") c.failed++
      else c.active++
    }
    return c
  }, [rows])

  return {
    rows,
    addFiles,
    remove,
    update,
    applyToAll,
    start,
    cancel,
    reset,
    busy,
    canStart: !busy && counts.active === 0 && counts.ready + counts.failed > 0,
    formError,
    counts,
  }
}

// -------------------------------------------------------------------------------------------------
// Pieces
// -------------------------------------------------------------------------------------------------

/**
 * The drop zone: drag files onto it, or press "Choose files" (keyboard and touch). On phones the
 * picker offers the camera for photos.
 */
export function UploadDropzone({
  onFiles,
  multiple = true,
  disabled = false,
  compact = false,
  label,
  className,
}: {
  onFiles: (files: FileList | File[]) => void
  multiple?: boolean
  disabled?: boolean
  compact?: boolean
  label?: string
  className?: string
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [over, setOver] = React.useState(false)
  const hintId = React.useId()
  return (
    <div
      data-slot="upload-dropzone"
      onDragOver={(e) => {
        if (disabled) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!disabled && e.dataTransfer.files?.length) onFiles(e.dataTransfer.files)
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-2/50 text-center transition-colors duration-150",
        compact ? "px-3 py-3 sm:flex-row sm:justify-between sm:text-left" : "px-4 py-6",
        over && "border-primary bg-primary-soft",
        disabled && "opacity-60",
        className
      )}
    >
      <div className={cn("flex items-center gap-2", compact ? "" : "flex-col")}>
        <FileUpIcon aria-hidden="true" className="size-5 text-text-muted" />
        <div>
          <p className="text-base text-text">{label ?? (multiple ? "Drop files here, or choose them." : "Drop the file here, or choose it.")}</p>
          <p id={hintId} className="text-sm text-text-muted">
            {ALLOWED_TYPES_SENTENCE}, up to 25 MB each.
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept={ACCEPT_ATTRIBUTE}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files)
          e.target.value = ""
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={disabled} aria-describedby={hintId} onClick={() => inputRef.current?.click()}>
        <UploadIcon aria-hidden="true" />
        {multiple ? "Choose files" : "Choose file"}
      </Button>
    </div>
  )
}

function StatusLine({ row }: { row: UploadRow }) {
  switch (row.status) {
    case "checking":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
          <Spinner className="size-3.5" /> Checking
        </span>
      )
    case "rejected":
      return <span className="text-sm font-medium text-danger-text">Not uploaded</span>
    case "uploading":
      return <span className="num text-sm text-text-muted tabular-nums">{row.progress}%</span>
    case "saving":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
          <Spinner className="size-3.5" /> Checking the file
        </span>
      )
    case "done":
      return (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-success-text">
          <CheckIcon aria-hidden="true" className="size-3.5" /> Saved
        </span>
      )
    case "failed":
      return <span className="text-sm font-medium text-danger-text">Failed</span>
    default:
      return <span className="text-sm text-text-muted">Ready</span>
  }
}

function FieldLabel({ htmlFor, children, required }: { htmlFor: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-text">
      {children}
      {required ? <span className="text-danger-text"> *</span> : null}
    </label>
  )
}

/** Which fields each file shows: everything (the vault), a change note (a new version), or none. */
export type UploadFields = "full" | "version" | "none"

function RowFields({
  row,
  fields,
  onChange,
  allowConfidential,
  fyOptions,
}: {
  row: UploadRow
  fields: UploadFields
  onChange: (patch: Partial<UploadMeta>) => void
  allowConfidential: boolean
  fyOptions: string[]
}) {
  const id = (f: string) => `${row.key}-${f}`
  const [more, setMore] = React.useState(false)
  const err = row.fieldErrors
  const editable = row.status === "ready" || row.status === "failed"
  if (fields === "none" || !editable) return null
  if (fields === "version") {
    return (
      <div className="mt-3">
        <FieldLabel htmlFor={id("note")}>What changed</FieldLabel>
        <Textarea
          id={id("note")}
          rows={2}
          maxLength={500}
          placeholder="Revised after the client's corrections to Schedule 3"
          value={row.meta.changeNote}
          onChange={(e) => onChange({ changeNote: e.target.value })}
        />
      </div>
    )
  }
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="sm:col-span-2">
        <FieldLabel htmlFor={id("title")} required>
          Title
        </FieldLabel>
        <Input
          id={id("title")}
          value={row.meta.title}
          maxLength={200}
          aria-invalid={err.title ? true : undefined}
          aria-describedby={err.title ? id("title-err") : undefined}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        {err.title ? (
          <p id={id("title-err")} className="mt-1 text-sm text-danger-text">
            {err.title}
          </p>
        ) : null}
      </div>
      <div>
        <FieldLabel htmlFor={id("category")}>Category</FieldLabel>
        <NativeSelect id={id("category")} className="w-full" value={row.meta.category} onChange={(e) => onChange({ category: e.target.value as DocumentCategory })}>
          {CATEGORY_OPTIONS.map((c) => (
            <NativeSelectOption key={c.value} value={c.value}>
              {c.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div>
        <FieldLabel htmlFor={id("fy")}>Financial year</FieldLabel>
        <NativeSelect id={id("fy")} className="w-full" value={row.meta.financialYear} onChange={(e) => onChange({ financialYear: e.target.value })}>
          <NativeSelectOption value="">Not for one FY</NativeSelectOption>
          {fyOptions.map((fy) => (
            <NativeSelectOption key={fy} value={fy}>
              {fy}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {err.financialYear ? <p className="mt-1 text-sm text-danger-text">{err.financialYear}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor={id("period")}>Period</FieldLabel>
        <Input id={id("period")} value={row.meta.period} maxLength={40} placeholder="Sep 2026, Q2" onChange={(e) => onChange({ period: e.target.value })} />
      </div>
      <div className={cn(allowConfidential ? "sm:col-span-1 lg:col-span-2" : "sm:col-span-1 lg:col-span-3")}>
        <FieldLabel htmlFor={id("tags")}>Tags</FieldLabel>
        <TagInput id={id("tags")} value={row.meta.tags} onChange={(tags) => onChange({ tags })} placeholder="Add a tag" />
      </div>
      {allowConfidential ? (
        <div className="flex items-end pb-2">
          <label htmlFor={id("conf")} className="flex cursor-pointer items-start gap-2 text-base text-text">
            <Checkbox id={id("conf")} checked={row.meta.isConfidential} onCheckedChange={(v) => onChange({ isConfidential: v === true })} className="mt-0.5" />
            <span>
              Confidential
              <span className="block text-sm text-text-muted">Partners, Managers and this client&apos;s team only</span>
            </span>
          </label>
        </div>
      ) : null}
      <div className="sm:col-span-2 lg:col-span-4">
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ChevronDownIcon aria-hidden="true" className={cn("size-4 transition-transform duration-150", more && "rotate-180")} />
          {more ? "Fewer details" : "Description, expiry and renewal"}
        </button>
      </div>
      {more ? (
        <>
          <div className="sm:col-span-2">
            <FieldLabel htmlFor={id("desc")}>Description</FieldLabel>
            <Textarea id={id("desc")} rows={2} maxLength={2000} value={row.meta.description} onChange={(e) => onChange({ description: e.target.value })} />
          </div>
          <div>
            <FieldLabel htmlFor={id("expiry")}>Expires on</FieldLabel>
            <DatePicker id={id("expiry")} value={row.meta.expiryDate} onChange={(v) => onChange({ expiryDate: v })} />
          </div>
          <div>
            <FieldLabel htmlFor={id("renewal")}>Renew by</FieldLabel>
            <DatePicker id={id("renewal")} value={row.meta.renewalDate} onChange={(v) => onChange({ renewalDate: v })} />
            {err.renewalDate ? <p className="mt-1 text-sm text-danger-text">{err.renewalDate}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function DuplicateNote({ row, rows }: { row: UploadRow; rows: UploadRow[] }) {
  if (row.status === "rejected" || row.status === "done") return null
  if (row.sameAsKey) {
    const first = rows.find((r) => r.key === row.sameAsKey)
    return (
      <p className="mt-1 flex items-start gap-1.5 text-sm text-warning-text">
        <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
        Same contents as {first ? `“${first.fileName}”` : "another file"} in this upload.
      </p>
    )
  }
  if (row.duplicates.length === 0) return null
  const d = row.duplicates[0]
  const more = row.duplicates.length - 1
  return (
    <p className="mt-1 flex items-start gap-1.5 text-sm text-warning-text">
      <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
      <span>
        Already in the vault as “{d.title}”{d.isCurrent ? "" : ` (version ${d.version})`}, uploaded {formatDate(d.uploadedAt)}
        {d.inRecycleBin ? ", now in the recycle bin" : ""}
        {more > 0 ? ` and ${more} more` : ""}. You can still upload it.
      </span>
    </p>
  )
}

/** The files of an upload, each with its check, progress and (optionally) its details. */
export function UploadFileList({
  upload,
  fields = "full",
  allowConfidential = false,
  fyOptions,
  className,
}: {
  upload: DocumentUpload
  fields?: UploadFields
  allowConfidential?: boolean
  fyOptions?: string[]
  className?: string
}) {
  const fys = fyOptions ?? fyChoices()
  if (upload.rows.length === 0) return null
  return (
    <ul className={cn("flex flex-col divide-y divide-border rounded-lg border border-border", className)} aria-label="Files to upload">
      {upload.rows.map((row) => (
        <li key={row.key} className="px-3 py-3 sm:px-4">
          <div className="flex items-start gap-3">
            <FileTypeMark kind={row.kind} fileName={row.fileName} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate text-base font-medium text-text" title={row.fileName}>
                  {row.fileName}
                </p>
                <div className="flex flex-none items-center gap-2">
                  <StatusLine row={row} />
                  {row.status !== "uploading" && row.status !== "saving" && row.status !== "done" ? (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${row.fileName}`} onClick={() => upload.remove(row.key)}>
                      <XIcon aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <p className="num text-sm text-text-muted tabular-nums">{formatFileSize(row.file.size)}</p>
              {row.status === "uploading" ? <Progress value={row.progress} className="mt-2 h-1" aria-label={`Uploading ${row.fileName}`} /> : null}
              {row.reason ? <p className={cn("mt-1 text-sm", row.status === "rejected" || row.status === "failed" ? "text-danger-text" : "text-text-muted")}>{row.reason}</p> : null}
              {row.note && row.status !== "rejected" ? <p className="mt-1 text-sm text-text-muted">{row.note}</p> : null}
              <DuplicateNote row={row} rows={upload.rows} />
              <RowFields row={row} fields={fields} onChange={(patch) => upload.update(row.key, patch)} allowConfidential={allowConfidential} fyOptions={fys} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** "Set for all files": category and FY in one go, for a batch from the same return or year. */
export function ApplyToAll({ upload, fyOptions }: { upload: DocumentUpload; fyOptions?: string[] }) {
  const fys = fyOptions ?? fyChoices()
  const editable = upload.rows.filter((r) => r.status === "ready" || r.status === "failed").length
  if (editable < 2) return null
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5">
      <p className="w-full text-sm text-text-muted sm:w-auto sm:self-center">Set for all {editable} files:</p>
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Category
        <NativeSelect size="sm" defaultValue="" onChange={(e) => e.target.value && upload.applyToAll({ category: e.target.value as DocumentCategory })}>
          <NativeSelectOption value="">Choose</NativeSelectOption>
          {CATEGORY_OPTIONS.map((c) => (
            <NativeSelectOption key={c.value} value={c.value}>
              {c.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-text">
        Financial year
        <NativeSelect size="sm" defaultValue="" onChange={(e) => upload.applyToAll({ financialYear: e.target.value === "none" ? "" : e.target.value })}>
          <NativeSelectOption value="">Choose</NativeSelectOption>
          <NativeSelectOption value="none">Not for one FY</NativeSelectOption>
          {fys.map((fy) => (
            <NativeSelectOption key={fy} value={fy}>
              {fy}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
    </div>
  )
}

function startLabel(u: DocumentUpload, verb = "Upload"): string {
  const n = u.counts.ready + u.counts.failed
  if (u.counts.failed && !u.counts.ready) return n === 1 ? "Retry" : `Retry ${n} files`
  return n <= 1 ? verb : `${verb} ${n} files`
}

/**
 * An inline uploader with its own button: one file (or several) straight into the vault. For the
 * portal's request items, task attachments and anywhere a dialog would be too much.
 */
export function DocumentUploader({
  fields = "none",
  allowConfidential = false,
  buttonLabel = "Upload",
  dropzoneLabel,
  className,
  ...opts
}: UploadOptions & {
  fields?: UploadFields
  allowConfidential?: boolean
  buttonLabel?: string
  dropzoneLabel?: string
  className?: string
}) {
  const up = useDocumentUpload(opts)
  const single = opts.single ?? (opts.purpose === "request_item" || opts.purpose === "new_version")
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <FormAlert error={up.formError} className="mb-0" />
      {up.rows.length === 0 || !single ? <UploadDropzone onFiles={up.addFiles} multiple={!single} disabled={up.busy} compact label={dropzoneLabel} /> : null}
      <UploadFileList upload={up} fields={fields} allowConfidential={allowConfidential} />
      {up.rows.some((r) => r.status !== "done") ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {single && up.rows.length > 0 && !up.busy ? (
            <Button type="button" variant="ghost" size="sm" onClick={up.reset}>
              Choose another file
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => void up.start()} disabled={!up.canStart} aria-busy={up.busy}>
            {up.busy ? <Spinner /> : up.counts.failed && !up.counts.ready ? <RotateCcwIcon aria-hidden="true" /> : <UploadIcon aria-hidden="true" />}
            {startLabel(up, buttonLabel)}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The vault's upload dialog (§7.14): drag-drop several files, each with its category, FY, period,
 * title (from the file name), tags and the confidential flag; or one file as a new version with a
 * change note. The footer's button is always visible (§0.1 rule 4); closing is blocked while files
 * are uploading.
 */
export function UploadDialog({
  open,
  onOpenChange,
  clientName,
  title,
  description,
  allowConfidential,
  fields = "full",
  fyOptions,
  ...opts
}: UploadOptions & {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientName: string
  title?: string
  description?: string
  allowConfidential: boolean
  fields?: UploadFields
  fyOptions?: string[]
}) {
  const up = useDocumentUpload(opts)
  const single = opts.single ?? opts.purpose === "new_version"
  const { reset } = up
  React.useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const allDone = up.counts.total > 0 && up.counts.done === up.counts.total - up.counts.rejected && up.counts.done > 0 && !up.busy
  const footer = (
    <div className="ml-auto flex items-center gap-2">
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={up.busy}>
        {allDone ? "Close" : "Cancel"}
      </Button>
      {allDone ? null : (
        <Button type="button" onClick={() => void up.start()} disabled={!up.canStart} aria-busy={up.busy}>
          {up.busy ? <Spinner /> : <UploadIcon aria-hidden="true" />}
          {up.busy ? "Uploading" : startLabel(up)}
        </Button>
      )}
    </div>
  )
  const summary =
    up.counts.total === 0
      ? null
      : [
          up.counts.done ? `${up.counts.done} saved` : null,
          up.counts.failed ? `${up.counts.failed} failed` : null,
          up.counts.rejected ? `${up.counts.rejected} not allowed` : null,
          up.counts.ready ? `${up.counts.ready} ready` : null,
        ]
          .filter(Boolean)
          .join(" · ")

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={title ?? (single ? "Upload a new version" : "Upload documents")}
      description={description ?? `Into ${clientName}'s document vault.`}
      pending={up.busy}
      dirty={up.counts.ready + up.counts.failed > 0}
      footer={footer}
      footerStart={summary ? <span aria-live="polite">{summary}</span> : null}
    >
      <div className="flex flex-col gap-4">
        <FormAlert error={up.formError} className="mb-0" />
        {!single || up.rows.length === 0 ? <UploadDropzone onFiles={up.addFiles} multiple={!single} disabled={up.busy} /> : null}
        <ApplyToAll upload={up} fyOptions={fyOptions} />
        <UploadFileList upload={up} fields={fields} allowConfidential={allowConfidential} fyOptions={fyOptions} />
        {single && up.rows.length > 0 && !up.busy && up.counts.done === 0 ? (
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={up.reset}>
              Choose another file
            </Button>
          </div>
        ) : null}
      </div>
    </FormDialog>
  )
}

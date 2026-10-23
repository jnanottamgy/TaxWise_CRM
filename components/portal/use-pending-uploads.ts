"use client"

import * as React from "react"
import { checkFile, SNIFF_BYTES, titleFromFileName, type FileKind } from "@/lib/domain/files"
import type { DocumentCategory } from "@/lib/domain/enums"
import { discardUpload, requestUploadSlots } from "@/server/actions/documents"
import { hashFile, putFile, readHead, UploadTransportError } from "@/components/documents/upload-transport"

/**
 * Files a portal user attaches to something else (a message, an "I've paid" screenshot), uploaded
 * before the action that uses them and confirmed BY that action (§7.22). The documents module's
 * first two steps (server/actions/documents.ts): check the file in the browser (type by magic
 * bytes, 25 MB, name), reserve a slot (requestUploadSlots: always source client_portal for a portal
 * user) and PUT the bytes to its signed URL. The caller's action then checks the stored file over
 * its whole length and confirms it (finishUpload / submit_portal_payment_claim), so a file is never
 * a document on its own. A slot that is never used expires and the cleanup job removes its object.
 *
 *   const files = usePendingUploads({ clientId, max: 5, category: "other" })
 *   <PortalDropzone onFiles={files.add} multiple />
 *   const up = await files.uploadAll()   // { ok, uploadIds } in the order chosen
 *   const res = await sendPortalMessage({ body, uploadIds: up.uploadIds })
 */

export type PendingStatus = "checking" | "ready" | "rejected" | "uploading" | "uploaded" | "failed"

export interface PendingFile {
  key: string
  file: File
  status: PendingStatus
  reason: string | null
  kind: FileKind | null
  mimeType: string | null
  fileName: string
  sha256: string | null
  progress: number
  /** Set once the bytes are stored; reused if the action is retried. */
  uploadId: string | null
}

export type UploadAllResult = { ok: true; uploadIds: string[] } | { ok: false; error: string; ref?: string }

export interface PendingUploads {
  files: PendingFile[]
  add: (list: FileList | File[]) => void
  remove: (key: string) => void
  reset: () => void
  uploadAll: () => Promise<UploadAllResult>
  busy: boolean
  /** Files still being checked: wait before sending. */
  checking: boolean
  /** Ready or uploaded files (what the action will receive). */
  usable: number
}

let seq = 0
const nextKey = () => `pf${++seq}`

export function usePendingUploads(opts: { clientId: string; max: number; category?: DocumentCategory; titleFor?: (fileName: string) => string }): PendingUploads {
  const [files, setFiles] = React.useState<PendingFile[]>([])
  const [busy, setBusy] = React.useState(false)
  const ref = React.useRef<PendingFile[]>([])
  const optsRef = React.useRef(opts)
  React.useEffect(() => {
    optsRef.current = opts
  })

  const commit = React.useCallback((next: (prev: PendingFile[]) => PendingFile[]) => {
    setFiles((prev) => {
      const value = next(prev)
      ref.current = value
      return value
    })
  }, [])
  const patch = React.useCallback((key: string, p: Partial<PendingFile>) => commit((prev) => prev.map((f) => (f.key === key ? { ...f, ...p } : f))), [commit])

  const add = React.useCallback(
    (list: FileList | File[]) => {
      const o = optsRef.current
      const chosen = Array.from(list)
      if (chosen.length === 0) return
      const kept = o.max === 1 ? [] : ref.current
      const room = Math.max(0, o.max - kept.filter((f) => f.status !== "rejected").length)
      const fresh: PendingFile[] = chosen.map((file, i) => ({
        key: nextKey(),
        file,
        status: i < room ? "checking" : "rejected",
        reason: i < room ? null : o.max === 1 ? "Attach one file." : `Attach at most ${o.max} files.`,
        kind: null,
        mimeType: null,
        fileName: file.name,
        sha256: null,
        progress: 0,
        uploadId: null,
      }))
      commit(() => [...kept, ...fresh])
      void (async () => {
        for (const f of fresh) {
          if (f.status !== "checking") continue
          try {
            const head = await readHead(f.file)
            const check = checkFile({ name: f.file.name, size: f.file.size, bytes: head, complete: f.file.size <= SNIFF_BYTES })
            if (!check.ok) {
              patch(f.key, { status: "rejected", reason: check.reason })
              continue
            }
            patch(f.key, { status: "ready", kind: check.kind, mimeType: check.mime, fileName: check.fileName, sha256: await hashFile(f.file), reason: check.note })
          } catch {
            patch(f.key, { status: "rejected", reason: "This file couldn't be read. Check it opens on your device, then try again." })
          }
        }
      })()
    },
    [commit, patch]
  )

  const remove = React.useCallback((key: string) => commit((prev) => prev.filter((f) => f.key !== key)), [commit])
  const reset = React.useCallback(() => commit(() => []), [commit])

  const uploadAll = React.useCallback(async (): Promise<UploadAllResult> => {
    const o = optsRef.current
    const current = ref.current.filter((f) => f.status !== "rejected")
    if (current.some((f) => f.status === "checking")) return { ok: false, error: "A file is still being checked. Wait a moment and try again." }
    const todo = current.filter((f) => f.status === "ready" || f.status === "failed")
    if (todo.length === 0) return { ok: true, uploadIds: current.map((f) => f.uploadId).filter((v): v is string => !!v) }

    setBusy(true)
    try {
      for (const f of todo) patch(f.key, { status: "uploading", progress: 0, reason: null })
      const slots = await requestUploadSlots({
        clientId: o.clientId,
        purpose: "new_document",
        files: todo.map((f) => ({
          key: f.key,
          fileName: f.fileName,
          size: f.file.size,
          mimeType: f.mimeType as string,
          sha256: f.sha256,
          title: (o.titleFor ? o.titleFor(f.fileName) : titleFromFileName(f.fileName)).slice(0, 200) || "Attachment",
          category: o.category ?? "other",
        })),
      })
      if (!slots.ok) {
        for (const f of todo) patch(f.key, { status: "failed", progress: 0 })
        return { ok: false, error: slots.error, ref: slots.ref }
      }
      for (const slot of slots.data.slots) {
        const f = ref.current.find((x) => x.key === slot.key)
        if (!f) {
          await discardUpload({ uploadId: slot.uploadId, reason: "The file was removed before it uploaded." })
          continue
        }
        try {
          await putFile(slot.signedUrl, f.file, slot.mimeType, (p) => patch(f.key, { progress: Math.round(p * 100) }))
          patch(f.key, { status: "uploaded", progress: 100, uploadId: slot.uploadId })
        } catch (err) {
          const reason = err instanceof UploadTransportError ? err.message : "The upload didn't finish. Try again."
          await discardUpload({ uploadId: slot.uploadId, reason })
          patch(f.key, { status: "failed", reason })
          return { ok: false, error: `${f.fileName} didn't upload: ${reason}` }
        }
      }
      return { ok: true, uploadIds: ref.current.filter((f) => f.status === "uploaded" && f.uploadId).map((f) => f.uploadId as string) }
    } catch {
      for (const f of ref.current) if (f.status === "uploading") patch(f.key, { status: "failed", reason: "We couldn't reach the server. Check your connection and try again." })
      return { ok: false, error: "We couldn't reach the server. Check your connection and try again." }
    } finally {
      setBusy(false)
    }
  }, [patch])

  return {
    files,
    add,
    remove,
    reset,
    uploadAll,
    busy,
    checking: files.some((f) => f.status === "checking"),
    usable: files.filter((f) => f.status === "ready" || f.status === "uploaded" || f.status === "failed" || f.status === "uploading").length,
  }
}

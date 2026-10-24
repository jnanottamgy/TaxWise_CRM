"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { DownloadIcon, EyeIcon, PaperclipIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { DocumentUploader } from "@/components/documents/uploader"
import { FileTypeMark } from "@/components/documents/file-type-mark"
import { documentsHref, fileHref } from "@/components/documents/doc-urls"
import { formatFileSize, previewKind } from "@/lib/domain/files"
import { formatTimeAgo } from "@/lib/format"
import type { DocumentCategory } from "@/lib/domain/enums"
import { attachTaskDocuments, detachTaskDocument } from "@/server/actions/tasks"
import { toastResult } from "@/components/tasks/task-ui"

/**
 * Attachments (§5.5 task_attachments, §7.6.6 "stored through the documents vault"): each file goes
 * into the client's documents with its checks (type by magic bytes, 25 MB, duplicate warning) and
 * is linked to the task. Removing the link leaves the file in the client's documents.
 */

export type AttachmentRow = {
  id: string
  document_id: string | null
  title: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  uploaded_by: string | null
  uploaded_by_name: string | null
  created_at: string
}

export function TaskAttachments({
  taskId,
  clientId,
  attachments,
  canUpload,
  viewerId,
  canModerate,
  defaults,
  now: serverNow,
}: {
  taskId: string
  clientId: string
  attachments: AttachmentRow[]
  /** The viewer can add files to this client's documents. */
  canUpload: boolean
  viewerId: string
  canModerate: boolean
  defaults: { category: DocumentCategory; financialYear: string; period: string }
  /** The server's render time (ISO), so "2 minutes ago" hydrates to the same text. */
  now?: string
}) {
  const router = useRouter()
  const [now] = React.useState(() => (serverNow ? new Date(serverNow) : new Date()))
  const [adding, setAdding] = React.useState(false)
  const live = attachments.filter((a) => a.document_id)
  return (
    <SectionCard
      title="Attachments"
      description={live.length ? `${live.length} ${live.length === 1 ? "file" : "files"} in the client's documents` : undefined}
      action={
        canUpload && !adding ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <PaperclipIcon aria-hidden="true" />
            Attach files
          </Button>
        ) : null
      }
      flush
    >
      {adding ? (
        <div className="border-b border-border px-4 pb-4 md:px-5">
          <DocumentUploader
            clientId={clientId}
            purpose="new_document"
            fields="none"
            buttonLabel="Upload and attach"
            defaults={{ category: defaults.category, financialYear: defaults.financialYear, period: defaults.period }}
            onUploaded={async (done) => {
              const ids = done.map((d) => d.documentId)
              if (!ids.length) return
              const r = await attachTaskDocuments({ task_id: taskId, document_ids: ids })
              if (toastResult(r, `${ids.length === 1 ? "File" : `${ids.length} files`} attached.`)) {
                setAdding(false)
                router.refresh()
              }
            }}
          />
          <div className="mt-2 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
      {attachments.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" message="No files attached. Working papers, the client's data and acknowledgements go here." />
        </div>
      ) : (
        <ul>
          {attachments.map((a) => (
            <li key={a.id} className="flex min-h-14 items-center gap-3 border-t border-border/70 px-4 py-2 first:border-t-0 md:px-5">
              <FileTypeMark mimeType={a.mime_type} fileName={a.file_name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-text">{a.title ?? a.file_name ?? "Removed document"}</p>
                <p className="truncate text-xs text-text-muted">
                  {a.document_id ? `${formatFileSize(a.file_size)} · ` : "Moved to the recycle bin · "}
                  {a.uploaded_by_name ?? "Someone"} · {formatTimeAgo(a.created_at, now)}
                </p>
              </div>
              {a.document_id ? (
                <span className="flex flex-none items-center gap-1">
                  {previewKind(a.mime_type ?? "") ? (
                    <Button asChild variant="ghost" size="icon-sm">
                      <a href={fileHref(a.document_id, { mode: "preview" })} target="_blank" rel="noopener" aria-label={`Preview ${a.title ?? a.file_name}`}>
                        <EyeIcon aria-hidden="true" />
                      </a>
                    </Button>
                  ) : null}
                  <Button asChild variant="ghost" size="icon-sm">
                    <a href={fileHref(a.document_id)} aria-label={`Download ${a.title ?? a.file_name}`}>
                      <DownloadIcon aria-hidden="true" />
                    </a>
                  </Button>
                </span>
              ) : null}
              {a.uploaded_by === viewerId || canModerate ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${a.title ?? "the attachment"} from this task`}
                  onClick={async () => {
                    const r = await detachTaskDocument({ id: a.id })
                    if (toastResult(r, "Removed from the task. The file stays in the client's documents.")) router.refresh()
                  }}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border px-4 py-2.5 md:px-5">
        <a href={documentsHref(clientId, {})} className="text-sm font-medium text-text underline-offset-4 hover:underline">
          All of this client&apos;s documents
        </a>
      </div>
    </SectionCard>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { DownloadIcon, EyeIcon, PaperclipIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Label } from "@/components/ui/label"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { DocumentUploader } from "@/components/documents/uploader"
import { FileTypeMark } from "@/components/documents/file-type-mark"
import { documentsHref, fileHref } from "@/components/documents/doc-urls"
import { formatFileSize, previewKind } from "@/lib/domain/files"
import { formatDate } from "@/lib/format"
import type { DocumentCategory } from "@/lib/domain/enums"
import { NOTICE_DOCUMENT_KINDS, NOTICE_DOCUMENT_KIND_LABEL, type NoticeDocumentKind, type TaxArea } from "@/lib/schemas/notices"
import { attachNoticeDocuments, detachNoticeDocument } from "@/server/actions/notices"
import type { NoticeDocument } from "@/lib/data/notices"

function categoryFor(area: TaxArea | null): DocumentCategory {
  return area === "gst" ? "gst" : area === "tds" ? "tds" : area === "income_tax" ? "income_tax" : "other"
}

/**
 * The notice, the reply and the order (§7.8.4 "attach the notice, the reply and the order"): each
 * file goes into the client's document vault with its checks (type by magic bytes, 25 MB, duplicate
 * warning, §12) and is linked here with what it is. Removing the link leaves the file in the vault.
 */
export function NoticeDocuments({
  noticeId,
  clientId,
  taxArea,
  financialYear,
  documents,
  canUpload,
}: {
  noticeId: string
  clientId: string
  taxArea: TaxArea | null
  financialYear: string | null
  documents: NoticeDocument[]
  canUpload: boolean
}) {
  const router = useRouter()
  const [adding, setAdding] = React.useState(false)
  const [kind, setKind] = React.useState<NoticeDocumentKind>(documents.some((d) => d.kind === "notice") ? "reply" : "notice")
  const kindId = React.useId()

  return (
    <SectionCard
      title="Documents"
      description={documents.length ? `${documents.length} in the client's documents` : undefined}
      action={
        canUpload && !adding ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <PaperclipIcon aria-hidden="true" />
            Attach
          </Button>
        ) : null
      }
      flush
    >
      {adding ? (
        <div className="border-b border-border px-4 pb-4 md:px-5">
          <div className="mb-3 flex flex-col gap-1.5">
            <Label htmlFor={kindId}>What is it?</Label>
            <NativeSelect id={kindId} value={kind} onChange={(e) => setKind(e.target.value as NoticeDocumentKind)}>
              {NOTICE_DOCUMENT_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {NOTICE_DOCUMENT_KIND_LABEL[k]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <DocumentUploader
            clientId={clientId}
            purpose="new_document"
            fields="none"
            buttonLabel="Upload and attach"
            defaults={{ category: categoryFor(taxArea), financialYear: financialYear ?? "" }}
            onUploaded={async (done) => {
              const ids = done.map((d) => d.documentId)
              if (!ids.length) return
              const r = await attachNoticeDocuments({ notice_id: noticeId, document_ids: ids, kind })
              if (!r.ok) {
                toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                return
              }
              for (const w of r.warnings ?? []) toast.warning(w)
              toast.success(ids.length === 1 ? "Attached." : `${ids.length} files attached.`)
              setAdding(false)
              router.refresh()
            }}
          />
          <div className="mt-2 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
      {documents.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" message="No documents yet. Attach the notice as received, then the reply and the order." />
        </div>
      ) : (
        <ul>
          {documents.map((d) => (
            <li key={d.id} className="flex min-h-14 items-center gap-3 border-t border-border/70 px-4 py-2 first:border-t-0 md:px-5">
              <FileTypeMark mimeType={d.mime_type} fileName={d.file_name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-text">{d.title ?? d.file_name ?? "Document"}</p>
                <p className="truncate text-xs text-text-muted">
                  {NOTICE_DOCUMENT_KIND_LABEL[d.kind]} · {d.deleted ? "Moved to the recycle bin" : formatFileSize(d.file_size)} · {formatDate(d.created_at)}
                </p>
              </div>
              {!d.deleted ? (
                <span className="flex flex-none items-center gap-1">
                  {previewKind(d.mime_type ?? "") ? (
                    <Button asChild variant="ghost" size="icon-sm">
                      <a href={fileHref(d.document_id, { mode: "preview" })} target="_blank" rel="noopener" aria-label={`Preview ${d.title ?? d.file_name ?? "the document"}`}>
                        <EyeIcon aria-hidden="true" />
                      </a>
                    </Button>
                  ) : null}
                  <Button asChild variant="ghost" size="icon-sm">
                    <a href={fileHref(d.document_id)} aria-label={`Download ${d.title ?? d.file_name ?? "the document"}`}>
                      <DownloadIcon aria-hidden="true" />
                    </a>
                  </Button>
                </span>
              ) : null}
              {canUpload ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${d.title ?? "the document"} from this notice`}
                  onClick={async () => {
                    const r = await detachNoticeDocument({ id: d.id })
                    if (!r.ok) {
                      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                      return
                    }
                    toast.success("Removed from the notice. The file stays in the client's documents.")
                    router.refresh()
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

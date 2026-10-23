"use client"

import { CheckIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatFileSize } from "@/lib/domain/files"
import { FileTypeMark } from "@/components/documents/file-type-mark"
import type { PendingFile, PendingUploads } from "@/components/portal/use-pending-uploads"

function Status({ f }: { f: PendingFile }) {
  switch (f.status) {
    case "checking":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
          <Spinner className="size-3.5" /> Checking
        </span>
      )
    case "uploading":
      return <span className="num text-sm text-text-muted tabular-nums">{f.progress}%</span>
    case "uploaded":
      return (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-success-text">
          <CheckIcon aria-hidden="true" className="size-3.5" /> Uploaded
        </span>
      )
    case "rejected":
      return <span className="text-sm font-medium text-danger-text">Can&apos;t attach</span>
    case "failed":
      return <span className="text-sm font-medium text-danger-text">Didn&apos;t upload</span>
    default:
      return <span className="text-sm text-text-muted">Ready</span>
  }
}

/** The files chosen for a message or a payment report, each with its status and a remove button. */
export function PendingFileList({ uploads, className }: { uploads: PendingUploads; className?: string }) {
  if (uploads.files.length === 0) return null
  return (
    <ul aria-label="Attached files" className={cn("flex flex-col divide-y divide-border rounded-lg border border-border", className)}>
      {uploads.files.map((f) => (
        <li key={f.key} className="flex items-start gap-3 px-3 py-2.5">
          <FileTypeMark kind={f.kind} fileName={f.fileName} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-base text-text" title={f.fileName}>
                {f.fileName}
              </p>
              <div className="flex flex-none items-center gap-1.5">
                <Status f={f} />
                {f.status !== "uploading" ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${f.fileName}`} onClick={() => uploads.remove(f.key)} disabled={uploads.busy}>
                    <XIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="num text-sm text-text-muted tabular-nums">{formatFileSize(f.file.size)}</p>
            {f.reason ? <p className={cn("mt-0.5 text-sm", f.status === "rejected" || f.status === "failed" ? "text-danger-text" : "text-text-muted")}>{f.reason}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

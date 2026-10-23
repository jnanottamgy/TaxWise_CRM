import { cn } from "@/lib/utils"
import { extensionOf, FILE_TYPES, fileTypeOfMime, type FileKind } from "@/lib/domain/files"

/**
 * The file's type as a small neutral tile with its extension ("PDF", "XLSX"): the media slot of a
 * file row, so names start on one edge (taste §7.7). Data, not decoration: grey, no colour per type.
 * Server-safe.
 *
 *   <FileTypeMark kind="pdf" />   <FileTypeMark mimeType={doc.mime_type} fileName={doc.file_name} size="lg" />
 */
export function FileTypeMark({
  kind,
  mimeType,
  fileName,
  size = "md",
  className,
}: {
  kind?: FileKind | null
  mimeType?: string | null
  fileName?: string | null
  size?: "md" | "lg"
  className?: string
}) {
  const type = kind ? FILE_TYPES[kind] : fileTypeOfMime(mimeType)
  const label = (type?.ext ?? (extensionOf(fileName) || "file")).toUpperCase().slice(0, 4)
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-end justify-center rounded-md border border-border bg-surface-2 font-medium text-text-muted",
        size === "lg" ? "h-14 w-11 pb-1.5 text-xs" : "h-10 w-9 pb-1 text-xs leading-none",
        className
      )}
    >
      {label}
    </span>
  )
}

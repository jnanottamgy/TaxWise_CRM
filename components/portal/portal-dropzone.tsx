"use client"

import * as React from "react"
import { CameraIcon, FileUpIcon, UploadIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ACCEPT_ATTRIBUTE, ALLOWED_TYPES_SENTENCE } from "@/lib/domain/files"

/**
 * Where a portal user puts a file (§7.22 "per-item upload (drag-drop or camera on mobile)"): drop it
 * on the box, or press "Choose file" (keyboard and touch), or on a phone "Take a photo", which opens
 * the camera straight away (`capture="environment"`). Same file rules as the vault (§5.8: 25 MB,
 * PDF, images, spreadsheets, Word); the checks themselves run in the caller's upload hook.
 */
export function PortalDropzone({
  onFiles,
  multiple = false,
  disabled = false,
  compact = false,
  photo = true,
  label,
  className,
}: {
  onFiles: (files: FileList | File[]) => void
  multiple?: boolean
  disabled?: boolean
  /** A single row (inside a list item or a composer). */
  compact?: boolean
  /** Offer "Take a photo" on touch screens. */
  photo?: boolean
  label?: string
  className?: string
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const cameraRef = React.useRef<HTMLInputElement>(null)
  const hintId = React.useId()
  const [over, setOver] = React.useState(false)

  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) onFiles(e.target.files)
    e.target.value = ""
  }

  return (
    <div
      data-slot="portal-dropzone"
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
        "flex rounded-lg border border-dashed border-border bg-surface-2/50 transition-colors duration-150",
        compact ? "flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" : "flex-col items-center gap-3 px-4 py-5 text-center",
        over && "border-primary bg-primary-soft",
        disabled && "opacity-60",
        className
      )}
    >
      <div className={cn("flex min-w-0 gap-2", compact ? "items-center" : "flex-col items-center")}>
        <FileUpIcon aria-hidden="true" className="size-5 flex-none text-text-muted" />
        <div className="min-w-0">
          <p className="text-base text-text">
            <span className="pointer-coarse:hidden">{label ?? (multiple ? "Drop files here, or choose them." : "Drop the file here, or choose it.")}</span>
            <span className="hidden pointer-coarse:inline">{label ?? (multiple ? "Choose files, or take a photo." : "Choose a file, or take a photo.")}</span>
          </p>
          <p id={hintId} className="text-sm text-text-muted">
            {ALLOWED_TYPES_SENTENCE}, up to 25 MB.
          </p>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept={ACCEPT_ATTRIBUTE}
        multiple={multiple}
        disabled={disabled}
        onChange={take}
      />
      {photo ? (
        <input
          ref={cameraRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept="image/*"
          capture="environment"
          disabled={disabled}
          onChange={take}
        />
      ) : null}
      <div className={cn("flex flex-none flex-wrap gap-2", compact ? "" : "justify-center")}>
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-describedby={hintId} onClick={() => fileRef.current?.click()} className="pointer-coarse:h-11">
          <UploadIcon aria-hidden="true" />
          {multiple ? "Choose files" : "Choose file"}
        </Button>
        {photo ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => cameraRef.current?.click()}
            className="hidden pointer-coarse:inline-flex pointer-coarse:h-11"
          >
            <CameraIcon aria-hidden="true" />
            Take a photo
          </Button>
        ) : null}
      </div>
    </div>
  )
}

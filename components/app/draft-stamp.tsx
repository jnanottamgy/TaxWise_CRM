"use client"

import { cn } from "@/lib/utils"
import { formatTime } from "@/lib/format"
import { Spinner } from "@/components/ui/spinner"

/**
 * "Draft saved · 12:41" (§3.4), for the footer of long forms. Times are IST.
 *
 *   <DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} />
 */
export function DraftStamp({
  savedAt,
  saving = false,
  error,
  className,
}: {
  savedAt: Date | string | null | undefined
  saving?: boolean
  error?: string | null
  className?: string
}) {
  return (
    <p role="status" aria-live="polite" className={cn("flex min-w-0 items-center gap-1.5 text-sm text-text-muted", className)}>
      {saving ? (
        <>
          <Spinner className="size-3.5" aria-label="Saving" />
          <span>Saving draft…</span>
        </>
      ) : error ? (
        <span className="text-warning-text">{error}</span>
      ) : savedAt ? (
        <span className="num tabular-nums">Draft saved · {formatTime(typeof savedAt === "string" ? savedAt : savedAt.toISOString())}</span>
      ) : (
        <span>Not saved yet</span>
      )}
    </p>
  )
}

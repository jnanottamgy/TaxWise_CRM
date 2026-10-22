"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ClipboardCheckIcon } from "lucide-react"
import { formatDate, formatDateTime } from "@/lib/format"
import { markLawReviewed } from "@/server/actions/law"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmDialog } from "@/components/app/confirm-dialog"

/**
 * "Last reviewed on" (§5.12) with the number of items still awaiting confirmation, and the action
 * that records a review (every new Finance Act and each notification season, §8 New FY).
 */
export function ReviewStamp({
  lastReviewedAt,
  lastReviewedByName,
  awaiting,
}: {
  lastReviewedAt: string | null
  lastReviewedByName: string | null
  awaiting: number
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState("")
  const noteId = React.useId()

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between md:px-5">
      <div className="min-w-0 text-base">
        <p className="text-text">
          {lastReviewedAt ? (
            <>
              Last reviewed on <span className="num font-medium" title={formatDateTime(lastReviewedAt)}>{formatDate(lastReviewedAt)}</span>
              {lastReviewedByName ? <> by {lastReviewedByName}</> : null}
            </>
          ) : (
            <>Not reviewed yet</>
          )}
        </p>
        <p className="mt-0.5 text-sm text-text-muted">
          {awaiting > 0 ? (
            <>
              <span className="font-medium text-warning-text">
                {awaiting.toLocaleString("en-IN")} item{awaiting === 1 ? "" : "s"} awaiting partner confirmation
              </span>
              . Confirm each one before go-live.
            </>
          ) : (
            "Every item in force has been confirmed by a Partner."
          )}
        </p>
      </div>
      <Button type="button" variant="outline" className="flex-none" onClick={() => setOpen(true)}>
        <ClipboardCheckIcon aria-hidden="true" />
        Record a review
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setNote("")
        }}
        title="Record that you reviewed Law & rules?"
        description="Records today as the date the parameters, due-date rules, extensions and concordance were last checked against the current Finance Act, notifications and circulars."
        details={
          <div className="flex flex-col gap-1.5">
            <label htmlFor={noteId} className="text-sm font-medium text-text">
              Note <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} placeholder="e.g. Checked against Finance Act 2027 and CBDT notifications to date" />
          </div>
        }
        confirmLabel="Record review"
        onConfirm={async () => {
          const r = await markLawReviewed({ note })
          if (!r.ok) {
            toast.error(r.error)
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success("Review recorded")
          setNote("")
          router.refresh()
        }}
      />
    </div>
  )
}

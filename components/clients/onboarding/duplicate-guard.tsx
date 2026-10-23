"use client"

import Link from "next/link"
import { ExternalLinkIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { describeDuplicate, duplicateBlocks, type DuplicateCandidate } from "@/lib/domain/conflict"
import { Button } from "@/components/ui/button"
import { TextareaField } from "@/components/app/form/fields"
import type { OnboardingControl } from "@/components/clients/onboarding/types"

export type DuplicateState = {
  status: "idle" | "checking" | "ready" | "error"
  duplicates: DuplicateCandidate[]
  error: string | null
}

/**
 * The duplicate guard (§7.3.2 step 1): "This looks like X (TW-C-0042)" for a client (the recycle
 * bin too) with the same PAN or GSTIN, or a close name. Open existing goes to that client (or the
 * recycle bin, to restore it). A close name can be passed with a reason (Continue anyway); the same
 * PAN or GSTIN can't, because they are unique.
 */
export function DuplicateGuard({
  state,
  control,
  continuing,
  onContinueAnyway,
  onRetry,
}: {
  state: DuplicateState
  control: OnboardingControl
  continuing: boolean
  onContinueAnyway: () => void
  onRetry: () => void
}) {
  if (state.status === "error") {
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-muted">
        <span className="min-w-0 flex-1">{state.error ?? "Couldn't check for an existing client with these details."}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />
          Check again
        </Button>
      </div>
    )
  }
  if (state.duplicates.length === 0) return null
  const blocking = state.duplicates.filter(duplicateBlocks)
  const shown = (blocking.length ? blocking : state.duplicates).slice(0, 3)
  const canContinue = blocking.length === 0
  return (
    <div role="alert" className={cn("flex flex-col gap-3 rounded-lg border px-4 py-3", blocking.length ? "border-danger/30 bg-danger-soft" : "border-warning/40 bg-warning-soft")}>
      <ul className="flex flex-col gap-2.5">
        {shown.map((d) => {
          const text = describeDuplicate(d)
          return (
            <li key={`${d.clientId}:${d.matchedOn}`} className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
              <TriangleAlertIcon aria-hidden="true" className={cn("mt-0.5 size-4 flex-none", blocking.length ? "text-danger-text" : "text-warning-text")} />
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium text-text">{text.headline}</p>
                <p className="text-sm text-text-muted">{text.detail}</p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={d.inRecycleBin ? "/recycle-bin" : `/clients/${d.clientId}`} target="_blank" rel="noopener">
                  {d.inRecycleBin ? "Open the recycle bin" : "Open existing"}
                  <ExternalLinkIcon aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab; this draft is kept)</span>
                </Link>
              </Button>
            </li>
          )
        })}
      </ul>
      {canContinue ? (
        continuing ? (
          <TextareaField
            control={control}
            name="duplicate_reason"
            label="Why is this a different client?"
            required
            rows={2}
            placeholder="For example: a different business with a similar name, run by another family"
            helper="Kept on the client's timeline."
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onContinueAnyway}>
              Continue anyway
            </Button>
            <span className="text-sm text-text-muted">You&apos;ll be asked for a reason.</span>
          </div>
        )
      ) : (
        <p className="text-sm text-text">Open the existing client instead, or correct the PAN or GSTIN if it was mistyped.</p>
      )}
    </div>
  )
}

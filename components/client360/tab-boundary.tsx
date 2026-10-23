"use client"

import { catchError, type ErrorInfo } from "next/error"
import { ErrorBlock } from "@/components/app/error-block"
import { errorDigest } from "@/components/shell/route-error"

/**
 * The error boundary around each Client 360 tab (§0.1 rule 3: one failing block never blanks the
 * page). It catches anything a tab throws while rendering, on the server or the client, and shows
 * the failure inside the tab's frame with the Ref (Next's digest, which matches the server log) and
 * Retry, which re-fetches the tab. The header and the tab row stay usable. Redirect and not-found
 * signals pass through (catchError handles them).
 */
function TabFallback(props: { label: string }, { error, retry }: ErrorInfo) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`The ${props.label} tab didn't load.`} errorRef={errorDigest(error)} onRetry={() => retry()} />
    </div>
  )
}

export const TabBoundary = catchError(TabFallback)

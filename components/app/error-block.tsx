"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CircleAlertIcon, RotateCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { CopyButton } from "@/components/app/copy-button"

/**
 * A block that failed to load (DESIGN.md §3): shown inside the block's own frame, never as a
 * full-screen banner. One sentence, the Ref to quote, and Retry. Retry re-renders the page on the
 * server unless `onRetry` is given.
 *
 *   <ErrorBlock message="Couldn't load this week's filings." errorRef={ref} />
 *   <ErrorBlock message="Couldn't load the revenue chart." errorRef={ref} lastGood="Last updated 09:14." onRetry={reload} />
 */
export function ErrorBlock({
  message,
  errorRef,
  lastGood,
  onRetry,
  announce = false,
  size = "default",
  className,
}: {
  /** One sentence: what failed. */
  message: React.ReactNode
  /** The Ref from the failed call (ActionFailure.ref or the logged error). */
  errorRef?: string | null
  /** When the data was last good, if known: "Last updated 09:14." */
  lastGood?: React.ReactNode
  onRetry?: () => void | Promise<void>
  /** Announce to screen readers (use when the error appears after an action, not on page load). */
  announce?: boolean
  size?: "default" | "compact"
  className?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()

  const retry = () => {
    startTransition(async () => {
      if (onRetry) await onRetry()
      else router.refresh()
    })
  }

  return (
    <div
      role={announce ? "alert" : undefined}
      data-slot="error-block"
      className={cn(
        "gap-3 text-base",
        // Phones: the icon stays beside the sentence and Retry drops under the text, aligned with it.
        size === "compact"
          ? "flex items-center px-3 py-2"
          : "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-y-2 px-4 py-6 sm:grid-cols-[auto_minmax(0,1fr)_auto]",
        className
      )}
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
      <div className="min-w-0 flex-1">
        <p className="text-text">
          {message}
          {lastGood ? <span className="text-text-muted"> {lastGood}</span> : null}
        </p>
        {errorRef ? (
          <p className="mt-1 flex items-center gap-1 text-sm text-text-muted">
            Ref <span className="font-mono text-[13px] text-text">{errorRef}</span>
            <CopyButton value={errorRef} label="Ref" />
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={retry}
        disabled={pending}
        className={cn(
          "inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary transition-colors duration-150 hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-70 pointer-coarse:min-h-11",
          size !== "compact" && "col-start-2 -ml-2 justify-self-start sm:col-start-3 sm:ml-0"
        )}
      >
        <RotateCwIcon aria-hidden="true" className={cn("size-3.5", pending && "animate-spin")} />
        {pending ? "Retrying…" : "Retry"}
      </button>
    </div>
  )
}

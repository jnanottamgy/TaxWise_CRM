"use client"

import * as React from "react"
import type { CalendarInputs, PreviewEvent } from "@/lib/schemas/onboarding"
import { previewOnboardingDeadlines } from "@/server/actions/clients"

export type PreviewState = {
  status: "idle" | "loading" | "ready" | "error"
  /** The last good result (kept on screen while a new one loads). */
  events: PreviewEvent[] | null
  nextDue: Record<string, string>
  error: { message: string; ref?: string } | null
  retry: () => void
}

type Result = { key: string; events: PreviewEvent[]; nextDue: Record<string, string> }
type Failure = { key: string; message: string; ref?: string }

/**
 * The deadlines the statutory engine would create (§7.3.2 steps 3 and 5), fetched from the server
 * (the rules are data, §5.12) when the inputs that drive them change, debounced. Keeps the last good
 * result on screen while a new one loads.
 */
export function useDeadlinePreview(inputs: CalendarInputs, enabled: boolean): PreviewState {
  const json = JSON.stringify(inputs)
  const [nonce, setNonce] = React.useState(0)
  const key = `${json}#${nonce}`
  const [result, setResult] = React.useState<Result | null>(null)
  const [failure, setFailure] = React.useState<Failure | null>(null)

  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await previewOnboardingDeadlines(JSON.parse(json) as CalendarInputs)
        if (cancelled) return
        if (!r.ok) setFailure({ key, message: r.error, ref: r.ref })
        else setResult({ key, events: r.data.events, nextDue: r.data.nextDue })
      } catch {
        if (!cancelled) setFailure({ key, message: "Couldn't reach the server to work out the deadlines." })
      }
    }, 450)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [json, key, enabled])

  const status: PreviewState["status"] =
    result?.key === key ? "ready" : failure?.key === key ? "error" : enabled ? "loading" : result ? "ready" : "idle"
  return {
    status,
    events: result?.events ?? null,
    nextDue: result?.nextDue ?? {},
    error: status === "error" && failure ? { message: failure.message, ref: failure.ref } : null,
    retry: () => setNonce((n) => n + 1),
  }
}

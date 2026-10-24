"use client"

import * as React from "react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { ROLE_LABEL, type AppRole } from "@/lib/auth/roles"
import { CREDENTIAL_ACTION_LABEL } from "@/lib/schemas/registers"
import { loadCredentialTrail } from "@/server/actions/credentials"
import type { TrailRow } from "@/lib/data/registers"

/**
 * The access trail of one stored login (§7.15.1 "Access trail per credential"; §18.3 Partner 8): who
 * revealed, copied, stored or changed it, when, and from which IP. Partners and Managers.
 */
export function CredentialTrailSheet({ open, onOpenChange, credentialId, title }: { open: boolean; onOpenChange: (open: boolean) => void; credentialId: string; title: string }) {
  const [state, setState] = React.useState<{ rows: TrailRow[] } | { error: string; ref?: string } | null>(null)
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!open) return
    let live = true
    loadCredentialTrail({ id: credentialId })
      .then((r) => {
        if (live) setState(r.ok ? { rows: r.data } : { error: r.error, ref: r.ref })
      })
      .catch(() => {
        if (live) setState({ error: "We couldn't reach the server. Check your connection and try again." })
      })
    return () => {
      live = false
    }
  }, [open, credentialId, attempt])

  const load = () => {
    setState(null)
    setAttempt((n) => n + 1)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>Access trail</SheetTitle>
          <SheetDescription>{title}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state === null ? (
            <ul aria-busy="true" className="px-5">
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="flex h-14 items-center justify-between gap-4 border-b border-border/70">
                  <div className="flex w-[60%] flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-[70%]" />
                    <Skeleton className="h-3 w-[45%]" />
                  </div>
                  <Skeleton className="h-3.5 w-24" />
                </li>
              ))}
            </ul>
          ) : "error" in state ? (
            <ErrorBlock message={state.error} errorRef={state.ref} onRetry={load} />
          ) : state.rows.length === 0 ? (
            <EmptyState message="Nobody has viewed or changed this login yet." />
          ) : (
            <ul className="px-5">
              {state.rows.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-4 border-b border-border/70 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <p className="text-base text-text">{CREDENTIAL_ACTION_LABEL[r.action] ?? r.action}</p>
                    <p className="text-sm text-text-muted">
                      {r.user_name ?? "Someone no longer on the team"}
                      {r.user_role ? ` · ${ROLE_LABEL[r.user_role as AppRole] ?? r.user_role}` : ""}
                      {r.ip ? ` · IP ${r.ip}` : ""}
                    </p>
                  </div>
                  <DateText date={r.created_at} withTime className="flex-none text-right text-sm text-text-muted" />
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

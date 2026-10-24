"use client"

import * as React from "react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { StatusChip } from "@/components/app/status-chip"
import { CopyButton } from "@/components/app/copy-button"
import { formatDateTime } from "@/lib/format"
import { auditDetailsView, auditEventLabel, auditValueText, humanise, roleLabel } from "@/components/audit-log/audit-format"

export type AuditEntryView = {
  id: string
  at: string
  event: string
  userId: string | null
  userEmail: string | null
  userRole: string | null
  userName: string | null
  ip: string | null
  userAgent: string | null
  resourceType: string | null
  resourceId: string | null
  action: string | null
  success: boolean
  error: string | null
  details: unknown
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2 text-base">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  )
}

function Value({ v }: { v: unknown }) {
  const text = auditValueText(v)
  if (text === "—") return <span className="text-text-muted">—</span>
  if (typeof v === "object" && v !== null) return <pre className="max-h-48 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">{text}</pre>
  return <span className="break-words">{text}</span>
}

/**
 * One audit entry in full (§7.20 "detail drawer with before/after"): who, when (IST), what, the
 * record it touched, where from, and the change itself: each field's value before and after, then
 * anything else the entry recorded. Read-only; the log can't be edited (§0.1 rule 12).
 */
export function AuditEntrySheet({ entry, onClose }: { entry: AuditEntryView | null; onClose: () => void }) {
  const view = React.useMemo(() => auditDetailsView(entry?.details ?? null), [entry])
  return (
    <Sheet open={!!entry} onOpenChange={(o) => (o ? null : onClose())}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {entry ? (
          <>
            <SheetHeader className="border-b border-border px-5 py-4">
              <SheetTitle className="flex flex-wrap items-center gap-2 pr-8 text-md font-semibold">
                {auditEventLabel(entry.event)}
                {entry.success ? null : <StatusChip label="Failed" tone="danger" meaning="The action was refused or didn't complete. The reason is below." />}
              </SheetTitle>
              <SheetDescription className="num">{formatDateTime(entry.at)} IST</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              <dl className="divide-y divide-border/70">
                <Fact label="Who">
                  {entry.userId ? (
                    <span className="flex flex-col">
                      <span>{entry.userName ?? entry.userEmail ?? "Someone whose account was removed"}</span>
                      <span className="text-sm text-text-muted">{[entry.userName ? entry.userEmail : null, roleLabel(entry.userRole)].filter(Boolean).join(" · ")}</span>
                    </span>
                  ) : (
                    <span>The system (a scheduled job, a webhook or the public quotation page)</span>
                  )}
                </Fact>
                <Fact label="Record">
                  {entry.resourceType ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>{humanise(entry.resourceType)}</span>
                      {entry.resourceId ? (
                        <>
                          <span className="font-mono text-sm text-text-muted">{entry.resourceId}</span>
                          <CopyButton value={entry.resourceId} label="record id" />
                        </>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </Fact>
                <Fact label="Action">{entry.action ? <span className="font-mono text-sm">{entry.action}</span> : <span className="text-text-muted">—</span>}</Fact>
                {entry.error ? <Fact label="Reason">{entry.error}</Fact> : null}
                <Fact label="From">
                  <span className="flex flex-col">
                    <span className="num">{entry.ip ?? "—"}</span>
                    {entry.userAgent ? <span className="text-sm break-words text-text-muted">{entry.userAgent}</span> : null}
                  </span>
                </Fact>
                <Fact label="Entry">
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-sm text-text-muted">{entry.id}</span>
                    <CopyButton value={entry.id} label="entry id" />
                  </span>
                </Fact>
              </dl>

              <h3 className="mt-5 text-base font-semibold text-text">Before and after</h3>
              {view.changes.length ? (
                <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full border-separate border-spacing-0 text-base">
                    <caption className="sr-only">The values before and after the change</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="h-9 bg-surface-2 px-3 text-left text-xs font-medium text-text-muted">Field</th>
                        <th scope="col" className="h-9 bg-surface-2 px-3 text-left text-xs font-medium text-text-muted">Before</th>
                        <th scope="col" className="h-9 bg-surface-2 px-3 text-left text-xs font-medium text-text-muted">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.changes.map((c, i) => (
                        <tr key={`${c.field}-${i}`} className="align-top">
                          <th scope="row" className="border-t border-border/70 px-3 py-2 text-left text-sm font-medium text-text">{c.field}</th>
                          <td className="border-t border-border/70 px-3 py-2 text-sm text-text-muted"><Value v={c.before} /></td>
                          <td className="border-t border-border/70 px-3 py-2 text-sm text-text"><Value v={c.after} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-2 text-sm text-text-muted">This entry records an event, not a change to a value.</p>
              )}

              {view.other.length ? (
                <>
                  <h3 className="mt-5 text-base font-semibold text-text">Recorded with it</h3>
                  <dl className="mt-1 divide-y divide-border/70">
                    {view.other.map((o) => (
                      <Fact key={o.label} label={o.label}>
                        <Value v={o.value} />
                      </Fact>
                    ))}
                  </dl>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

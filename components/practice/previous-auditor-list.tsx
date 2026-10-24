"use client"

import * as React from "react"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { SENT_VIA_LABELS, type SentVia } from "@/lib/schemas/audits"
import { auditTypeLabel } from "@/components/audits/audit-ui"
import { PreviousAuditorDialog } from "@/components/audits/previous-auditor-dialog"
import { proofChip, replyCell } from "@/components/quality/previous-auditors"
import type { PreviousAuditorRow } from "@/lib/data/audits"

/**
 * A client's letters to previous auditors (Clause 8, §6.8), for Client 360 → Engagement: each with
 * the audit, when and how it went, the proof of delivery and the reply; a row opens it to edit, and
 * "Record a letter" adds one for this client.
 */
export function ClientPreviousAuditors({ client, rows, today }: { client: { id: string; label: string }; rows: PreviousAuditorRow[]; today: string }) {
  const [open, setOpen] = React.useState<PreviousAuditorRow | "new" | null>(null)
  return (
    <section aria-labelledby="client-pac-title" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="client-pac-title" className="text-md leading-6 font-semibold text-text">
            Previous auditor
          </h2>
          <p className="text-sm text-text-muted">Clause 8: the letter to the outgoing auditor, with proof of delivery, before accepting an audit.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setOpen("new")}>
          <PlusIcon aria-hidden="true" />
          Record a letter
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState size="compact" message="No letters to a previous auditor. Record one when another CA audited this client before." className="m-3" />
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {rows.map((r) => (
            // The row opens the letter through its name button, whose hit area covers the whole row
            // (after:inset-0). The status chips are buttons of their own (hover/tap explains them), so
            // they sit above that area instead of inside it: a button inside a button is invalid HTML
            // and broke hydration of the whole tab.
            <li key={r.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-surface-2">
              <span className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  className="block max-w-full cursor-pointer truncate text-left text-base text-text outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                >
                  {r.previous_auditor_name}
                </button>
                <span className="block text-xs text-text-muted">
                  {auditTypeLabel(r.engagement_type)}
                  {r.sent_via ? ` · ${SENT_VIA_LABELS[r.sent_via as SentVia] ?? r.sent_via}` : ""}
                </span>
              </span>
              <span className="relative z-10 inline-flex">{proofChip(Boolean(r.delivery_proof_document_id))}</span>
              <span className="relative z-10 inline-flex text-sm">{replyCell(r)}</span>
              <span className="num w-28 text-right text-sm text-text-muted">
                <DateText date={r.letter_sent_on} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {open ? <PreviousAuditorDialog onClose={() => setOpen(null)} client={client} record={open === "new" ? null : open} today={today} /> : null}
    </section>
  )
}

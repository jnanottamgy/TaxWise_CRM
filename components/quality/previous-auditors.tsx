"use client"

import * as React from "react"
import { MailIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { EMPTY } from "@/lib/format"
import { PREVIOUS_AUDITOR_OUTCOME_LABELS, SENT_VIA_LABELS, type PreviousAuditorOutcome, type SentVia } from "@/lib/schemas/audits"
import { auditTypeLabel } from "@/components/audits/audit-ui"
import { PreviousAuditorDialog, type PreviousAuditorRecord } from "@/components/audits/previous-auditor-dialog"
import type { PreviousAuditorListRow } from "@/lib/data/quality"

export function proofChip(hasProof: boolean) {
  return hasProof ? (
    <StatusChip label="Proof filed" tone="success" meaning="Proof of delivery is on file: the letter counts for the Acceptance gate (Clause 8)." />
  ) : (
    <StatusChip label="No proof yet" tone="danger" meaning="Without proof of delivery the audit can't move past Acceptance (Clause 8). Upload the AD card or the email acknowledgement." />
  )
}

export function replyCell(r: { reply_received_on: string | null; outcome: string | null }) {
  if (r.outcome) {
    const label = PREVIOUS_AUDITOR_OUTCOME_LABELS[r.outcome as PreviousAuditorOutcome] ?? r.outcome
    return <StatusChip label={label} tone={r.outcome === "objection_unresolved" ? "danger" : r.outcome === "objection_resolved" ? "warning" : "success"} />
  }
  return r.reply_received_on ? <span className="text-text">Reply received</span> : <span className="text-text-muted">Awaiting reply</span>
}

/**
 * Previous-auditor communications, firm-wide (§7.15.4, §6.8 Clause 8): each letter with the client,
 * the audit, how and when it went, whether the proof of delivery is on file, and the reply. A row
 * opens the letter to edit it; Partners and Managers record them (RLS 0033).
 */
export function PreviousAuditorsTable(props: { rows: PreviousAuditorListRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string; canEdit: boolean }) {
  const { rows, total, page, pageSize, sort, dir, today, canEdit } = props
  const [open, setOpen] = React.useState<PreviousAuditorListRow | "new" | null>(null)
  const columns = React.useMemo<DataTableColumn<PreviousAuditorListRow>[]>(
    () => [
      {
        id: "client",
        header: "Client",
        hideable: false,
        mobile: "primary",
        width: "24%",
        cell: (r) => (
          <button type="button" className="inline-flex min-w-0 cursor-pointer flex-col text-left leading-5 hover:underline" onClick={() => canEdit && setOpen(r)} disabled={!canEdit}>
            <span className="truncate text-text">{r.client_name}</span>
            <span className="text-xs text-text-muted">
              {r.client_code} · {auditTypeLabel(r.engagement_type)}
            </span>
          </button>
        ),
        mobileCell: (r) => r.client_name,
      },
      {
        id: "previous_auditor_name",
        header: "Previous auditor",
        sortable: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span>{r.previous_auditor_name}</span>
            {r.previous_auditor_frn ? <span className="text-xs text-text-muted">{r.previous_auditor_frn}</span> : null}
          </span>
        ),
        mobileCell: (r) => r.previous_auditor_name,
      },
      {
        id: "letter_sent_on",
        header: "Sent",
        sortable: true,
        align: "right",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <DateText date={r.letter_sent_on} />
            {r.sent_via ? <span className="text-xs text-text-muted">{SENT_VIA_LABELS[r.sent_via as SentVia] ?? r.sent_via}</span> : null}
          </span>
        ),
      },
      { id: "proof", header: "Proof of delivery", mobile: "trailing", cell: (r) => proofChip(Boolean(r.delivery_proof_document_id)) },
      { id: "reply", header: "Reply", hideBelow: "lg", cell: (r) => replyCell(r) },
      { id: "reply_received_on", header: "Reply on", align: "right", hideBelow: "xl", cell: (r) => (r.reply_received_on ? <DateText date={r.reply_received_on} /> : <span className="text-text-muted">{EMPTY}</span>) },
    ],
    [canEdit]
  )
  const record = open && open !== "new" ? toRecord(open) : null
  return (
    <>
      <DataTable
        id="previous-auditors"
        caption="Letters to previous auditors"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "letter_sent_on", dir: "desc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "letter" : "letters"}`}
        toolbar={
          canEdit ? (
            <Button type="button" size="sm" onClick={() => setOpen("new")}>
              <PlusIcon aria-hidden="true" />
              Record a letter
            </Button>
          ) : undefined
        }
        empty={
          <EmptyState
            icon={<MailIcon />}
            message="No letters to previous auditors yet. Record one before accepting an audit where another CA held the position."
            action={
              canEdit ? (
                <Button type="button" onClick={() => setOpen("new")}>
                  <PlusIcon aria-hidden="true" />
                  Record a letter
                </Button>
              ) : undefined
            }
          />
        }
      />
      {open ? <PreviousAuditorDialog onClose={() => setOpen(null)} client={record ? { id: record.client_id, label: open !== "new" ? `${open.client_name} (${open.client_code})` : "" } : null} record={record} today={today} /> : null}
    </>
  )
}

function toRecord(r: PreviousAuditorListRow): PreviousAuditorRecord {
  return {
    id: r.id,
    updated_at: r.updated_at,
    client_id: r.client_id,
    audit_engagement_id: r.audit_engagement_id,
    engagement_type: r.engagement_type,
    previous_auditor_name: r.previous_auditor_name,
    previous_auditor_frn: r.previous_auditor_frn,
    letter_sent_on: r.letter_sent_on,
    sent_via: r.sent_via,
    delivery_proof_document_id: r.delivery_proof_document_id,
    reply_received_on: r.reply_received_on,
    objections: r.objections,
    outcome: r.outcome,
    notes: r.notes,
  }
}

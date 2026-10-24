"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RepeatIcon, SendIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Button } from "@/components/ui/button"
import { SERVICE_FREQUENCY_LABELS } from "@/lib/domain/enums"
import { serviceLabel } from "@/lib/domain/realisation"
import type { RetainerQueueRow } from "@/lib/data/collections"
import type { RetainerQueueState } from "@/lib/schemas/collections"
import { submitDraftsForApproval } from "@/server/actions/retainer"
import { RetainerIssueDialog } from "@/components/collections/retainer-issue-dialog"

/**
 * The Retainer drafts queue (§7.9.6): each draft the daily run made, with its client, engagement,
 * period, amount and where it stands. Select drafts to issue them, or (a Manager, for drafts over
 * the approval limit) send them to the Partners for approval. Server-paged and sorted; a row opens
 * the draft. Below 768px each row is a card: client, amount, period, status.
 */

const isHeld = (r: RetainerQueueRow) => r.requires_approval && !r.approved_at && (r.status === "draft" || r.status === "awaiting_approval")

function QueueStatus({ r }: { r: RetainerQueueRow }) {
  if (r.status === "draft" && isHeld(r)) {
    return <StatusChip label="Held for a Partner" tone="violet" meaning="Over the invoice approval limit: a Partner issues it, or a Manager sends it for approval first." />
  }
  if (r.status === "draft") return <StatusChip label="Ready to issue" tone="info" meaning="Ready to issue: check it, then issue it. Nothing has been sent to the client." />
  return <StatusChip kind="invoice_status" value={r.status} />
}

export function RetainerTable(props: {
  rows: RetainerQueueRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  state: RetainerQueueState
  role: "partner" | "manager"
  runId: string | null
}) {
  const { rows, total, page, pageSize, sort, dir, today, state, role } = props
  const router = useRouter()
  const [issueIds, setIssueIds] = React.useState<string[] | null>(null)
  const [submitRows, setSubmitRows] = React.useState<RetainerQueueRow[] | null>(null)

  const columns = React.useMemo<DataTableColumn<RetainerQueueRow>[]>(
    () => [
      {
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        rowLink: true,
        width: "26%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      },
      {
        id: "engagement",
        header: "Engagement",
        mobile: "secondary",
        cell: (r) =>
          r.service_type ? (
            <span className="inline-flex flex-col leading-5">
              <span>{serviceLabel(r.service_type, r.custom_name)}</span>
              <span className="text-xs text-text-muted">{SERVICE_FREQUENCY_LABELS[r.billing_frequency ?? r.frequency ?? "monthly"]}</span>
            </span>
          ) : (
            <span className="text-text-muted">Engagement removed</span>
          ),
        mobileCell: (r) => (r.service_type ? serviceLabel(r.service_type, r.custom_name) : "Engagement removed"),
      },
      { id: "period", header: "Period", sortable: true, mobile: "secondary", cell: (r) => <span className="whitespace-nowrap">{r.period_label}</span> },
      { id: "billing_date", header: "Billing date", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <DateText date={r.billing_date} /> },
      { id: "taxable_amount", header: "Fee", align: "right", hideBelow: "xl", cell: (r) => <Money value={r.taxable_amount} /> },
      { id: "gst_amount", header: "GST", align: "right", hideBelow: "2xl", cell: (r) => <Money value={r.gst_amount} /> },
      { id: "total_amount", header: "Total", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.total_amount} /> },
      {
        id: "status",
        header: "Status",
        mobile: "trailing",
        cell: (r) => (
          <span className="inline-flex flex-col items-start gap-0.5 leading-5">
            <QueueStatus r={r} />
            {r.invoice_number ? <MonoId value={r.invoice_number} /> : null}
          </span>
        ),
      },
      { id: "run_date", header: "Drafted", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <DateText date={r.run_date} today={today} /> },
    ],
    [today],
  )

  const selectable = state !== "issued"
  const issuableFor = (sel: RetainerQueueRow[]) => sel.filter((r) => r.status === "draft" && (role === "partner" || !isHeld(r)))
  const heldFor = (sel: RetainerQueueRow[]) => sel.filter((r) => r.status === "draft" && isHeld(r))

  return (
    <>
      <DataTable
        id="retainer-drafts"
        caption="Retainer drafts"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.invoice_id}
        getRowHref={(r) => `/invoices/${r.invoice_id}`}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "billing_date", dir: "asc" }}
        selectable={selectable}
        columnChooser
        countLabel={(n, t) => `${n} ${t === 1 ? "draft" : "drafts"}`}
        bulkActions={({ selectedRows, clear }) => {
          const issuable = issuableFor(selectedRows)
          const held = heldFor(selectedRows)
          return (
            <>
              <Button size="sm" disabled={issuable.length === 0} onClick={() => setIssueIds(issuable.map((r) => r.invoice_id))} title={issuable.length === 0 ? "None of these can be issued by you" : undefined}>
                <SendIcon aria-hidden="true" />
                Issue {issuable.length || ""}
              </Button>
              {role === "manager" && held.length ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSubmitRows(held)
                    clear()
                  }}
                >
                  Send {held.length} for approval
                </Button>
              ) : null}
            </>
          )
        }}
        empty={
          <EmptyState
            icon={<RepeatIcon />}
            message={
              state === "issued"
                ? "No retainer invoice has been issued from this queue yet."
                : "No retainer drafts are waiting. The daily run at 09:30 drafts invoices for engagements set to invoice automatically."
            }
          />
        }
      />
      {issueIds ? (
        <RetainerIssueDialog
          open
          onOpenChange={(o) => {
            if (!o) setIssueIds(null)
          }}
          invoiceIds={issueIds}
          role={role}
        />
      ) : null}
      <ConfirmDialog
        open={submitRows !== null}
        onOpenChange={(o) => (!o ? setSubmitRows(null) : undefined)}
        title={submitRows?.length === 1 ? "Send this draft to the Partners for approval?" : `Send ${submitRows?.length ?? 0} drafts to the Partners for approval?`}
        description="They are over the invoice approval limit, so a Partner approves them before they can be issued. The Partners are told now."
        confirmLabel="Send for approval"
        onConfirm={async () => {
          if (!submitRows) return
          const r = await submitDraftsForApproval({ items: submitRows.map((x) => ({ invoiceId: x.invoice_id, updatedAt: x.invoice_updated_at })) })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success(r.data.changed ? `${r.data.submitted} sent for approval; ${r.data.changed} had changed and were left.` : `${r.data.submitted} sent for approval.`)
          router.refresh()
        }}
      />
    </>
  )
}

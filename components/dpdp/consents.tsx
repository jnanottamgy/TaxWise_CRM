"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileLockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { EMPTY, formatDateTime } from "@/lib/format"
import { CONSENT_SUBJECT_LABELS, ConsentWithdrawSchema } from "@/lib/schemas/dpdp"
import { withdrawConsent } from "@/server/actions/privacy-notices"
import { NoteDialog } from "@/components/audits/audit-dialogs"
import type { ConsentRow } from "@/lib/data/dpdp"

/**
 * Consent records (§6.10): every acknowledgement of a privacy notice: who (a portal user, a client's
 * contact, a member of staff, a lead), which version, for what purposes, when and how, and whether it
 * has been withdrawn. A Partner records a withdrawal a person asks for (DPDP Act s.6(4)).
 */
export function ConsentsTable(props: { rows: ConsentRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; canEdit: boolean }) {
  const { rows, total, page, pageSize, sort, dir, canEdit } = props
  const router = useRouter()
  const [withdrawing, setWithdrawing] = React.useState<ConsentRow | null>(null)
  const columns = React.useMemo<DataTableColumn<ConsentRow>[]>(
    () => [
      {
        id: "subject",
        header: "Person",
        hideable: false,
        mobile: "primary",
        width: "26%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5">
            <span className="truncate">{r.subject_name ?? <span className="text-text-muted">No longer on record</span>}</span>
            <span className="text-xs text-text-muted">{CONSENT_SUBJECT_LABELS[r.subject_type] ?? r.subject_type}</span>
          </span>
        ),
        mobileCell: (r) => r.subject_name ?? CONSENT_SUBJECT_LABELS[r.subject_type] ?? r.subject_type,
      },
      { id: "notice_version", header: "Notice", sortable: true, mobile: "secondary", cell: (r) => (r.notice_version ? <span className="num">{r.notice_version}</span> : <span className="text-text-muted">{EMPTY}</span>) },
      { id: "purposes", header: "Purposes", hideBelow: "lg", cell: (r) => (r.purposes.length ? <span className="text-sm">{r.purposes.join(", ")}</span> : <span className="text-text-muted">{EMPTY}</span>) },
      {
        id: "given_at",
        header: "Given",
        sortable: true,
        align: "right",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <DateText date={r.given_at} />
            <span className="text-xs text-text-muted">{[r.channel, r.ip].filter(Boolean).join(" · ") || EMPTY}</span>
          </span>
        ),
      },
      {
        id: "withdrawn_at",
        header: "State",
        sortable: true,
        mobile: "trailing",
        cell: (r) =>
          r.withdrawn_at ? (
            <StatusChip label="Withdrawn" tone="muted" meaning={`Withdrawn ${formatDateTime(r.withdrawn_at)}. Processing on this consent stops; records the law requires are kept.`} />
          ) : (
            <StatusChip label="Given" tone="success" meaning="The person acknowledged this version of the notice." />
          ),
      },
      ...(canEdit
        ? [
            {
              id: "actions",
              header: "Action",
              hideable: false,
              cell: (r: ConsentRow) =>
                r.withdrawn_at ? null : (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setWithdrawing(r)}>
                    Record withdrawal
                  </Button>
                ),
            } satisfies DataTableColumn<ConsentRow>,
          ]
        : []),
    ],
    [canEdit]
  )
  return (
    <>
      <DataTable
        id="consents"
        caption="Consent records"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "given_at", dir: "desc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "record" : "records"}`}
        rowClassName={(r) => (r.withdrawn_at ? "text-text-muted" : undefined)}
        empty={<EmptyState icon={<FileLockIcon />} message="No acknowledgements yet. Portal users acknowledge the current privacy notice when they first sign in." />}
      />
      {withdrawing ? (
        <NoteDialog
          onClose={() => setWithdrawing(null)}
          title="Record the withdrawal?"
          description={`${withdrawing.subject_name ?? "This person"} withdraws the consent given to notice ${withdrawing.notice_version ?? ""}. Processing that rests on it stops; what the law requires the firm to keep stays.`}
          label="How they asked"
          required={false}
          submitLabel="Record withdrawal"
          schema={ConsentWithdrawSchema}
          action={withdrawConsent}
          values={{ id: withdrawing.id }}
          successMessage="Withdrawal recorded"
          onDone={() => router.refresh()}
        />
      ) : null}
    </>
  )
}

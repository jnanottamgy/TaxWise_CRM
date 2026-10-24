"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { DownloadIcon, IdCardIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { EMPTY } from "@/lib/format"
import { ENTITY_TYPE_LABELS, type EntityType } from "@/lib/domain/enums"
import { KYC_STATE_INFO, type KycState } from "@/lib/schemas/quality"
import { exportKycRegister, reconfirmKyc } from "@/server/actions/kyc-register"
import { downloadBase64, toastResult } from "@/components/quality/feedback"
import type { KycRegisterRow } from "@/lib/data/quality"

function Reconfirm({ row }: { row: KycRegisterRow }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  if (!row.client_id || !row.kyc_updated_at) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={async (e) => {
        e.stopPropagation()
        setPending(true)
        try {
          const r = await reconfirmKyc({ clientId: row.client_id!, kycUpdatedAt: row.kyc_updated_at! })
          if (toastResult(r, "KYC re-confirmed for the year")) router.refresh()
        } finally {
          setPending(false)
        }
      }}
    >
      {pending ? <Spinner /> : null}
      Re-confirm
    </Button>
  )
}

export function KycExportButton() {
  const sp = useSearchParams()
  const [pending, setPending] = React.useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      aria-busy={pending}
      onClick={async () => {
        setPending(true)
        try {
          const params = new URLSearchParams(sp?.toString() ?? "")
          params.delete("tab")
          const r = await exportKycRegister({ query: params.toString() })
          if (toastResult(r)) {
            downloadBase64(r.data)
            if (r.data.truncated) toast(`The first ${r.data.rows} rows were exported. Narrow the filters for the rest.`)
          }
        } finally {
          setPending(false)
        }
      }}
    >
      {pending ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
      <span className="max-sm:sr-only">Export CSV</span>
    </Button>
  )
}


/**
 * KYC status by client (§7.15.4, §6.8 ICAI KYC Norms): every attest client (an audit service, an
 * audit engagement or a KYC record) with its state, what is missing for its category, when it was
 * verified and when it is re-confirmed. A complete KYC whose year is up is re-confirmed here; the
 * KYC itself is edited on the client's Profile tab. Partners and Managers (RLS 0033).
 */
export function KycRegisterTable(props: { rows: KycRegisterRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string; canReconfirm: boolean }) {
  const { rows, total, page, pageSize, sort, dir, today, canReconfirm } = props
  const columns = React.useMemo<DataTableColumn<KycRegisterRow>[]>(
    () => [
      {
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "28%",
        rowLink: true,
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5">
            <span className="truncate">{r.client_name ?? EMPTY}</span>
            <span className="text-xs text-text-muted">
              {r.client_code}
              {r.entity_type && r.entity_type in ENTITY_TYPE_LABELS ? ` · ${ENTITY_TYPE_LABELS[r.entity_type as EntityType]}` : ""}
            </span>
          </span>
        ),
        mobileCell: (r) => r.client_name ?? EMPTY,
      },
      {
        id: "kyc_state",
        header: "KYC",
        sortable: true,
        mobile: "trailing",
        cell: (r) => {
          const info = KYC_STATE_INFO[(r.kyc_state ?? "missing") as KycState]
          return <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
        },
      },
      {
        id: "missing",
        header: "Missing",
        mobile: "secondary",
        cell: (r) => (r.missing?.length ? <span className="text-sm text-text">{r.missing.join(", ")}</span> : <span className="text-text-muted">Nothing</span>),
        mobileCell: (r) => (r.missing?.length ? `Missing ${r.missing.join(", ")}` : "Complete"),
      },
      { id: "verified_on", header: "Verified", sortable: true, align: "right", hideBelow: "lg", cell: (r) => (r.verified_on ? <DateText date={r.verified_on} /> : <span className="text-text-muted">{EMPTY}</span>) },
      {
        id: "next_review_on",
        header: "Re-confirm by",
        sortable: true,
        align: "right",
        cell: (r) => (r.next_review_on ? <DateText date={r.next_review_on} withRelative stacked today={today} /> : <span className="text-text-muted">{EMPTY}</span>),
      },
      { id: "open_audits", header: "Open audits", align: "right", hideBelow: "xl", cell: (r) => <span className="num">{r.open_audits ?? 0}</span> },
      {
        id: "actions",
        header: "Action",
        hideable: false,
        cell: (r) =>
          canReconfirm && r.complete && r.kyc_state === "review_due" ? (
            <Reconfirm row={r} />
          ) : r.client_id ? (
            <Link href={`/clients/${r.client_id}?tab=profile`} className="text-sm font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.kyc_state === "current" ? "View" : "Complete it"}
            </Link>
          ) : null,
      },
    ],
    [today, canReconfirm]
  )
  return (
    <DataTable
      id="kyc-register"
      caption="KYC status by client"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.client_id ?? ""}
      getRowHref={(r) => (r.client_id ? `/clients/${r.client_id}?tab=profile` : null)}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "client_name", dir: "asc" }}
      countLabel={(n, t) => `${n} attest ${t === 1 ? "client" : "clients"}`}
      empty={<EmptyState icon={<IdCardIcon />} message="No attest clients yet. A client appears here once it has an audit service, an audit engagement or a KYC record." />}
    />
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { FileSignatureIcon, PlusIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { Button } from "@/components/ui/button"
import { EMPTY } from "@/lib/format"
import { istDateOf } from "@/lib/domain/fy"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { LETTER_AUDIT_TYPE_LABEL, LETTER_EXPIRY_WINDOW_DAYS, type LetterAuditType } from "@/lib/schemas/engagement-letters"
import type { LetterRow } from "@/lib/data/engagement-letters"
import { RenewButton } from "@/components/engagement-letters/renew-button"

export function servicesSummary(r: Pick<LetterRow, "service_types" | "audit_type">): string {
  return r.service_types
    .map((s) => (s === "audit" && r.audit_type ? (LETTER_AUDIT_TYPE_LABEL[r.audit_type as LetterAuditType] ?? SERVICE_TYPE_LABELS.audit) : SERVICE_TYPE_LABELS[s]))
    .join(", ")
}

/** The status with what it is waiting for: "Issued · sent 22 Oct", "Signed · copy in vault". */
export function LetterStatusCell({ r }: { r: LetterRow }) {
  return (
    <span className="inline-flex flex-col items-start leading-5">
      <StatusChip kind="engagement_status" value={r.display_status} />
      {r.display_status === "issued" ? (
        <span className="text-xs text-text-muted">{r.sent_at ? "Sent for signature" : "Not sent yet"}</span>
      ) : r.display_status === "signed" ? (
        <span className={r.document_id ? "text-xs text-text-muted" : "text-xs text-warning-text"}>{r.document_id ? "Signed copy in vault" : "Signed copy not uploaded"}</span>
      ) : r.renewal_id ? (
        <span className="text-xs text-text-muted">Renewed for FY {r.renewal_fy}</span>
      ) : null}
    </span>
  )
}

/**
 * Engagement letters (§7.15.3): client, FY, services, fee agreed (excl. GST), status (Expired is
 * derived from the expiry date), issued, signed, expires (urgent inside 30 days) and the signing
 * Partner; a letter expiring soon and not yet renewed offers Renew for next FY. Partners and
 * Managers only. A row opens the letter.
 */
export function LettersTable(props: {
  rows: LetterRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  today: string
  showClient?: boolean
  /** Expiring view: a Renew column. */
  renewColumn?: boolean
  compact?: boolean
  emptyAction?: { href: string; label: string } | null
  emptyMessage?: string
  id?: string
}) {
  const { rows, today, showClient = true, renewColumn = false, compact = false } = props
  const columns = React.useMemo<DataTableColumn<LetterRow>[]>(() => {
    const cols: DataTableColumn<LetterRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: !compact,
        hideable: false,
        mobile: "primary",
        rowLink: true,
        width: "24%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => `${r.client_name} · FY ${r.financial_year}`,
      })
    }
    cols.push(
      { id: "financial_year", header: "FY", sortable: !compact, hideable: false, rowLink: !showClient, mobile: showClient ? undefined : "primary", cell: (r) => <span className="num font-medium text-text">FY {r.financial_year}</span> },
      { id: "services", header: "Services", mobile: "secondary", cell: (r) => <span className="block max-w-[18rem] truncate text-text-muted" title={servicesSummary(r)}>{servicesSummary(r)}</span> },
      { id: "fee_agreed", header: "Fee (excl. GST)", sortable: !compact, align: "right", hideBelow: "lg", cell: (r) => <Money value={r.fee_agreed} /> },
      { id: "status", header: "Status", mobile: "trailing", cell: (r) => <LetterStatusCell r={r} /> },
      { id: "issued_at", header: "Issued", sortable: !compact, align: "right", hideBelow: "xl", cell: (r) => <DateText date={r.issued_at ? istDateOf(r.issued_at) : null} /> },
      { id: "signed_at", header: "Signed", align: "right", hideBelow: "2xl", cell: (r) => <DateText date={r.signed_at ? istDateOf(r.signed_at) : null} /> },
      {
        id: "expires_at",
        header: "Expires",
        sortable: !compact,
        align: "right",
        mobile: "secondary",
        cell: (r) => (
          <DateText
            date={r.expires_at}
            withRelative={(r.status === "issued" || r.status === "signed") && !r.renewal_id && r.days_to_expiry !== null && r.days_to_expiry <= LETTER_EXPIRY_WINDOW_DAYS}
            stacked
            today={today}
          />
        ),
        mobileCell: (r) => (r.expires_at ? <DateText date={r.expires_at} today={today} /> : "No expiry"),
      },
      { id: "signatory_name", header: "Signing Partner", hideBelow: "2xl", cell: (r) => (r.signatory_name ? <span className="text-text-muted">{r.signatory_name}</span> : <span className="text-text-muted">{EMPTY}</span>) },
    )
    if (renewColumn) {
      cols.push({
        id: "renew",
        header: "Renew",
        align: "right",
        hideable: false,
        mobile: "trailing",
        cell: (r) => (r.renewal_id ? <span className="text-sm text-text-muted">Renewed</span> : <RenewButton letterId={r.id} financialYear={r.financial_year} />),
      })
    }
    return cols
  }, [showClient, renewColumn, compact, today])

  return (
    <DataTable
      id={props.id ?? (showClient ? "engagement-letters" : "client-engagement-letters")}
      caption="Engagement letters"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/engagement-letters/${r.id}`}
      total={props.total}
      page={props.page}
      pageSize={props.pageSize}
      sort={props.sort}
      dir={props.dir}
      defaultSort={{ sort: "updated_at", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "letter" : "letters"}`}
      columnChooser={!compact}
      maxHeight={compact ? "none" : "viewport"}
      rowClassName={(r) => (r.display_status === "declined" || r.display_status === "expired" ? "text-text-muted" : undefined)}
      empty={
        <EmptyState
          icon={<FileSignatureIcon />}
          message={props.emptyMessage ?? "No engagement letters yet. Agree each year's terms in writing before the work starts."}
          action={
            props.emptyAction === null ? undefined : (
              <Button asChild>
                <Link href={props.emptyAction?.href ?? "/engagement-letters/new"}>
                  <PlusIcon aria-hidden="true" />
                  {props.emptyAction?.label ?? "New letter"}
                </Link>
              </Button>
            )
          }
        />
      }
    />
  )
}

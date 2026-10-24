"use client"

import * as React from "react"
import Link from "next/link"
import { CircleCheckIcon, FilePlusIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import type { GapRow } from "@/lib/data/engagement-letters"

const STATUS_WORD: Record<string, string> = { issued: "Issued", signed: "Signed", expired: "Expired" }

/**
 * Clients with active services and no letter Issued or Signed for the FY (§7.15.3 lists): the
 * services, the owner, the last letter on record, any draft in progress, and Draft letter (which
 * opens the form for that client and FY, with the services filled in).
 */
export function GapsTable(props: { rows: GapRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; fy: string }) {
  const { rows, fy } = props
  const columns = React.useMemo<DataTableColumn<GapRow>[]>(
    () => [
      {
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "28%",
        cell: (r) => (
          <Link href={`/clients/${r.client_id}?tab=engagement`} className="inline-flex min-w-0 flex-col leading-5 hover:underline" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </Link>
        ),
        mobileCell: (r) => r.client_name,
      },
      { id: "services", header: "Active services", mobile: "secondary", cell: (r) => <span className="block max-w-[20rem] truncate text-text-muted">{r.service_types.map((s) => SERVICE_TYPE_LABELS[s]).join(", ")}</span> },
      { id: "owner_name", header: "Owner", hideBelow: "lg", cell: (r) => <span className="text-text-muted">{r.owner_name ?? "Not assigned"}</span> },
      {
        id: "last",
        header: "Last letter",
        hideBelow: "lg",
        cell: (r) =>
          r.drafts > 0 ? (
            <span className="text-warning-text">Draft for FY {fy} in progress</span>
          ) : r.last_letter_fy ? (
            <span className="text-text-muted">
              FY {r.last_letter_fy} · {STATUS_WORD[r.last_letter_status ?? ""] ?? r.last_letter_status}
            </span>
          ) : (
            <span className="text-text-muted">None on record</span>
          ),
      },
      {
        id: "action",
        header: "Letter",
        align: "right",
        hideable: false,
        mobile: "trailing",
        cell: (r) => (
          <Button asChild size="sm" variant="outline">
            <Link href={`/engagement-letters/new?client=${r.client_id}&fy=${fy}`}>
              <FilePlusIcon aria-hidden="true" />
              Draft letter
            </Link>
          </Button>
        ),
      },
    ],
    [fy],
  )
  return (
    <DataTable
      id="engagement-letter-gaps"
      caption={`Clients without a letter for FY ${fy}`}
      columns={columns}
      rows={rows}
      getRowId={(r) => r.client_id}
      total={props.total}
      page={props.page}
      pageSize={props.pageSize}
      sort={props.sort}
      dir={props.dir}
      defaultSort={{ sort: "client_name", dir: "asc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "client" : "clients"} without a letter`}
      empty={<EmptyState icon={<CircleCheckIcon />} message={`Every client with active services has a letter issued or signed for FY ${fy}.`} />}
    />
  )
}

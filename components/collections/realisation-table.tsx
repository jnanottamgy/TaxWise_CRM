"use client"

import * as React from "react"
import Link from "next/link"
import { ScaleIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { fromPaise, formatINR } from "@/lib/domain/money"
import { formatPercent } from "@/lib/domain/collections"
import type { LeakageItem, RealisationRow } from "@/lib/domain/realisation"

/**
 * Fee realisation by engagement (§7.9.10): agreed for the FY so far, invoiced (fees, net of credit
 * notes), collected (received + TDS), billing % (invoiced of agreed), realisation % (collected of
 * invoiced) and the ended periods with no invoice. Sorted and paged on the server; a row opens the
 * client's billing.
 */

const pct = (v: number | null, warnBelow: number) =>
  v === null ? (
    <span className="text-text-muted">—</span>
  ) : (
    <span className={v < warnBelow ? "num font-medium text-warning-text tabular-nums" : "num tabular-nums"}>{formatPercent(v)}</span>
  )

export function RealisationTable(props: { rows: RealisationRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; fy: string; filtered: boolean }) {
  const { rows, total, page, pageSize, sort, dir, fy, filtered } = props
  const columns = React.useMemo<DataTableColumn<RealisationRow>[]>(
    () => [
      {
        id: "client",
        header: "Client",
        sortable: true,
        hideable: false,
        rowLink: true,
        mobile: "primary",
        width: "22%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.clientCode} · ${r.clientName}`}>
            <span className="max-w-60 truncate">{r.clientName}</span>
            <span className="text-xs text-text-muted">{r.clientCode}</span>
          </span>
        ),
        mobileCell: (r) => r.clientName,
      },
      {
        id: "service",
        header: "Engagement",
        sortable: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span>{r.serviceLabel}</span>
            <span className="text-xs text-text-muted">{r.engagementId ? `${r.cycleLabel ?? ""}${r.active ? "" : `${r.cycleLabel ? " · " : ""}ended`}` : "Not tied to an engagement"}</span>
          </span>
        ),
        mobileCell: (r) => r.serviceLabel,
      },
      { id: "agreed", header: "Agreed", sortable: true, align: "right", hideBelow: "lg", cell: (r) => (r.agreedPaise ? <Money value={fromPaise(r.agreedPaise)} /> : <span className="text-text-muted">—</span>) },
      { id: "invoiced", header: "Invoiced", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={fromPaise(r.invoicedPaise)} /> },
      { id: "collected", header: "Collected", sortable: true, align: "right", hideBelow: "xl", cell: (r) => <Money value={fromPaise(r.collectedPaise)} /> },
      { id: "billing", header: "Billing %", sortable: true, align: "right", mobile: "trailing", cell: (r) => pct(r.billingPercent, 100) },
      { id: "realisation", header: "Realisation %", sortable: true, align: "right", hideBelow: "lg", cell: (r) => pct(r.realisationPercent, 90) },
      {
        id: "leakage",
        header: "Not invoiced",
        sortable: true,
        align: "right",
        hideBelow: "lg",
        cell: (r) =>
          r.leakagePeriods ? (
            <span className="num font-medium whitespace-nowrap text-warning-text tabular-nums">
              {r.leakagePeriods} {r.leakagePeriods === 1 ? "period" : "periods"}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
      },
    ],
    [],
  )
  return (
    <DataTable
      id="fee-realisation"
      caption={`Fee realisation, FY ${fy}`}
      columns={columns}
      rows={rows}
      getRowId={(r) => r.key}
      getRowHref={(r) => `/clients/${r.clientId}?tab=billing`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "leakage", dir: "desc" }}
      columnChooser
      countLabel={(n, t) => `${n} ${t === 1 ? "row" : "rows"}`}
      empty={
        <EmptyState
          icon={<ScaleIcon />}
          message={filtered ? "Nothing matches. Clear the search or the filter." : `No engagement has an agreed fee and nothing was invoiced in FY ${fy}. Add the agreed fee on a client's services.`}
        />
      }
    />
  )
}

/** Ended periods of recurring engagements with no invoice raised (a draft counts as raised). */
export function LeakageList({ items, today }: { items: LeakageItem[]; today: string }) {
  if (!items.length) {
    return <EmptyState size="compact" message="Every ended period of a recurring engagement has an invoice. Nothing has slipped." />
  }
  // An overview, not the register: the table above counts the periods per engagement and the Excel
  // download lists every one.
  const shown = items.slice(0, 8)
  return (
    <>
      <ul className="flex flex-col divide-y divide-border" aria-label="Periods with no invoice">
        {shown.map((l) => (
          <li key={`${l.engagementId}:${l.periodLabel}`} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-base text-text">
                <Link href={`/clients/${l.clientId}?tab=billing`} className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  {l.clientName}
                </Link>
                <span className="text-text-muted"> · {l.serviceLabel}</span>
              </p>
              <p className="text-sm text-text-muted">
                {l.periodLabel} · ended <DateText date={l.periodEnd} today={today} />
              </p>
            </div>
            <span className="num flex-none text-text tabular-nums">{formatINR(l.agreedPaise)}</span>
            <Link
              href={`/invoices/new?client=${l.clientId}`}
              className="flex-none rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              New invoice
            </Link>
          </li>
        ))}
      </ul>
      {items.length > shown.length ? <p className="px-4 py-2 text-sm text-text-muted">and {items.length - shown.length} more {items.length - shown.length === 1 ? "period" : "periods"}; the table above counts them per engagement and the Excel download lists them all.</p> : null}
    </>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { CalculatorIcon, PlusIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { formatTimeAgo, EMPTY } from "@/lib/format"
import { taxYearLabel } from "@/lib/domain/fy"
import { REGIME_LABEL } from "@/lib/schemas/itr"
import type { ItrListRow } from "@/lib/data/itr"
import { BalanceText, ItrStatusChip, TaxFigure } from "@/components/workpapers/itr/itr-ui"

function Muted({ children }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children ?? EMPTY}</span>
}

/**
 * The ITR register (§7.8.2): client, year (AY / Tax year per statute, §6.1), name, status, the
 * recommended regime and the saving, the regime chosen, tax payable or refund (under the chosen
 * regime, else the recommended one), who prepared it and when it changed. Server-paged and sorted;
 * a row opens the computation. Below 768px each row is a card: client, year, status, balance.
 */
/**
 * `emptyYear`: the list is scoped to one FY (the top bar's) and that year has none. Returns filed now
 * are mostly for the year before, so the empty state says which year it looked at and offers it.
 */
export type ItrEmptyYear = { label: string; other: { label: string; href: string } }

export function ItrTable(props: { rows: ItrListRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; showClient?: boolean; newHref: string; emptyYear?: ItrEmptyYear | null }) {
  const { rows, total, page, pageSize, sort, dir, showClient = true, newHref, emptyYear = null } = props
  const columns = React.useMemo<DataTableColumn<ItrListRow>[]>(() => {
    const cols: DataTableColumn<ItrListRow>[] = []
    if (showClient) {
      cols.push({
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
      })
    }
    cols.push(
      {
        id: "financial_year",
        header: "Year",
        sortable: true,
        mobile: "secondary",
        rowLink: !showClient,
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span className="num">{r.year_label ?? taxYearLabel(r.financial_year)}</span>
            {r.label ? <span className="max-w-[18ch] truncate text-xs text-text-muted">{r.label}</span> : null}
          </span>
        ),
        mobileCell: (r) => r.year_label ?? taxYearLabel(r.financial_year),
      },
      { id: "status", header: "Status", sortable: true, mobile: "trailing", cell: (r) => <ItrStatusChip status={r.status} /> },
      {
        id: "recommended",
        header: "Recommended",
        hideBelow: "lg",
        cell: (r) => (r.recommended_regime ? <span>{REGIME_LABEL[r.recommended_regime]}</span> : <Muted />),
      },
      { id: "saving_paise", header: "Saving", sortable: true, align: "right", hideBelow: "lg", cell: (r) => (r.saving_paise === null ? <Muted /> : <TaxFigure value={r.saving_paise} />) },
      {
        id: "regime_chosen",
        header: "Chosen",
        hideBelow: "xl",
        cell: (r) =>
          r.regime_chosen ? (
            <span className={r.recommended_regime && r.regime_chosen !== r.recommended_regime ? "text-warning-text" : undefined} title={r.regime_chosen !== r.recommended_regime ? "Differs from the recommended regime" : undefined}>
              {REGIME_LABEL[r.regime_chosen]}
            </span>
          ) : (
            <Muted>Not yet</Muted>
          ),
      },
      { id: "balance_paise", header: "Payable / refund", sortable: true, align: "right", mobile: "secondary", cell: (r) => <BalanceText balance={r.balance_paise} className="justify-end" /> },
      { id: "prepared_by_name", header: "Prepared by", hideBelow: "xl", cell: (r) => (r.prepared_by_name ? <span className="text-text-muted">{r.prepared_by_name}</span> : <Muted />) },
      {
        id: "updated_at",
        header: "Updated",
        sortable: true,
        align: "right",
        hideBelow: "lg",
        cell: (r) => (
          <span className="num text-text-muted" title={r.updated_by_name ? `By ${r.updated_by_name}` : undefined} suppressHydrationWarning>
            {formatTimeAgo(r.updated_at)}
          </span>
        ),
      },
    )
    return cols
  }, [showClient])

  return (
    <DataTable
      id={showClient ? "itr-computations" : "client-itr-computations"}
      caption="ITR computations"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/workpapers/itr/${r.id}`}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      dir={dir}
      defaultSort={{ sort: "updated_at", dir: "desc" }}
      countLabel={(n, t) => `${n} ${t === 1 ? "computation" : "computations"}`}
      columnChooser
      empty={
        <EmptyState
          icon={<CalculatorIcon />}
          message={
            emptyYear
              ? `No ITR computations for ${emptyYear.label}. Start one to compare the old and new regimes for a client.`
              : "No ITR computations yet. Start one to compare the old and new regimes for a client."
          }
          action={
            <span className="flex flex-wrap items-center justify-center gap-2">
              {emptyYear ? (
                <Button asChild variant="outline">
                  <Link href={emptyYear.other.href}>Show {emptyYear.other.label}</Link>
                </Button>
              ) : null}
              <Button asChild>
                <Link href={newHref}>
                  <PlusIcon aria-hidden="true" />
                  New computation
                </Link>
              </Button>
            </span>
          }
        />
      }
    />
  )
}

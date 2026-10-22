"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { ColumnChooser, useColumnVisibility } from "@/components/app/data-table/column-chooser"
import { ExportButton } from "@/components/app/data-table/export-button"
import { TablePagination } from "@/components/app/data-table/pagination"
import {
  formatCount,
  nextSort,
  normaliseDefaultSort,
  pageCount,
  RESERVED_PARAMS,
  type DefaultSort,
  type SortDir,
} from "@/components/app/data-table/params"
import type { DataTableColumn } from "@/components/app/data-table/types"
import { useTableNavigationPending, useTableUrlState } from "@/hooks/use-table-url-state"

export type { DataTableColumn } from "@/components/app/data-table/types"

export interface BulkActionContext<T> {
  selectedIds: string[]
  selectedRows: T[]
  clear: () => void
}

export interface DataTableProps<T> {
  /** Stable id for this table: remembers hidden columns, names the region. e.g. "clients". */
  id: string
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowId: (row: T) => string
  /** Total rows for the current filters (Supabase `count: "exact"`). */
  total: number
  page: number
  pageSize: number
  sort?: string | null
  dir?: SortDir
  /** The sort to return to after asc → desc (the page's parseTableParams defaultSort). */
  defaultSort?: DefaultSort<string>
  /** Row click → this detail page. The identity cell also becomes a real link (keyboard, new tab). */
  getRowHref?: (row: T) => string | null | undefined
  /** Checkbox column + the bulk bar. */
  selectable?: boolean
  bulkActions?: (ctx: BulkActionContext<T>) => React.ReactNode
  /** Show the column chooser in the table bar. */
  columnChooser?: boolean
  /** CSV export of the current view, in the table bar. */
  exportCsv?: { href?: string; onExport?: () => void | Promise<void>; label?: string }
  /** Plural noun for the count in the table bar: (n) => `${n} clients`. */
  countLabel?: (formattedTotal: string, total: number) => string
  /** Extra controls on the left of the table bar. */
  toolbar?: React.ReactNode
  /** Accessible name for the table ("Clients"). */
  caption: string
  /** Rows not loaded yet: skeleton rows at the real row height. */
  loading?: boolean
  /** The rows failed to load: shown inside the table frame with its Ref and Retry. */
  error?: { message: string; ref?: string | null; onRetry?: () => void | Promise<void> } | null
  /** Shown when there are no rows and nothing is filtered: an <EmptyState />. */
  empty?: React.ReactNode
  /** Shown when filters leave nothing (default <FilteredEmpty />). */
  filteredEmpty?: React.ReactNode
  /** Override the "is anything filtered?" check (default: any non-table param in the URL). */
  isFiltered?: boolean
  rowClassName?: (row: T) => string | undefined
  /** `viewport` (default): the frame scrolls inside the window height so the header stays in view. */
  maxHeight?: "viewport" | "none"
  className?: string
}

const INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=checkbox],[role=menuitem],[role=button],[data-row-click-ignore]"

function alignClass(align: DataTableColumn<unknown>["align"]) {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
}

function hideClass(h: DataTableColumn<unknown>["hideBelow"]) {
  return h === "lg" ? "hidden lg:table-cell" : h === "xl" ? "hidden xl:table-cell" : ""
}

/**
 * The server-driven list table (§3.4, DESIGN.md §4). Rows, total, page and sort come from the server
 * (parseTableParams + a lib/data range query); every control writes the URL, and the page re-renders
 * on the server. Sticky header on surface-2, 12px grey sentence-case headers, no zebra, 1px rules,
 * numbers right-aligned, row height var(--row-height) (44px, or 36px in compact density). Below
 * 768px rows become stacked cards built from the columns' `mobile` slots.
 *
 * Define columns in a "use client" file (they hold functions):
 *
 *   // components/clients/clients-table.tsx
 *   "use client"
 *   const columns: DataTableColumn<ClientRow>[] = [
 *     { id: "name", header: "Client", cell: (r) => r.name, sortable: true, hideable: false, mobile: "primary", width: "34%" },
 *     { id: "client_code", header: "Code", cell: (r) => <MonoId value={r.client_code} />, mobile: "secondary" },
 *     { id: "status", header: "Status", cell: (r) => <StatusChip kind="client_status" value={r.status} />, mobile: "trailing" },
 *     { id: "fee", header: "Monthly fee", align: "right", cell: (r) => <Money value={r.fee} />, hideBelow: "lg" },
 *   ]
 *   export function ClientsTable(props: { rows: ClientRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir }) {
 *     return (
 *       <DataTable id="clients" caption="Clients" columns={columns} getRowId={(r) => r.id}
 *         getRowHref={(r) => `/clients/${r.id}`} countLabel={(n) => `${n} clients`}
 *         columnChooser exportCsv={{ href: "/api/export/clients" }}
 *         empty={<EmptyState icon={<UsersIcon />} message="No clients yet." action={…} />}
 *         {...props} />
 *     )
 *   }
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    id,
    columns,
    rows,
    getRowId,
    total,
    page,
    pageSize,
    sort = null,
    dir = "asc",
    defaultSort,
    getRowHref,
    selectable = false,
    bulkActions,
    columnChooser = false,
    exportCsv,
    countLabel,
    toolbar,
    caption,
    loading = false,
    error = null,
    empty,
    filteredEmpty,
    rowClassName,
    maxHeight = "viewport",
    className,
  } = props

  const router = useRouter()
  const searchParams = useSearchParams()
  const url = useTableUrlState()
  const navPending = useTableNavigationPending()
  const vis = useColumnVisibility(id, columns)
  const visible = columns.filter((c) => vis.isVisible(c.id))
  const linkColumnId = (visible.find((c) => c.rowLink) ?? visible[0])?.id

  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const rowIds = React.useMemo(() => rows.map(getRowId), [rows, getRowId])
  // Selection survives only for rows still on screen (a page change clears it).
  const selectedIds = React.useMemo(() => rowIds.filter((rid) => selected.has(rid)), [rowIds, selected])
  const selectedRows = React.useMemo(() => rows.filter((r) => selected.has(getRowId(r))), [rows, selected, getRowId])
  const allSelected = rows.length > 0 && selectedIds.length === rows.length
  const someSelected = selectedIds.length > 0 && !allSelected
  const clearSelection = React.useCallback(() => setSelected(new Set()), [])

  const filtered =
    props.isFiltered ??
    Array.from(searchParams.keys()).some((k) => !RESERVED_PARAMS.includes(k) || (k === "q" && !!searchParams.get("q")))

  const def = normaliseDefaultSort(defaultSort)
  const onSort = (column: DataTableColumn<T>) => {
    const key = column.sortKey ?? column.id
    const next = nextSort(key, { sort, dir }, def)
    url.setSort(next.sort, next.dir)
  }

  const onRowClick = (e: React.MouseEvent<HTMLElement>, href: string | null | undefined) => {
    if (!href) return
    const target = e.target as HTMLElement
    const hit = target.closest(INTERACTIVE)
    if (hit && e.currentTarget.contains(hit)) return
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return
    if (e.metaKey || e.ctrlKey) {
      window.open(href, "_blank", "noopener")
      return
    }
    router.push(href)
  }

  const count = pageCount(total, pageSize)
  const pastEnd = !loading && rows.length === 0 && total > 0 && page > count
  const showEmpty = !loading && !error && total === 0 && rows.length === 0
  const busy = navPending && !loading

  const tableBar = (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5 md:px-4">
      {selectable && selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" role="region" aria-label="Bulk actions">
          <span className="num text-sm font-medium text-text" aria-live="polite">
            {formatCount(selectedIds.length)} selected
          </span>
          {bulkActions?.({ selectedIds, selectedRows, clear: clearSelection })}
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Clear selection
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {loading ? (
            <Skeleton className="h-4 w-24" />
          ) : error ? (
            <span className="text-sm text-text-muted">{caption}</span>
          ) : (
            <span className="num text-sm text-text-muted tabular-nums">
              {countLabel ? countLabel(formatCount(total), total) : `${formatCount(total)} ${total === 1 ? "result" : "results"}`}
            </span>
          )}
          {toolbar}
        </div>
      )}
      {columnChooser || exportCsv ? (
        <div className="flex items-center gap-2">
          {columnChooser ? <ColumnChooser tableId={id} columns={columns} /> : null}
          {exportCsv ? <ExportButton {...exportCsv} /> : null}
        </div>
      ) : null}
    </div>
  )

  // Mobile card slots.
  const slotted = visible.some((c) => c.mobile)
  const primaryCol = slotted ? visible.find((c) => c.mobile === "primary") : visible[0]
  const trailingCols = slotted ? visible.filter((c) => c.mobile === "trailing") : []
  const secondaryCols = slotted ? visible.filter((c) => c.mobile === "secondary") : visible.slice(1, 3)

  const renderCellContent = (c: DataTableColumn<T>, row: T, href: string | null | undefined) => {
    const content = c.cell(row)
    if (href && c.id === linkColumnId) {
      return (
        <Link
          href={href}
          className="rounded-sm font-medium text-text outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {content}
        </Link>
      )
    }
    return content
  }

  return (
    <section
      aria-label={caption}
      aria-busy={loading || busy || undefined}
      data-slot="data-table"
      className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-surface", className)}
    >
      {tableBar}

      {error ? (
        <ErrorBlock message={error.message} errorRef={error.ref} onRetry={error.onRetry} />
      ) : showEmpty ? (
        filtered ? (filteredEmpty ?? <FilteredEmpty />) : (empty ?? <EmptyState message="Nothing here yet." />)
      ) : pastEnd ? (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-base text-text">This page is past the end of the list.</p>
          <Button variant="outline" size="sm" onClick={() => url.setPage(count)}>
            Go to page {count}
          </Button>
        </div>
      ) : (
        <>
          {/* Desktop and tablet: the table. */}
          <div
            className={cn(
              "hidden overflow-auto md:block",
              maxHeight === "viewport" && "md:max-h-[max(22rem,calc(100dvh-13rem))]"
            )}
          >
            <table className={cn("w-full border-separate border-spacing-0 text-base transition-opacity duration-150", busy && "opacity-60")}>
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  {selectable ? (
                    <th
                      scope="col"
                      className="sticky top-0 left-0 z-20 h-9 w-11 bg-surface-2 p-0 shadow-[inset_0_-1px_0_var(--border)]"
                    >
                      <div className="flex w-11 items-center justify-center pl-1">
                      <Checkbox
                        aria-label={allSelected ? "Deselect all rows on this page" : "Select all rows on this page"}
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        disabled={loading || rows.length === 0}
                        onCheckedChange={(v) => setSelected(v === true ? new Set(rowIds) : new Set())}
                      />
                      </div>
                    </th>
                  ) : null}
                  {visible.map((c, i) => {
                    const key = c.sortKey ?? c.id
                    const active = c.sortable && sort === key
                    const ariaSort = active ? (dir === "asc" ? "ascending" : "descending") : undefined
                    const stickyLeft = i === 0
                    return (
                      <th
                        key={c.id}
                        scope="col"
                        aria-sort={ariaSort}
                        style={c.width ? { width: c.width } : undefined}
                        className={cn(
                          "sticky top-0 z-10 h-9 bg-surface-2 px-3 text-xs leading-4 font-medium whitespace-nowrap text-text-muted shadow-[inset_0_-1px_0_var(--border)]",
                          alignClass(c.align),
                          hideClass(c.hideBelow),
                          stickyLeft && (selectable ? "md:left-11 md:z-20" : "md:left-0 md:z-20"),
                          i === 0 && !selectable && "pl-4",
                          i === visible.length - 1 && "pr-4"
                        )}
                      >
                        {c.sortable ? (
                          <button
                            type="button"
                            onClick={() => onSort(c)}
                            className={cn(
                              "group/sort -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 outline-none hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                              c.align === "right" && "flex-row-reverse",
                              active && "text-text"
                            )}
                            aria-label={`${c.header}: sort ${active && dir === "asc" ? "descending" : "ascending"}`}
                          >
                            <span>{c.header}</span>
                            {active ? (
                              dir === "asc" ? (
                                <ArrowUpIcon aria-hidden="true" className="size-3.5" />
                              ) : (
                                <ArrowDownIcon aria-hidden="true" className="size-3.5" />
                              )
                            ) : (
                              <span aria-hidden="true" className="size-3.5" />
                            )}
                          </button>
                        ) : (
                          c.header
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: Math.min(pageSize, 10) }, (_, r) => (
                      <tr key={`sk-${r}`} className="h-(--row-height)">
                        {selectable ? (
                          <td className="w-11 border-b border-border/70 p-0">
                            <div className="w-11" />
                          </td>
                        ) : null}
                        {visible.map((c, i) => (
                          <td
                            key={c.id}
                            className={cn("border-b border-border/70 px-3", hideClass(c.hideBelow), i === 0 && !selectable && "pl-4")}
                          >
                            <Skeleton
                              className={cn(
                                "h-3.5",
                                c.align === "right" && "ml-auto",
                                i === 0 ? "w-[70%]" : ["w-[50%]", "w-[65%]", "w-[40%]"][(r + i) % 3]
                              )}
                            />
                          </td>
                        ))}
                      </tr>
                    ))
                  : rows.map((row) => {
                      const rid = getRowId(row)
                      const href = getRowHref?.(row)
                      const isSelected = selected.has(rid)
                      return (
                        <tr
                          key={rid}
                          data-state={isSelected ? "selected" : undefined}
                          onClick={href ? (e) => onRowClick(e, href) : undefined}
                          className={cn(
                            "group/row h-(--row-height) bg-surface transition-colors duration-150 [&:last-child>td]:border-b-0",
                            href && "cursor-pointer hover:bg-bg",
                            isSelected && "bg-primary-soft hover:bg-primary-soft",
                            rowClassName?.(row)
                          )}
                        >
                          {selectable ? (
                            <td className="sticky left-0 z-[1] w-11 border-b border-border/70 bg-inherit p-0">
                              <div className="flex w-11 items-center justify-center pl-1">
                              <Checkbox
                                aria-label="Select row"
                                checked={isSelected}
                                onCheckedChange={(v) =>
                                  setSelected((prev) => {
                                    const next = new Set(prev)
                                    if (v === true) next.add(rid)
                                    else next.delete(rid)
                                    return next
                                  })
                                }
                              />
                              </div>
                            </td>
                          ) : null}
                          {visible.map((c, i) => (
                            <td
                              key={c.id}
                              className={cn(
                                "border-b border-border/70 px-3 align-middle",
                                alignClass(c.align),
                                c.align === "right" && "num tabular-nums",
                                hideClass(c.hideBelow),
                                i === 0 && "max-w-[28rem] truncate md:sticky md:z-[1] md:bg-inherit",
                                i === 0 && (selectable ? "md:left-11" : "md:left-0 pl-4"),
                                i === visible.length - 1 && "pr-4",
                                i !== 0 && "whitespace-nowrap",
                                c.className
                              )}
                            >
                              {renderCellContent(c, row, href)}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
              </tbody>
            </table>
          </div>

          {/* Phones: stacked cards. */}
          <ul className={cn("md:hidden", busy && "opacity-60")} aria-label={caption}>
            {loading
              ? Array.from({ length: 6 }, (_, r) => (
                  <li key={`sk-${r}`} className="flex flex-col gap-2 border-b border-border/70 px-4 py-3 last:border-b-0">
                    <div className="flex justify-between gap-4">
                      <Skeleton className="h-4 w-[55%]" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                    <Skeleton className="h-3 w-[40%]" />
                  </li>
                ))
              : rows.map((row) => {
                  const rid = getRowId(row)
                  const href = getRowHref?.(row)
                  const isSelected = selected.has(rid)
                  const secondary = secondaryCols.map((c) => ({ id: c.id, node: (c.mobileCell ?? c.cell)(row) }))
                  return (
                    <li
                      key={rid}
                      className={cn(
                        "relative flex gap-3 border-b border-border/70 px-4 py-3 last:border-b-0",
                        isSelected && "bg-primary-soft"
                      )}
                    >
                      {selectable ? (
                        <div className="relative z-[2] pt-0.5">
                          <Checkbox
                            aria-label="Select row"
                            checked={isSelected}
                            onCheckedChange={(v) =>
                              setSelected((prev) => {
                                const next = new Set(prev)
                                if (v === true) next.add(rid)
                                else next.delete(rid)
                                return next
                              })
                            }
                          />
                        </div>
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1 truncate text-base leading-6 font-medium text-text">
                            {primaryCol ? (
                              href ? (
                                <Link
                                  href={href}
                                  className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                                >
                                  {(primaryCol.mobileCell ?? primaryCol.cell)(row)}
                                </Link>
                              ) : (
                                (primaryCol.mobileCell ?? primaryCol.cell)(row)
                              )
                            ) : null}
                          </div>
                          {trailingCols.length ? (
                            <div className="flex flex-none items-center gap-2 text-right [&_a]:relative [&_a]:z-[2] [&_button]:relative [&_button]:z-[2]">
                              {trailingCols.map((c) => (
                                <span key={c.id} className={cn(c.align === "right" && "num tabular-nums")}>
                                  {(c.mobileCell ?? c.cell)(row)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {secondary.length ? (
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm leading-5 text-text-muted [&_a]:relative [&_a]:z-[2] [&_button]:relative [&_button]:z-[2]">
                            {secondary.map((s, i) => (
                              <span key={s.id} className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                                {i > 0 ? <span aria-hidden="true">·</span> : null}
                                {s.node}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
          </ul>

          {loading ? (
            <div className="flex h-12 items-center justify-between border-t border-border px-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-40" />
            </div>
          ) : total > 0 ? (
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              disabled={busy}
              onPage={(p) => {
                clearSelection()
                url.setPage(p)
              }}
              onPageSize={(s) => {
                clearSelection()
                url.setPageSize(s)
              }}
            />
          ) : null}
        </>
      )}
    </section>
  )
}

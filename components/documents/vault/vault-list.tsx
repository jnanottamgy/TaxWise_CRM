"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { DownloadIcon, FolderOpenIcon, LayoutGridIcon, ListIcon, LockIcon, Trash2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { TablePagination } from "@/components/app/data-table/pagination"
import { applyTablePatch, type SortDir } from "@/components/app/data-table/params"
import { FilterBar } from "@/components/app/filter-bar"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from "@/lib/domain/enums"
import { formatFileSize } from "@/lib/domain/files"
import { formatDate } from "@/lib/format"
import { CATEGORY_OPTIONS, VAULT_PRESERVE } from "@/lib/schemas/documents"
import type { VaultRow } from "@/lib/data/documents"
import { FileTypeMark } from "@/components/documents/file-type-mark"
import { documentsHref, fileHref } from "@/components/documents/doc-urls"
import { useVaultActions } from "@/components/documents/vault/vault-actions"

/**
 * The vault's list and grid (§7.14 "list and grid; search by title, tag or text"). Server-paginated
 * and sorted (lib/data/documents.ts listVault); the URL holds the state. A row or card opens the
 * document (`?doc=`); Download is one click. Confidential files carry a lock badge.
 */

export interface VaultListProps {
  clientId: string
  rows: VaultRow[]
  total: number
  page: number
  pageSize: number
  sort: string
  dir: SortDir
  layout: "list" | "grid"
  bin: boolean
  /** Search, a folder or the expiring filter is on. */
  filtered: boolean
  canUpload: boolean
  fyOptions: string[]
  category: DocumentCategory | null
  fy: string | null
}

export function ConfidentialBadge({ className }: { className?: string }) {
  return (
    <StatusChip
      label="Confidential"
      tone="neutral"
      variant="pill"
      meaning="Confidential: only Partners, Managers and this client's own team (owner, engagement team, cover in force) can open it."
      className={className}
    />
  )
}

function SharedBadge() {
  return <StatusChip label="Shared" tone="info" variant="pill" meaning="Shared with the client: they can see and download it in the portal." />
}

function useCurrentParams(): URLSearchParams {
  const sp = useSearchParams()
  return React.useMemo(() => new URLSearchParams(sp?.toString() ?? ""), [sp])
}

/** Search, the narrow-screen folder selects, and the list / grid switch. */
export function VaultToolbar({ clientId, layout, fyOptions, category, fy }: { clientId: string; layout: "list" | "grid"; fyOptions: string[]; category: DocumentCategory | null; fy: string | null }) {
  const router = useRouter()
  const current = useCurrentParams()
  const [pending, start] = React.useTransition()
  const go = (patch: Record<string, string | null>) => start(() => router.push(documentsHref(clientId, patch, current), { scroll: false }))
  return (
    <FilterBar
      searchLabel="Search documents"
      searchPlaceholder="Title, tag, file name or period"
      className="pb-0"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-2 lg:hidden">
            <label className="sr-only" htmlFor="vault-cat">
              Category
            </label>
            <NativeSelect id="vault-cat" size="sm" value={category ?? ""} disabled={pending} onChange={(e) => go({ dcat: e.target.value || null, dbin: null, dexp: null })}>
              <NativeSelectOption value="">All categories</NativeSelectOption>
              {CATEGORY_OPTIONS.map((c) => (
                <NativeSelectOption key={c.value} value={c.value}>
                  {c.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="sr-only" htmlFor="vault-fy">
              Financial year
            </label>
            <NativeSelect id="vault-fy" size="sm" value={fy ?? ""} disabled={pending} onChange={(e) => go({ dfy: e.target.value || null, dbin: null, dexp: null })}>
              <NativeSelectOption value="">All years</NativeSelectOption>
              {fyOptions.map((y) => (
                <NativeSelectOption key={y} value={y}>
                  FY {y}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="none">No FY</NativeSelectOption>
            </NativeSelect>
          </div>
          <div role="group" aria-label="Layout" className="inline-flex rounded-md border border-text-muted/30 p-0.5">
            {(["list", "grid"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={layout === l}
                aria-label={l === "list" ? "Show as a list" : "Show as a grid"}
                onClick={() => go({ dview: l === "grid" ? "grid" : null })}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-[6px] text-text-muted transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-10",
                  layout === l ? "bg-surface-2 text-text" : "hover:text-text"
                )}
              >
                {l === "list" ? <ListIcon aria-hidden="true" className="size-4" /> : <LayoutGridIcon aria-hidden="true" className="size-4" />}
              </button>
            ))}
          </div>
        </div>
      }
    />
  )
}

function EmptyVault({ bin, canUpload }: { bin: boolean; canUpload: boolean }) {
  const { openUpload } = useVaultActions()
  if (bin) return <EmptyState icon={<Trash2Icon />} message="The recycle bin is empty. Documents moved here can be restored." />
  return (
    <EmptyState
      icon={<FolderOpenIcon />}
      message="No documents for this client yet. Upload returns, certificates, statements and working papers to keep them in one place."
      action={
        canUpload ? (
          <Button type="button" onClick={() => openUpload()}>
            Upload files
          </Button>
        ) : undefined
      }
    />
  )
}

function DownloadLink({ row }: { row: VaultRow }) {
  return (
    <Button asChild variant="ghost" size="icon-sm" data-row-click-ignore>
      <a href={fileHref(row.id)} aria-label={`Download ${row.title}`} title="Download">
        <DownloadIcon aria-hidden="true" />
      </a>
    </Button>
  )
}

function uploader(row: VaultRow): string {
  if (row.source === "client_portal") return "the client"
  return row.uploaded_by_name || "the firm"
}

export function VaultTable(props: VaultListProps) {
  const current = useCurrentParams()
  const columns = React.useMemo<DataTableColumn<VaultRow>[]>(
    () => [
      {
        id: "title",
        header: "Document",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "40%",
        cell: (r) => (
          <div className="flex min-w-0 items-center gap-3">
            <FileTypeMark mimeType={r.mime_type} fileName={r.file_name} />
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-text">{r.title}</span>
                {r.is_confidential ? <LockIcon aria-label="Confidential" className="size-3.5 flex-none text-text-muted" /> : null}
              </p>
              <p className="truncate text-sm text-text-muted">
                {r.file_name} · <span className="num tabular-nums">{formatFileSize(r.file_size)}</span>
                {r.version > 1 ? ` · v${r.version}` : ""}
              </p>
            </div>
          </div>
        ),
        mobileCell: (r) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{r.title}</span>
            {r.is_confidential ? <LockIcon aria-label="Confidential" className="size-3.5 flex-none text-text-muted" /> : null}
          </span>
        ),
      },
      { id: "category", header: "Category", sortable: true, mobile: "secondary", cell: (r) => DOCUMENT_CATEGORY_LABELS[r.category] },
      {
        id: "financial_year",
        header: "FY · period",
        sortable: true,
        mobile: "secondary",
        cell: (r) =>
          r.financial_year || r.period ? (
            <span className="whitespace-nowrap">{[r.financial_year, r.period].filter(Boolean).join(" · ")}</span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
      },
      {
        id: "tags",
        header: "Tags",
        hideBelow: "xl",
        cell: (r) =>
          r.tags.length ? (
            <span className="line-clamp-1 text-sm text-text-muted">{r.tags.join(", ")}</span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
      },
      {
        id: "sharing",
        header: "Access",
        hideBelow: "lg",
        cell: (r) => (r.is_confidential ? <ConfidentialBadge /> : r.shareable_with_client ? <SharedBadge /> : <span className="text-sm text-text-muted">Firm</span>),
      },
      {
        id: "created_at",
        header: props.bin ? "Deleted" : "Uploaded",
        sortable: !props.bin,
        align: "right",
        mobile: "trailing",
        cell: (r) => (
          <div className="text-right">
            <DateText date={props.bin ? r.deleted_at : r.created_at} />
            <p className="truncate text-sm text-text-muted">by {uploader(r)}</p>
          </div>
        ),
        mobileCell: (r) => <DateText date={props.bin ? r.deleted_at : r.created_at} />,
      },
      { id: "file_size", header: "Size", sortable: true, align: "right", hideBelow: "xl", defaultHidden: true, cell: (r) => <span className="num tabular-nums">{formatFileSize(r.file_size)}</span> },
      { id: "download", header: "Download", align: "right", hideable: false, width: "3.5rem", cell: (r) => <DownloadLink row={r} /> },
    ],
    [props.bin]
  )
  return (
    <DataTable
      id="client-vault"
      caption="Documents"
      columns={columns}
      rows={props.rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => documentsHref(props.clientId, { doc: r.id }, current)}
      total={props.total}
      page={props.page}
      pageSize={props.pageSize}
      sort={props.sort}
      dir={props.dir}
      defaultSort={{ sort: "created_at", dir: "desc" }}
      countLabel={(n, total) => `${n} ${total === 1 ? "document" : "documents"}`}
      columnChooser
      isFiltered={props.filtered}
      maxHeight="none"
      empty={<EmptyVault bin={props.bin} canUpload={props.canUpload} />}
      filteredEmpty={<FilteredEmpty preserve={VAULT_PRESERVE} message={props.bin ? "No documents in the recycle bin match." : "No documents match this search or folder."} />}
    />
  )
}

/** The grid: one card per document (type mark, title, category and FY, date), paged like the table. */
export function VaultGrid(props: VaultListProps) {
  const router = useRouter()
  const pathname = usePathname()
  const current = useCurrentParams()
  const [pending, start] = React.useTransition()
  const nav = (patch: { page?: number; pageSize?: number }) => {
    const qs = applyTablePatch(current, patch)
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }
  if (props.total === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        {props.filtered ? <FilteredEmpty preserve={VAULT_PRESERVE} message="No documents match this search or folder." /> : <EmptyVault bin={props.bin} canUpload={props.canUpload} />}
      </div>
    )
  }
  return (
    <div className={cn("rounded-lg border border-border bg-surface transition-opacity", pending && "opacity-60")}>
      <ul className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label="Documents">
        {props.rows.map((r) => (
          <li key={r.id} className="relative flex min-w-0 gap-3 rounded-lg border border-border bg-surface p-3 transition-colors duration-150 hover:border-text-muted/40">
            <FileTypeMark mimeType={r.mime_type} fileName={r.file_name} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col">
              <Link
                href={documentsHref(props.clientId, { doc: r.id }, current)}
                scroll={false}
                className="line-clamp-2 font-medium text-text outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:outline-ring"
              >
                {r.title}
              </Link>
              <p className="mt-0.5 truncate text-sm text-text-muted">
                {DOCUMENT_CATEGORY_LABELS[r.category]}
                {r.financial_year ? ` · FY ${r.financial_year}` : ""}
                {r.period ? ` · ${r.period}` : ""}
              </p>
              <p className="num mt-auto pt-2 text-sm text-text-muted tabular-nums">
                {formatDate(props.bin ? r.deleted_at : r.created_at)} · {formatFileSize(r.file_size)}
                {r.version > 1 ? ` · v${r.version}` : ""}
              </p>
              {r.is_confidential || r.shareable_with_client ? (
                <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">{r.is_confidential ? <ConfidentialBadge /> : <SharedBadge />}</div>
              ) : null}
            </div>
            <div className="relative z-10 -mt-1 -mr-1">
              <DownloadLink row={r} />
            </div>
          </li>
        ))}
      </ul>
      <TablePagination page={props.page} pageSize={props.pageSize} total={props.total} onPage={(p) => nav({ page: p })} onPageSize={(s) => nav({ pageSize: s })} disabled={pending} />
    </div>
  )
}

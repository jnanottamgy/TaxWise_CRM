"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Building2Icon, FileTextIcon, FolderOpenIcon, ListChecksIcon, MoreHorizontalIcon, ReceiptTextIcon, RotateCcwIcon, TargetIcon, Trash2Icon, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Explain } from "@/components/app/explain"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EMPTY, formatDate, formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format"
import { purgeFromBin, restoreFromBin } from "@/server/actions/recycle-bin"
import { BIN_ENTITY_LABEL, purgeConfirmPhrase, type BinEntity } from "@/components/recycle-bin/entities"

export type BinItemView = {
  entity: BinEntity
  id: string
  title: string
  reference: string | null
  clientId: string | null
  clientName: string | null
  deletedAt: string
  deletedByName: string | null
  updatedAt: string
  parentInBin: boolean
  tasksWith: number
  documentsWith: number
  invoicesWith: number
  /** Partner only: why a purge is refused (empty = it may be purged); null = not asked. */
  blockers: Array<{ code: string; message: string; until?: string | null }> | null
}

const ENTITY_ICON: Record<BinEntity, LucideIcon> = {
  client: Building2Icon,
  task: ListChecksIcon,
  document: FolderOpenIcon,
  invoice: ReceiptTextIcon,
  lead: TargetIcon,
  quotation: FileTextIcon,
}

function plural(n: number, one: string, many: string) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`
}

/** "3 tasks, 12 documents and 2 invoices" deleted with a client. */
function withSummary(r: BinItemView): string | null {
  const parts = [
    r.tasksWith ? plural(r.tasksWith, "task", "tasks") : null,
    r.documentsWith ? plural(r.documentsWith, "document", "documents") : null,
    r.invoicesWith ? plural(r.invoicesWith, "invoice", "invoices") : null,
  ].filter((p): p is string => !!p)
  if (parts.length === 0) return null
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** The latest "kept until" date among the blockers, for the column. */
function keptUntil(blockers: BinItemView["blockers"]): string | null {
  const dates = (blockers ?? []).map((b) => b.until).filter((d): d is string => !!d).sort()
  return dates.length ? dates[dates.length - 1] : null
}

function PurgeStatus({ row }: { row: BinItemView }) {
  if (row.blockers === null) return <span className="text-text-muted">{EMPTY}</span>
  if (row.blockers.length === 0) return <span className="text-text-muted">Can be purged</span>
  const until = keptUntil(row.blockers)
  return (
    <Explain
      content={
        <ul className="flex max-w-xs flex-col gap-1.5 text-sm">
          {row.blockers.map((b) => (
            <li key={b.code}>{b.message}</li>
          ))}
        </ul>
      }
    >
      <button type="button" className="rounded-sm text-left text-warning-text underline decoration-dotted underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring">
        {until ? `Kept until ${formatDate(until)}` : "Kept on record"}
      </button>
    </Explain>
  )
}

function RowActions({ row, canPurge, onRestore, onPurge }: { row: BinItemView; canPurge: boolean; onRestore: () => void; onPurge: () => void }) {
  const waiting = row.parentInBin
  const restore = (
    <Button variant="ghost" size="sm" onClick={onRestore} disabled={waiting} aria-label={`Restore ${row.title}`}>
      <RotateCcwIcon aria-hidden="true" />
      <span className="max-sm:sr-only">Restore</span>
    </Button>
  )
  return (
    <div className="flex items-center justify-end gap-1" data-row-click-ignore>
      {waiting ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring">
              {restore}
            </span>
          </TooltipTrigger>
          <TooltipContent>{row.entity === "quotation" ? "Its client or lead is in the recycle bin. Restore that first." : `Restore ${row.clientName ?? "the client"} first; this comes back with it.`}</TooltipContent>
        </Tooltip>
      ) : (
        restore
      )}
      {canPurge ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label={`More for ${row.title}`}>
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={onPurge}>
              <Trash2Icon aria-hidden="true" />
              Purge permanently…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

/**
 * The recycle bin (§7.19): every soft-deleted record with who deleted it and when. Restore for
 * Partners and Managers (a client brings back what went with it); Purge permanently for Partners,
 * after typing the record's code, and only once nothing keeps it (§6.8). Server-paged and sorted.
 * Below 768px each row is a card: the record, its type and when it was deleted, with its actions.
 */
export function RecycleBinTable(props: {
  rows: BinItemView[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  canPurge: boolean
}) {
  const { rows, canPurge } = props
  const router = useRouter()
  const [restoring, setRestoring] = React.useState<BinItemView | null>(null)
  const [purging, setPurging] = React.useState<BinItemView | null>(null)

  const columns = React.useMemo<DataTableColumn<BinItemView>[]>(() => {
    const cols: DataTableColumn<BinItemView>[] = [
      {
        id: "title",
        header: "Record",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "26%",
        cell: (r) => {
          const Icon = ENTITY_ICON[r.entity]
          const sub = r.entity === "client" ? withSummary(r) : null
          return (
            <span className="flex min-w-0 items-center gap-3" title={r.title}>
              <Icon aria-hidden="true" className="size-4 flex-none text-text-muted" />
              <span className="flex min-w-0 flex-col leading-5">
                <span className="truncate font-medium text-text">{r.title}</span>
                <span className="truncate text-xs text-text-muted">
                  {[r.entity === "document" ? null : r.reference, sub ? `With ${sub}` : null].filter(Boolean).join(" · ") || BIN_ENTITY_LABEL[r.entity].one}
                </span>
              </span>
            </span>
          )
        },
        mobileCell: (r) => r.title,
      },
      { id: "entity", header: "Type", sortable: true, mobile: "secondary", cell: (r) => <span className="text-text-muted">{BIN_ENTITY_LABEL[r.entity].one}</span> },
      {
        id: "client",
        header: "Client or lead",
        hideBelow: "lg",
        cell: (r) =>
          r.entity === "client" ? (
            <span className="text-text-muted">{EMPTY}</span>
          ) : r.clientName ? (
            <span className="inline-flex min-w-0 flex-col leading-5">
              <span className="truncate">{r.clientName}</span>
              {r.parentInBin ? <span className="text-xs text-text-muted">In the recycle bin</span> : null}
            </span>
          ) : r.entity === "quotation" && r.reference ? (
            <span className="truncate text-text-muted">{r.reference}</span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
      },
      {
        id: "deleted_at",
        header: "Deleted",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5" title={formatDateTime(r.deletedAt)}>
            <span>{formatDate(r.deletedAt)}</span>
            {/* Below 2xl the "Deleted by" column is folded in here (who, in place of "3 days ago"), so
                Restore stays in view at 1366. */}
            <span className="text-xs text-text-muted 2xl:hidden" suppressHydrationWarning>
              {r.deletedByName ?? formatTimeAgo(r.deletedAt)}
            </span>
            <span className="hidden text-xs text-text-muted 2xl:inline" suppressHydrationWarning>
              {formatTimeAgo(r.deletedAt)}
            </span>
          </span>
        ),
        mobileCell: (r) => <span title={formatDateTime(r.deletedAt)}>{formatDate(r.deletedAt)}</span>,
      },
      { id: "deleted_by", header: "Deleted by", hideBelow: "2xl", cell: (r) => (r.deletedByName ? <span className="text-text-muted">{r.deletedByName}</span> : <span className="text-text-muted">{EMPTY}</span>) },
    ]
    if (canPurge) cols.push({ id: "purge", header: "Purge", hideBelow: "xl", cell: (r) => <PurgeStatus row={r} /> })
    cols.push({
      id: "actions",
      header: "Actions",
      align: "right",
      hideable: false,
      mobile: "trailing",
      cell: (r) => <RowActions row={r} canPurge={canPurge} onRestore={() => setRestoring(r)} onPurge={() => setPurging(r)} />,
    })
    return cols
  }, [canPurge])

  const purgeBlocked = purging?.blockers && purging.blockers.length > 0 ? purging : null
  const purgeOpen = purging && !purgeBlocked ? purging : null

  return (
    <>
      <DataTable
        id="recycle-bin"
        caption="Recycle bin"
        columns={columns}
        rows={rows}
        getRowId={(r) => `${r.entity}:${r.id}`}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "deleted_at", dir: "desc" }}
        countLabel={(n, total) => `${n} ${total === 1 ? "record" : "records"} in the bin`}
        empty={<EmptyState icon={<Trash2Icon />} message="The recycle bin is empty. Deleted clients, tasks, documents, invoices, leads and quotations wait here until someone restores them." />}
      />

      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(o) => (o ? null : setRestoring(null))}
        title={restoring ? `Restore ${restoring.title}?` : "Restore?"}
        description={
          restoring
            ? restoring.entity === "client"
              ? `${restoring.title} goes back into every list${withSummary(restoring) ? `, with the ${withSummary(restoring)} deleted with it` : ""}. Anything deleted from it earlier stays in the bin.`
              : `The ${BIN_ENTITY_LABEL[restoring.entity].one.toLowerCase()} goes back into every list, as it was when it was deleted.`
            : ""
        }
        confirmLabel="Restore"
        onConfirm={async () => {
          if (!restoring) return
          const r = await restoreFromBin({ entity: restoring.entity, id: restoring.id, updatedAt: restoring.updatedAt })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success(r.data.summary, { action: { label: "Open", onClick: () => router.push(r.data.href) } })
          for (const w of r.warnings ?? []) toast.warning(w)
          setRestoring(null)
          router.refresh()
        }}
      />

      <ConfirmDialog
        open={!!purgeOpen}
        onOpenChange={(o) => (o ? null : setPurging(null))}
        title={purgeOpen ? `Purge ${purgeOpen.title} permanently?` : "Purge permanently?"}
        description={
          purgeOpen
            ? purgeOpen.entity === "client"
              ? `The client and everything that belongs to it (contacts, tasks, documents and their files, compliance dates, messages and its timeline) are deleted for good. The audit log keeps a record of the purge. This can't be undone.`
              : `The ${BIN_ENTITY_LABEL[purgeOpen.entity].one.toLowerCase()} is deleted for good${purgeOpen.entity === "document" ? ", with every version of its file" : ""}. The audit log keeps a record of the purge. This can't be undone.`
            : ""
        }
        confirmLabel="Purge permanently"
        destructive
        typeToConfirm={purgeOpen ? purgeConfirmPhrase({ entity: purgeOpen.entity, reference: purgeOpen.reference, title: purgeOpen.title }) : undefined}
        onConfirm={async () => {
          if (!purgeOpen) return
          const phrase = purgeConfirmPhrase({ entity: purgeOpen.entity, reference: purgeOpen.reference, title: purgeOpen.title })
          const r = await purgeFromBin({ entity: purgeOpen.entity, id: purgeOpen.id, updatedAt: purgeOpen.updatedAt, confirm: phrase })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success(`${r.data.label} is purged.`)
          for (const w of r.warnings ?? []) toast.warning(w)
          setPurging(null)
          router.refresh()
        }}
      />

      <Dialog open={!!purgeBlocked} onOpenChange={(o) => (o ? null : setPurging(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{purgeBlocked ? `${purgeBlocked.title} can't be purged yet` : "Can't be purged yet"}</DialogTitle>
            <DialogDescription>The retention rules keep it on record. It stays in the recycle bin, and can still be restored.</DialogDescription>
          </DialogHeader>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-base text-text">
            {(purgeBlocked?.blockers ?? []).map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurging(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

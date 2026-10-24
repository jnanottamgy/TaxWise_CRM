import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatNumber } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import { BIN_FILTERS, getPurgeBlockers, getRecycleBinCounts, listBinDeleters, listRecycleBin, type BinBlocker } from "@/lib/data/recycle-bin"
import { parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { RecycleBinTable, type BinItemView } from "@/components/recycle-bin/recycle-bin-table"
import { BIN_ENTITIES, BIN_ENTITY_LABEL, BIN_PERIODS, BIN_PERIOD_LABEL, BIN_SORTABLE } from "@/components/recycle-bin/entities"

export const metadata: Metadata = { title: "Recycle bin" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/recycle-bin:${source}`, userId }) }
  }
}

/**
 * The recycle bin (§7.19): "What was deleted, and can it come back?" Soft-deleted clients, tasks,
 * documents, invoices, leads and quotations with who deleted them and when; what went with a client
 * is folded into its row. Partners and Managers restore; only a Partner purges, and only once the
 * retention rules let go (§6.8). Employees are refused here and by the database.
 */
export default async function RecycleBinPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: BIN_SORTABLE, defaultSort: { sort: "deleted_at", dir: "desc" }, filters: BIN_FILTERS })
  const today = todayIST()
  const isPartner = user.role === "partner"

  const [list, counts, deleters] = await Promise.all([
    attempt("list", user.id, () => listRecycleBin(supabase, t, today)),
    attempt("counts", user.id, () => getRecycleBinCounts(supabase)),
    attempt("deleters", user.id, () => listBinDeleters(supabase)),
  ])
  const blockers = isPartner && list.ok ? await attempt("blockers", user.id, () => getPurgeBlockers(supabase, list.data.rows)) : null

  const filters: FilterDef[] = [
    {
      id: "entity",
      label: "Type",
      options: BIN_ENTITIES.map((e) => ({ value: e, label: counts.ok ? `${BIN_ENTITY_LABEL[e].many} (${formatNumber(counts.data[e])})` : BIN_ENTITY_LABEL[e].many })),
    },
    { id: "period", label: "Deleted", multi: false, options: BIN_PERIODS.map((p) => ({ value: p, label: BIN_PERIOD_LABEL[p] })) },
    ...(deleters.ok && deleters.data.length ? [{ id: "deleted_by", label: "Deleted by", multi: false, options: deleters.data, searchable: deleters.data.length > 7 }] : []),
  ]

  const inBin = counts.ok ? Object.values(counts.data).reduce((n, c) => n + c, 0) : null
  const description =
    inBin === null
      ? "Deleted records, with who deleted them and when."
      : inBin === 0
        ? "Nothing has been deleted."
        : `${formatNumber(inBin)} ${inBin === 1 ? "record" : "records"} waiting to be restored or purged`

  const rows: BinItemView[] = list.ok
    ? list.data.rows.map((r) => {
        let rowBlockers: BinBlocker[] | null = null
        if (blockers?.ok) rowBlockers = blockers.data.get(`${r.entity}:${r.id}`) ?? []
        return {
          entity: r.entity,
          id: r.id,
          title: r.title,
          reference: r.reference,
          clientId: r.client_id,
          clientName: r.client_name,
          deletedAt: r.deleted_at,
          deletedByName: r.deleted_by_name,
          updatedAt: r.updated_at,
          parentInBin: r.parent_in_bin,
          tasksWith: r.tasks_with,
          documentsWith: r.documents_with,
          invoicesWith: r.invoices_with,
          blockers: rowBlockers,
        }
      })
    : []

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Recycle bin">
        <p>Deleting a client, task, document, invoice, lead or quotation moves it here. It leaves every list and search, and nothing about it is lost.</p>
        <p className="mt-2">Restore puts it back as it was. Restoring a client brings back the tasks, documents, invoices and WhatsApp groups deleted with it; something deleted from the client earlier stays here until you restore it too. A task, document or invoice whose client is still in the bin comes back with its client.</p>
        <p className="mt-2">
          Purge permanently is for Partners. It is refused while the retention rules keep the record: a document until its retention date, an invoice for 72 months from the GST annual return&apos;s due date, a client while its audit files, UDINs, filing history or engagement letters are kept. Receipts and credit notes are never deleted, so an invoice with them stays on record.
        </p>
      </PageGuide>
      <PageHeader title="Recycle bin" description={description} />
      <FilterBar searchLabel="Search the recycle bin" searchPlaceholder="Name, code, number or client" filters={filters} />
      {blockers && !blockers.ok ? (
        <p className="mb-3 text-sm text-text-muted">
          Couldn&apos;t check which records may be purged (Ref <span className="font-mono">{blockers.ref}</span>). Purge stays available; the database still refuses anything it must keep.
        </p>
      ) : null}
      {list.ok ? (
        <RecycleBinTable rows={rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} canPurge={isPartner} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the recycle bin." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

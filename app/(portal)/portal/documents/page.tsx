import type { Metadata } from "next"
import { FileCheck2Icon } from "lucide-react"
import { requireClient } from "@/lib/auth/guards"
import { isFinancialYear, recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS } from "@/lib/domain/enums"
import { outstandingItemCount } from "@/lib/domain/portal-copy"
import { formatDate } from "@/lib/format"
import { SHARED_SORTS } from "@/lib/schemas/portal"
import { getPortalClient, hasSharedDocuments, listRequests, listSharedDocuments } from "@/lib/data/portal"
import { parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { EmptyState } from "@/components/app/empty-state"
import { FilterBar } from "@/components/app/filter-bar"
import { attempt } from "@/components/portal/load"
import { NotLinked, PortalBlockError } from "@/components/portal/portal-ui"
import { RequestCard } from "@/components/portal/request-card"
import { SharedDocumentsTable } from "@/components/portal/tables"

export const metadata: Metadata = { title: "Documents" }

/**
 * Documents (§7.22, §7.14): the requests the firm sent, each item with its status, the reason when
 * a file couldn't be used, and the upload (drag-drop, choose, or the camera on a phone) or
 * re-upload; then the documents the firm shared (returns, computations, financial statements, the
 * engagement letter), searchable and paged in SQL. Uploads go through the documents module's upload
 * flow as portal uploads (source client_portal); downloads through the RLS-checked file route.
 */
export default async function PortalDocumentsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireClient()
  const sp = await props.searchParams
  const today = todayIST()
  const t = parseTableParams(sp, {
    sortable: SHARED_SORTS,
    defaultSort: { sort: "created_at", dir: "desc" },
    filters: { category: DOCUMENT_CATEGORIES, year: null },
  })
  const category = t.filters.category?.[0] ?? null
  const yearRaw = t.filters.year?.[0] ?? null
  const year = yearRaw && isFinancialYear(yearRaw) ? yearRaw : null

  const client = await attempt("documents:client", user.id, () => getPortalClient(supabase))
  if (client.ok && !client.data) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Documents" />
        <NotLinked />
      </div>
    )
  }

  const [requests, shared, anyShared] = await Promise.all([
    attempt("documents:requests", user.id, () => listRequests(supabase, { completedLimit: 5 })),
    attempt("documents:shared", user.id, () =>
      listSharedDocuments(supabase, { q: t.q, category, fy: year, sort: (t.sort ?? "created_at") as "created_at" | "title", dir: t.dir, from: t.from, to: t.to }),
    ),
    attempt("documents:any-shared", user.id, () => hasSharedDocuments(supabase)),
  ])

  const open = requests.ok ? requests.data.open : []
  const done = requests.ok ? requests.data.completed : []
  const toUpload = open.reduce((n, r) => n + outstandingItemCount(r.items), 0)
  const clientId = client.ok && client.data ? client.data.id : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Documents"
        description={
          requests.ok
            ? toUpload > 0
              ? `${toUpload} ${toUpload === 1 ? "document" : "documents"} to upload for ${open.length} ${open.length === 1 ? "request" : "requests"}.`
              : "Nothing to upload right now. Documents we share with you are below."
            : "What we've asked you for, and what we've shared with you."
        }
      />

      <section aria-labelledby="requests-title" className="mb-6 md:mb-8">
        <h2 id="requests-title" className="mb-3 text-md font-semibold text-text">
          What we&apos;ve asked for
        </h2>
        {!requests.ok ? (
          <PortalBlockError title="Requests" message="Couldn't load your document requests." errorRef={requests.ref} />
        ) : open.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface">
            <EmptyState icon={<FileCheck2Icon />} message="No open requests. When we need documents from you, the list appears here, item by item." />
          </div>
        ) : !clientId ? (
          <PortalBlockError title="Requests" message="Couldn't load your client file, so uploads aren't available." errorRef={client.ok ? "" : client.ref} />
        ) : (
          <div className="flex flex-col gap-4">
            {open.map((r) => (
              <div key={r.id} id={`req-${r.id}`} className="scroll-mt-32">
                <RequestCard request={r} clientId={clientId} today={today} />
              </div>
            ))}
          </div>
        )}
        {requests.ok && done.length > 0 ? (
          <details className="group mt-4 rounded-lg border border-border bg-surface">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 text-base font-medium text-text outline-none focus-visible:outline-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
              Completed requests
              <span className="text-sm font-normal text-text-muted">
                <span className="group-open:hidden">Show the latest {done.length}</span>
                <span className="hidden group-open:inline">Hide</span>
              </span>
            </summary>
            <ul className="divide-y divide-border/70 border-t border-border px-4 md:px-5">
              {done.map((r) => (
                <li key={r.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <span className="text-base text-text">{r.title}</span>
                  <span className="text-sm text-text-muted">
                    {r.items.length} {r.items.length === 1 ? "item" : "items"} · completed {r.completedAt ? formatDate(r.completedAt) : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="shared-title">
        <h2 id="shared-title" className="text-md font-semibold text-text">
          Shared with you
        </h2>
        <p className="mt-0.5 mb-3 text-sm text-text-muted">Returns, computations, financial statements and letters from the firm.</p>
        {anyShared.ok && anyShared.data ? (
          <FilterBar
            searchLabel="Search shared documents"
            searchPlaceholder="Search by title"
            filters={[
              { id: "category", label: "Type", multi: false, options: DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_CATEGORY_LABELS[c] })) },
              { id: "year", label: "Year", multi: false, options: recentFinancialYears(today, 8).map((y) => ({ value: y, label: `FY ${y}` })) },
            ]}
          />
        ) : null}
        {!shared.ok ? (
          <PortalBlockError title="Shared with you" message="Couldn't load the documents shared with you." errorRef={shared.ref} />
        ) : (
          <SharedDocumentsTable
            rows={shared.data.rows}
            total={shared.data.total}
            page={t.page}
            pageSize={t.pageSize}
            sort={t.sort}
            dir={t.dir}
            isFiltered={Boolean(t.q || category || year)}
          />
        )}
      </section>
    </div>
  )
}

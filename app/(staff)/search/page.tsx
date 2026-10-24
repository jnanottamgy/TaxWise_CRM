import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { SearchXIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatNumber } from "@/lib/format"
import { listRecentSearches, searchEverything } from "@/lib/data/search"
import {
  PAGE_GROUP_ITEMS,
  SEARCH_MIN_LENGTH,
  SEARCH_TYPE_FIELDS,
  SEARCH_TYPE_LABEL,
  isSearchType,
  normaliseQuery,
  searchTypesFor,
  type SearchType,
} from "@/lib/schemas/search"
import { DEFAULT_PAGE_SIZE, isPageSize, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { SearchBox } from "@/components/search/search-box"
import { SearchTypeTabs } from "@/components/search/search-type-tabs"
import { RememberQuery, SearchGroupCard, SearchTypeList } from "@/components/search/search-results"
import { RecentSearches } from "@/components/search/recent-searches"

export const metadata: Metadata = { title: "Search" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/search:${source}`, userId }) }
  }
}

/**
 * Search results (§7.18): "Where is it?" Everything the person may see that matches, grouped by
 * type with each group's total (All), or one type in full, paged on the server (`?type=`). The
 * palette's "See all N results" lands here. With no query: the person's recent searches. RLS decides
 * what each person finds; an Employee never sees leads, invoices or quotations (§4.1).
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const q = normaliseQuery(readParam(sp, "q"))
  const allowed = searchTypesFor(user.role)
  const rawType = readParam(sp, "type")
  const type: SearchType | null = rawType && isSearchType(rawType) && allowed.includes(rawType) ? rawType : null
  const pageRaw = Number.parseInt(readParam(sp, "page") ?? "1", 10)
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 4000) : 1
  const sizeRaw = Number.parseInt(readParam(sp, "size") ?? "", 10)
  const pageSize = isPageSize(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE
  const searching = q.length >= SEARCH_MIN_LENGTH

  const placeholder =
    user.role === "employee"
      ? "Your clients, tasks, documents and contacts"
      : "Clients, contacts, tasks, documents, people, leads, invoices, quotations"

  const [overview, list, recent] = await Promise.all([
    searching ? attempt("overview", user.id, () => searchEverything(supabase, user.role, q, { limit: type ? 1 : PAGE_GROUP_ITEMS })) : Promise.resolve(null),
    searching && type ? attempt("type", user.id, () => searchEverything(supabase, user.role, q, { limit: pageSize, types: [type], offset: (page - 1) * pageSize })) : Promise.resolve(null),
    searching ? Promise.resolve(null) : attempt("recent", user.id, () => listRecentSearches(supabase, user.id, 10)),
  ])

  const groups = overview?.ok ? overview.data.groups : []
  const counts = allowed.map((t) => ({ type: t, total: groups.find((g) => g.type === t)?.total ?? 0 }))
  const total = counts.reduce((n, c) => n + c.total, 0)
  const typeGroup = list?.ok ? list.data.groups.find((g) => g.type === type) : undefined

  const description = !searching
    ? user.role === "employee"
      ? "Find any of your clients' records by name, code, PAN, GSTIN, task number or document title."
      : "Find any record by name, code, PAN, GSTIN, phone, task, invoice or quotation number."
    : overview?.ok
      ? `${formatNumber(total)} ${total === 1 ? "result" : "results"} for “${q}”`
      : `Results for “${q}”`

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageGuide title="Search">
        <p>Search looks through everything you can open: {allowed.map((t) => `${SEARCH_TYPE_LABEL[t].many.toLowerCase()} (${SEARCH_TYPE_FIELDS[t]})`).join("; ")}.</p>
        <p className="mt-2">Phone numbers match on their digits, so “97405 40239” finds “+91 97405 40239”. Exact codes and numbers come first. Press ⌘K (Ctrl K) anywhere to search without leaving the page.</p>
        <p className="mt-2">Your recent searches are kept for you alone. Remove one with its cross, or clear them all.</p>
      </PageGuide>
      <PageHeader title="Search" description={description} className="pb-0 md:pb-0" />
      <SearchBox placeholder={placeholder} />
      <RememberQuery q={q} />

      {!searching && q.length > 0 ? (
        // A query too short to search: say so, rather than show the recent list as if it were the answer.
        <p className="text-sm text-text-muted">
          Type at least {SEARCH_MIN_LENGTH} characters to search. Your recent searches are below.
        </p>
      ) : null}

      {!searching ? (
        recent?.ok ? (
          <RecentSearches searches={recent.data} />
        ) : recent ? (
          <div className="rounded-lg border border-border bg-surface md:max-w-2xl">
            <ErrorBlock message="Couldn't load your recent searches." errorRef={recent.ref} />
          </div>
        ) : null
      ) : !overview?.ok ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Search didn't go through." errorRef={overview?.ok === false ? overview.ref : null} />
        </div>
      ) : (
        <>
          <SearchTypeTabs q={q} active={type} counts={counts} />
          {total === 0 ? (
            <NoResults q={q} role={user.role} />
          ) : type ? (
            list?.ok && typeGroup && typeGroup.total > 0 ? (
              <SearchTypeList q={q} type={type} total={typeGroup.total} items={typeGroup.items} page={page} pageSize={pageSize} />
            ) : list?.ok ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-6 py-12 text-center">
                <SearchXIcon aria-hidden="true" className="size-5 text-text-muted" />
                <p className="text-base text-text">
                  No {SEARCH_TYPE_LABEL[type].many.toLowerCase()} match “{q}”.
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/search?${new URLSearchParams({ q }).toString()}`}>Show every type</Link>
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-surface">
                <ErrorBlock message={`Couldn't load the ${SEARCH_TYPE_LABEL[type].many.toLowerCase()}.`} errorRef={list?.ok === false ? list.ref : null} />
              </div>
            )
          ) : (
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              {groups
                .filter((g) => g.total > 0)
                .map((g) => (
                  <SearchGroupCard key={g.type} q={q} type={g.type} total={g.total} items={g.items} />
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function NoResults({ q, role }: { q: string; role: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-6 py-12 text-center">
      <SearchXIcon aria-hidden="true" className="size-5 text-text-muted" />
      <p className="text-base text-text">No results for “{q}”.</p>
      <p className="max-w-[52ch] text-sm text-balance text-text-muted">
        {role === "employee"
          ? "Search covers the clients you own, work on or cover. Check the spelling, or try the client code, PAN, GSTIN or task number."
          : "Check the spelling, or try the client code, PAN, GSTIN, a phone number, or a task, invoice or quotation number."}
      </p>
    </div>
  )
}

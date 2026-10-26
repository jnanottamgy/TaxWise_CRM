"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowRightIcon } from "lucide-react"
import { formatNumber } from "@/lib/format"
import { SEARCH_TYPE_LABEL, type SearchType } from "@/lib/schemas/search"
import { rememberSearch } from "@/server/actions/search-history"
import { TablePagination } from "@/components/app/data-table/pagination"
import { SearchTypeIcon } from "@/components/search/search-type-icon"

export type SearchItemView = { id: string; title: string; subtitle: string | null; href: string }

/** Keeps the query in the person's recent searches when they open a result (§7.18). Never blocks the navigation. */
function useRememberOnOpen(q: string) {
  return React.useCallback(() => {
    if (q.trim().length >= 2) void rememberSearch({ query: q }).catch(() => undefined)
  }, [q])
}

function ResultRow({ type, item, onOpen }: { type: SearchType; item: SearchItemView; onOpen: () => void }) {
  return (
    <li>
      <Link
        href={item.href}
        onClick={onOpen}
        className="flex min-h-12 items-center gap-3 px-4 py-2 transition-colors duration-150 outline-none hover:bg-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 pointer-coarse:min-h-14"
      >
        <SearchTypeIcon type={type} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base text-text">{item.title}</span>
          {item.subtitle ? <span className="truncate text-sm text-text-muted">{item.subtitle}</span> : null}
        </span>
      </Link>
    </li>
  )
}

/**
 * One type's best matches on the All tab: the type and its total in the header, the rows, and "Show
 * all N" to that type's own paged list when there are more.
 */
export function SearchGroupCard({ q, type, total, items }: { q: string; type: SearchType; total: number; items: SearchItemView[] }) {
  const onOpen = useRememberOnOpen(q)
  const label = SEARCH_TYPE_LABEL[type].many
  const more = new URLSearchParams({ q, type }).toString()
  return (
    <section aria-labelledby={`search-${type}`} className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-2 md:px-5">
        <h2 id={`search-${type}`} className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
          {label}
        </h2>
        <span className="num text-sm text-text-muted tabular-nums">
          {total > items.length ? `${formatNumber(items.length)} of ${formatNumber(total)}` : formatNumber(total)}
        </span>
      </div>
      <ul className="divide-y divide-border/70 border-t border-border/70">
        {items.map((item) => (
          <ResultRow key={item.id} type={type} item={item} onOpen={onOpen} />
        ))}
      </ul>
      {total > items.length ? (
        <div className="border-t border-border">
          <Link
            href={`/search?${more}`}
            scroll={false}
            className="flex min-h-10 items-center justify-between gap-2 rounded-b-lg px-4 text-sm font-medium text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 pointer-coarse:min-h-11"
          >
            <span>
              Show all <span className="num">{formatNumber(total)}</span> {label.toLowerCase()}
            </span>
            <ArrowRightIcon aria-hidden="true" className="size-4 text-text-muted" />
          </Link>
        </div>
      ) : null}
    </section>
  )
}

/** One type's full list, paged on the server (25/50/100), with the range shown. */
export function SearchTypeList({
  q,
  type,
  total,
  items,
  page,
  pageSize,
}: {
  q: string
  type: SearchType
  total: number
  items: SearchItemView[]
  page: number
  pageSize: number
}) {
  const onOpen = useRememberOnOpen(q)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const navigate = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: true }))
  }
  return (
    <section aria-label={SEARCH_TYPE_LABEL[type].many} aria-busy={pending || undefined} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      <ul className={pending ? "divide-y divide-border/70 opacity-60" : "divide-y divide-border/70"}>
        {items.map((item) => (
          <ResultRow key={item.id} type={type} item={item} onOpen={onOpen} />
        ))}
      </ul>
      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        disabled={pending}
        onPage={(p) => navigate({ page: p > 1 ? String(p) : null })}
        onPageSize={(s) => navigate({ size: s === 25 ? null : String(s), page: null })}
      />
    </section>
  )
}

/**
 * Remembers the query the person arrived with (the palette's "See all", a shared link), once. What
 * they type on the page afterwards is remembered when they press Enter or open a result, so the
 * half-typed steps in between never fill the list.
 */
export function RememberQuery({ q }: { q: string }) {
  const arrivedWith = React.useRef(q)
  React.useEffect(() => {
    const first = arrivedWith.current
    if (first.trim().length >= 2) void rememberSearch({ query: first }).catch(() => undefined)
  }, [])
  return null
}

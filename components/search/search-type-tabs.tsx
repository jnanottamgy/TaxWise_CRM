import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/format"
import { SEARCH_TYPE_LABEL, type SearchType } from "@/lib/schemas/search"

/**
 * The result types as underline tabs with their counts (§7.18 "full results page with filters"):
 * All, then each type the person may search that matched. Each is a link (`?type=`), keeping the
 * query and starting at page 1; the row scrolls inside itself on a phone. Server-safe.
 */
export function SearchTypeTabs({
  q,
  active,
  counts,
}: {
  q: string
  active: SearchType | null
  counts: Array<{ type: SearchType; total: number }>
}) {
  const all = counts.reduce((n, c) => n + c.total, 0)
  const href = (type: SearchType | null) => {
    const p = new URLSearchParams({ q })
    if (type) p.set("type", type)
    return `/search?${p.toString()}`
  }
  const items: Array<{ id: SearchType | null; label: string; total: number }> = [
    { id: null, label: "All", total: all },
    ...counts.filter((c) => c.total > 0 || c.type === active).map((c) => ({ id: c.type, label: SEARCH_TYPE_LABEL[c.type].many, total: c.total })),
  ]
  return (
    <nav aria-label="Result types" className="-mx-4 overflow-x-auto border-b border-border px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max items-end gap-5">
        {items.map((it) => {
          const on = it.id === active
          return (
            <li key={it.id ?? "all"}>
              <Link
                href={href(it.id)}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text"
                )}
              >
                {it.label}
                <span className="num font-normal text-text-muted tabular-nums">{formatNumber(it.total)}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

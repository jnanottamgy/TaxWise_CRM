"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { HistoryIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { formatTimeAgo } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { clearRecentSearches, removeRecentSearch } from "@/server/actions/search-history"

export type RecentSearchView = { id: string; query: string; searchedAt: string }

/**
 * The person's recent searches (§7.18), newest first: each opens its results; one can be dropped, or
 * the whole list cleared. Kept per person in recent_searches; nobody else sees them.
 */
export function RecentSearches({ searches }: { searches: RecentSearchView[] }) {
  const router = useRouter()
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set())
  const [pending, startTransition] = React.useTransition()
  const visible = searches.filter((s) => !hidden.has(s.id))

  const remove = async (id: string) => {
    setHidden((h) => new Set(h).add(id))
    const r = await removeRecentSearch({ id })
    if (!r.ok) {
      setHidden((h) => {
        const n = new Set(h)
        n.delete(id)
        return n
      })
      toast.error(r.error)
    }
  }

  const clearAll = async () => {
    const before = hidden
    setHidden(new Set(searches.map((s) => s.id)))
    const r = await clearRecentSearches({})
    if (!r.ok) {
      setHidden(before)
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <section aria-labelledby="recent-searches" className="min-w-0 rounded-lg border border-border bg-surface md:max-w-2xl">
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2 md:px-5">
        <h2 id="recent-searches" className="text-md leading-6 font-semibold text-text">
          Recent searches
        </h2>
        {visible.length > 0 ? (
          <Button variant="ghost" size="sm" className="text-text-muted" onClick={clearAll} disabled={pending}>
            Clear history
          </Button>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" icon={<HistoryIcon />} message="Your searches will be kept here, just for you." />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {visible.map((s) => (
            <li key={s.id} className="flex items-center gap-2 pr-2">
              <Link
                href={`/search?${new URLSearchParams({ q: s.query }).toString()}`}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 transition-colors duration-150 outline-none hover:bg-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
              >
                <HistoryIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
                <span className="min-w-0 flex-1 truncate text-base text-text">{s.query}</span>
                <span className="flex-none text-sm text-text-muted">{formatTimeAgo(s.searchedAt)}</span>
              </Link>
              <button
                type="button"
                aria-label={`Remove “${s.query}” from your recent searches`}
                onClick={() => void remove(s.id)}
                className="inline-flex size-9 flex-none items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

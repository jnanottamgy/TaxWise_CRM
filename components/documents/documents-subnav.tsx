import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/format"
import type { DocumentSubtab } from "@/lib/schemas/documents"
import { documentsHref } from "@/components/documents/doc-urls"

export interface SubnavCounts {
  documents: number | null
  openRequests: number | null
  toReview: number | null
  checklist: { collected: number; total: number } | null
}

/**
 * The Documents tab's three views (§7.3.3 tab 6: vault, document requests, checklist) as a segmented
 * control of links, each with its count, so the second row reads differently from the Client 360 tab
 * row above it. Scrolls inside itself on a phone. Server-safe.
 */
export function DocumentsSubnav({ clientId, active, counts, className }: { clientId: string; active: DocumentSubtab; counts: SubnavCounts; className?: string }) {
  const items: Array<{ id: DocumentSubtab; label: string; meta: string | null; attention?: boolean }> = [
    { id: "vault", label: "Vault", meta: counts.documents === null ? null : formatNumber(counts.documents) },
    {
      id: "requests",
      label: "Requests",
      meta: counts.toReview ? `${formatNumber(counts.toReview)} to review` : counts.openRequests ? `${formatNumber(counts.openRequests)} open` : null,
      attention: Boolean(counts.toReview),
    },
    { id: "checklist", label: "Checklist", meta: counts.checklist && counts.checklist.total ? `${counts.checklist.collected}/${counts.checklist.total}` : null },
  ]
  return (
    <nav aria-label="Documents views" className={cn("-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0", className)}>
      <ul className="inline-flex min-w-max items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
        {items.map((it) => {
          const on = it.id === active
          return (
            <li key={it.id}>
              <Link
                href={documentsHref(clientId, { docs: it.id === "vault" ? null : it.id })}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                  on ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text"
                )}
              >
                {it.label}
                {it.meta ? <span className={cn("num font-normal tabular-nums", it.attention ? "text-info-text" : "text-text-muted")}>{it.meta}</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

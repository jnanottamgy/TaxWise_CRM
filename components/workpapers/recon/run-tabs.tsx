import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatCount } from "@/components/app/data-table/params"
import { RUN_TABS, RUN_TAB_LABELS, type RunTab } from "@/lib/schemas/gst-recon"

/**
 * The tabs of a reconciliation run (§7.8.1 "tabs per bucket"): underline tabs, each a link
 * (`?tab=`), so a tab is shareable and the server loads only the open one; the count beside each
 * is its number of lines. Server-safe.
 */
export function RunTabs({ runId, active, counts }: { runId: string; active: RunTab; counts: Partial<Record<RunTab, number>> }) {
  return (
    <nav aria-label="Reconciliation" className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0">
      <ul className="flex min-w-max items-center gap-0.5 border-b border-border">
        {RUN_TABS.map((t) => {
          const on = t === active
          const n = counts[t]
          return (
            <li key={t}>
              <Link
                href={t === "summary" ? `/workpapers/gst-recon/${runId}` : `/workpapers/gst-recon/${runId}?tab=${t}`}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text",
                )}
              >
                {RUN_TAB_LABELS[t]}
                {n !== undefined ? <span className={cn("num text-xs tabular-nums", on ? "text-text-muted" : "text-text-muted/80")}>{formatCount(n)}</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

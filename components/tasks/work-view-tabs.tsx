import Link from "next/link"
import { CalendarDaysIcon, ClipboardCheckIcon, KanbanSquareIcon, TableIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/format"
import type { WorkView } from "@/lib/schemas/tasks"

/**
 * The tracker's four views (§7.6.1): Table, Board, Calendar and My review queue, as a segmented row
 * of links that keep the filters (the review queue has its own rule, so its filters reset paging
 * only). Scrolls inside itself on a phone. Server-safe.
 */
export function WorkViewTabs({ active, params, reviewCount }: { active: WorkView; params: URLSearchParams; reviewCount: number | null }) {
  const href = (view: WorkView) => {
    const p = new URLSearchParams(params.toString())
    p.delete("page")
    p.delete("month")
    if (view === "table") p.delete("view")
    else p.set("view", view)
    const qs = p.toString()
    return qs ? `/work?${qs}` : "/work?view=table"
  }
  const items: Array<{ id: WorkView; label: string; icon: React.ReactNode; meta?: string | null }> = [
    { id: "table", label: "Table", icon: <TableIcon aria-hidden="true" className="size-4" /> },
    { id: "board", label: "Board", icon: <KanbanSquareIcon aria-hidden="true" className="size-4" /> },
    { id: "calendar", label: "Calendar", icon: <CalendarDaysIcon aria-hidden="true" className="size-4" /> },
    { id: "review", label: "My review queue", icon: <ClipboardCheckIcon aria-hidden="true" className="size-4" />, meta: reviewCount ? formatNumber(reviewCount) : null },
  ]
  return (
    <nav aria-label="Work tracker views" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="inline-flex min-w-max items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
        {items.map((it) => {
          const on = it.id === active
          return (
            <li key={it.id}>
              <Link
                href={href(it.id)}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                  on ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
                )}
              >
                <span className="text-text-muted">{it.icon}</span>
                {it.label}
                {it.meta ? <span className="num rounded-full bg-violet-soft px-1.5 text-xs font-medium text-violet-text tabular-nums">{it.meta}</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

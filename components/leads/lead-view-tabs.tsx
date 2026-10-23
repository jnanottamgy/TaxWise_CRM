import Link from "next/link"
import { ChartColumnIcon, KanbanSquareIcon, TableIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { LeadView } from "@/lib/schemas/leads"

/**
 * Leads' three views (§7.5.1): the pipeline board, the table and the analytics, as a segmented row
 * of links that keep the search and filters (the analytics keep only the period). Server-safe.
 */
export function LeadViewTabs({ active, params }: { active: LeadView; params: URLSearchParams }) {
  const href = (view: LeadView) => {
    const p = new URLSearchParams(params.toString())
    p.delete("page")
    if (view === "analytics") {
      for (const k of [...p.keys()]) if (!["period", "from", "to"].includes(k)) p.delete(k)
      p.set("view", "analytics")
    } else {
      p.delete("period")
      p.delete("from")
      p.delete("to")
      if (view === "board") p.delete("view")
      else p.set("view", view)
    }
    const qs = p.toString()
    return qs ? `/leads?${qs}` : "/leads"
  }
  const items: Array<{ id: LeadView; label: string; icon: React.ReactNode }> = [
    { id: "board", label: "Pipeline", icon: <KanbanSquareIcon aria-hidden="true" className="size-4" /> },
    { id: "table", label: "Table", icon: <TableIcon aria-hidden="true" className="size-4" /> },
    { id: "analytics", label: "Analytics", icon: <ChartColumnIcon aria-hidden="true" className="size-4" /> },
  ]
  return (
    <nav aria-label="Lead views" className="relative -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
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
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

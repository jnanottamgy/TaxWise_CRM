import Link from "next/link"
import { cn } from "@/lib/utils"

/**
 * The views of a portal list as links (?view=, ?show=): a neutral segmented row (the active one a
 * grey pill, never the brand colour, DESIGN.md §3), scrolling sideways inside its own row on a phone.
 * Each view is a real URL, so Back and sharing work. Server-safe.
 */
export interface ViewTab {
  href: string
  label: string
  count?: number | null
  active: boolean
}

export function ViewTabs({ items, label, className }: { items: ViewTab[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("-mx-1 overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      <ul className="inline-flex min-w-max items-center gap-1 rounded-lg border border-border bg-surface p-1">
        {items.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              scroll={false}
              aria-current={t.active ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring pointer-coarse:h-10",
                t.active ? "bg-surface-2 font-medium text-text" : "text-text-muted hover:text-text"
              )}
            >
              {t.label}
              {typeof t.count === "number" ? <span className="num text-xs text-text-muted tabular-nums">{t.count.toLocaleString("en-IN")}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

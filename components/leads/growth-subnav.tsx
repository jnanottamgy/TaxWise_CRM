import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/format"

export type GrowthSection = "leads" | "quotations" | "acceptance"

/**
 * The Growth area's three pages (§4.2 "Growth: Leads & quotations"; §7.5): Leads, Quotations and the
 * client acceptance register, as a segmented row of links with a count that needs someone (follow-ups
 * due, quotations waiting for approval, checks pending a decision). Scrolls inside itself on a
 * phone. Server-safe.
 */
export function GrowthSubnav({
  active,
  counts,
  className,
}: {
  active: GrowthSection
  counts?: Partial<Record<GrowthSection, { n: number; label: string } | null>>
  className?: string
}) {
  const items: Array<{ id: GrowthSection; label: string; href: string }> = [
    { id: "leads", label: "Leads", href: "/leads" },
    { id: "quotations", label: "Quotations", href: "/quotations" },
    { id: "acceptance", label: "Client acceptance", href: "/acceptance" },
  ]
  return (
    <nav aria-label="Leads, quotations and client acceptance" className={cn("relative -mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0", className)}>
      <ul className="inline-flex min-w-max items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
        {items.map((it) => {
          const on = it.id === active
          const c = counts?.[it.id]
          return (
            <li key={it.id}>
              <Link
                href={it.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                  on ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
                )}
              >
                {it.label}
                {c && c.n > 0 ? (
                  <span className="num font-normal text-info-text tabular-nums" title={c.label}>
                    {formatNumber(c.n)}
                    <span className="sr-only"> {c.label}</span>
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

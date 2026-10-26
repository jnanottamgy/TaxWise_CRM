import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/format"

export type GrowthSection = "leads" | "quotations" | "acceptance"

/**
 * The Growth area's three pages (§4.2 "Growth: Leads & quotations"; §7.5): Leads, Quotations and the
 * client acceptance register, with a count where something needs someone (follow-ups due, quotations
 * waiting for approval, checks pending a decision). Like the workpapers row, it is navigation between
 * sibling pages, so it is a quiet row of links (the open one in ink), not a second segmented control
 * above the page's own view switch. Scrolls inside itself on a phone. Server-safe.
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
    <nav aria-label="Leads, quotations and client acceptance" className={cn("-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0", className)}>
      <ul className="flex min-w-max items-center gap-x-5 text-sm">
        {items.map((it) => {
          const on = it.id === active
          const c = counts?.[it.id]
          return (
            <li key={it.id}>
              <Link
                href={it.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-sm whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "font-medium text-text" : "text-text-muted hover:text-text",
                )}
              >
                {it.label}
                {c && c.n > 0 ? (
                  <span className="num rounded-full bg-primary-soft px-1.5 text-xs leading-5 font-medium text-primary tabular-nums" title={c.label}>
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

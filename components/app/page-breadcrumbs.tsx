"use client"

import Link from "next/link"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useOptionalShell } from "@/components/shell/shell-context"
import type { Crumb } from "@/components/app/page-header"

/**
 * PageHeader's breadcrumbs. In the staff shell the top bar already shows the breadcrumb from md up
 * (§3.3 "Top bar: page title and breadcrumb"), so here they show on phones only, where the top bar
 * has room for the page name alone. Elsewhere (the portal, no shell) they always show.
 */
export function PageBreadcrumbs({ items }: { items: Crumb[] }) {
  const shell = useOptionalShell()
  return <Breadcrumbs items={items} className={shell ? "md:hidden" : undefined} />
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-text-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {c.href && !last ? (
                <Link
                  href={c.href}
                  className="truncate rounded-sm hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn("truncate", last && "text-text")}>
                  {c.label}
                </span>
              )}
              {!last ? <ChevronRightIcon aria-hidden="true" className="size-3.5 flex-none" /> : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

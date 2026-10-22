"use client"

import Link from "next/link"
import { useSelectedLayoutSegment } from "next/navigation"
import { cn } from "@/lib/utils"
import { SETTINGS_SECTIONS } from "@/lib/schemas/settings"

/**
 * The settings section list (§7.21). One view per section (taste §8.2): each link opens its own
 * page with the section's name as the h1. A vertical list beside the content on wide screens; a
 * row that scrolls sideways inside itself on narrow ones (never the page).
 */
export function SettingsNav() {
  const active = useSelectedLayoutSegment()
  const groups = SETTINGS_SECTIONS.reduce<Array<{ group: string; items: Array<(typeof SETTINGS_SECTIONS)[number]> }>>((acc, s) => {
    const last = acc[acc.length - 1]
    if (last && last.group === s.group) last.items.push(s)
    else acc.push({ group: s.group, items: [s] })
    return acc
  }, [])

  return (
    <nav aria-label="Settings sections" className="min-w-0">
      {/* Wide screens: grouped vertical list */}
      <div className="hidden lg:flex lg:flex-col lg:gap-5">
        {groups.map((g) => (
          <div key={g.group} className="flex flex-col gap-0.5">
            <p className="px-3 pb-1 text-xs font-medium text-text-muted">{g.group}</p>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((s) => {
                const current = active === s.slug
                return (
                  <li key={s.slug}>
                    <Link
                      href={`/settings/${s.slug}`}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex h-8 items-center rounded-md px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        current ? "bg-primary-soft font-medium text-primary" : "text-text hover:bg-surface-2"
                      )}
                    >
                      {s.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* Narrow screens: one row that scrolls inside itself */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:thin] md:-mx-6 md:px-6 lg:hidden">
        <ul className="flex w-max gap-1">
          {SETTINGS_SECTIONS.map((s) => {
            const current = active === s.slug
            return (
              <li key={s.slug}>
                <Link
                  href={`/settings/${s.slug}`}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex h-9 items-center rounded-md px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                    current ? "bg-primary-soft font-medium text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text"
                  )}
                >
                  {s.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}

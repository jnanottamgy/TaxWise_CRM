"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AppRole } from "@/lib/auth/roles"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { tabHref, visibleTabs, type ClientTabId } from "@/components/client360/logic/tabs"

const TAB_CLASS =
  "relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11"

/** Tablets and desktops fold the tabs that don't fit into "More"; phones scroll the row instead. */
const FOLD_QUERY = "(min-width: 768px)"

/**
 * The Client 360 tab row (§7.3.3): underline tabs on a full-width 1px rule (taste §4.4), one per
 * tab this role may see, in spec order. Each tab is a link (`?tab=`), so tabs are shareable and the
 * server loads only the open one.
 *
 * Thirteen tabs don't fit a 1366px screen beside the sidebar, so from 768px up the tabs that don't
 * fit move into a "More" menu at the end of the row (the open tab always stays in the row). The
 * widths come from an invisible copy of the row, measured whenever the row's width changes. On
 * phones the row scrolls sideways inside itself, never the page (taste §12), with the open tab
 * scrolled into view. Before hydration, and without JavaScript, every tab is in the scrolling row.
 */
export function ClientTabNav({ clientId, role, active, className }: { clientId: string; role: AppRole; active: ClientTabId; className?: string }) {
  const tabs = visibleTabs(role)
  const navRef = React.useRef<HTMLElement>(null)
  const measureRef = React.useRef<HTMLUListElement>(null)
  // How many tabs stay in the row; null = all of them (not measured yet, a phone, or they all fit).
  const [fit, setFit] = React.useState<number | null>(null)

  React.useEffect(() => {
    const nav = navRef.current
    const measure = measureRef.current
    if (!nav || !measure || typeof ResizeObserver === "undefined") return
    const mq = window.matchMedia(FOLD_QUERY)
    const compute = () => {
      if (!mq.matches) {
        setFit(null)
        // Phones: bring the open tab into view inside the scrolling row (not the page).
        const current = nav.querySelector<HTMLElement>('[aria-current="page"]')
        if (current) {
          const left = current.offsetLeft - 16
          const right = current.offsetLeft + current.offsetWidth + 16
          if (left < nav.scrollLeft || right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, left)
        }
        return
      }
      const items = Array.from(measure.children) as HTMLElement[]
      const more = items.pop()
      const widths = items.map((el) => el.getBoundingClientRect().width)
      const avail = nav.clientWidth
      const total = widths.reduce((a, b) => a + b, 0)
      if (total <= avail) {
        setFit(null)
        return
      }
      let used = more ? more.getBoundingClientRect().width : 0
      let n = 0
      for (const w of widths) {
        if (used + w > avail) break
        used += w
        n += 1
      }
      setFit(Math.max(1, n))
    }
    const ro = new ResizeObserver(compute)
    ro.observe(nav)
    mq.addEventListener("change", compute)
    return () => {
      ro.disconnect()
      mq.removeEventListener("change", compute)
    }
  }, [tabs.length, active])

  let shown = tabs
  let folded: typeof tabs = []
  if (fit !== null && fit < tabs.length) {
    const activeIndex = tabs.findIndex((t) => t.id === active)
    if (activeIndex < fit) {
      shown = tabs.slice(0, fit)
    } else {
      // Keep the open tab in the row: it takes the last place, the one before it moves to More.
      shown = [...tabs.slice(0, Math.max(0, fit - 1)), tabs[activeIndex]]
    }
    const kept = new Set(shown.map((t) => t.id))
    folded = tabs.filter((t) => !kept.has(t.id))
  }

  return (
    <nav ref={navRef} aria-label="Client sections" className={cn("relative -mx-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0", className)}>
      <ul className="flex w-max min-w-full items-center border-b border-border">
        {shown.map((t) => {
          const on = t.id === active
          return (
            <li key={t.id} className="flex-none">
              <Link
                href={tabHref(clientId, t.id)}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(TAB_CLASS, on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text")}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
        {folded.length ? (
          <li className="flex-none">
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(TAB_CLASS, "cursor-pointer gap-1 border-transparent text-text-muted hover:text-text data-[state=open]:text-text")}>
                More
                <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">: {folded.map((t) => t.label).join(", ")}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {folded.map((t) => (
                  <DropdownMenuItem key={t.id} asChild>
                    <Link href={tabHref(clientId, t.id)} scroll={false} prefetch={false}>
                      {t.label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ) : null}
      </ul>
      {/* The measuring copy: every tab plus "More", invisible and clipped so it never scrolls the row. */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <ul ref={measureRef} className="flex w-max">
          {tabs.map((t) => (
            <li key={t.id} className={cn(TAB_CLASS, "border-transparent")}>
              {t.label}
            </li>
          ))}
          <li className={cn(TAB_CLASS, "gap-1 border-transparent")}>
            More
            <ChevronDownIcon className="size-3.5" />
          </li>
        </ul>
      </div>
    </nav>
  )
}

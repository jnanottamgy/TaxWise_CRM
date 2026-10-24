"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

/** The four workpapers (§4.2 "Workpapers: GST reconciliation · ITR computation · Financial statements · Notices"). */
export const WORKPAPER_LINKS = [
  { href: "/workpapers/gst-recon", label: "GST reconciliation" },
  { href: "/workpapers/itr", label: "ITR computation" },
  { href: "/workpapers/financial-statements", label: "Financial statements" },
  { href: "/workpapers/notices", label: "Notices" },
] as const

/**
 * The quiet link row above every workpaper page: the four workpapers, the open one in ink. It is
 * navigation between sibling pages, not a set of tabs inside one page, so it carries no fill and no
 * accent (DESIGN.md §3); the pages' own tabs sit below it. Scrolls sideways on a phone.
 */
export function WorkpapersNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? ""
  return (
    <nav aria-label="Workpapers" className={cn("-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0", className)}>
      <ul className="flex min-w-max items-center gap-x-5 text-sm">
        {WORKPAPER_LINKS.map((l) => {
          const on = pathname === l.href || pathname.startsWith(`${l.href}/`)
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-sm whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "font-medium text-text" : "text-text-muted hover:text-text",
                )}
              >
                {l.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

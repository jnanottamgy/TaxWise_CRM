"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { SearchXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Params kept when filters are cleared: the view itself, not what narrows it. */
const DEFAULT_PRESERVE = ["tab", "view", "sort", "dir", "size", "fy"]

/**
 * A list that is empty because of its filters (§3.4): "No results for these filters" and Clear
 * filters. Clearing removes the search and every filter from the URL but keeps the tab, view, sort,
 * page size and financial year. Pass `onClear` to do something else.
 *
 *   <FilteredEmpty />
 *   <FilteredEmpty message="No invoices match “Sharma” in FY 2026-27." />
 */
export function FilteredEmpty({
  message = "No results for these filters.",
  onClear,
  preserve = DEFAULT_PRESERVE,
  className,
}: {
  message?: React.ReactNode
  onClear?: () => void
  /** Search params to keep when clearing. */
  preserve?: readonly string[]
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  const clear = () => {
    if (onClear) return onClear()
    const next = new URLSearchParams()
    searchParams.forEach((v, k) => {
      if (preserve.includes(k)) next.append(k, v)
    })
    const qs = next.toString()
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  return (
    <div
      data-slot="filtered-empty"
      className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}
    >
      <SearchXIcon aria-hidden="true" className="size-5 text-text-muted" />
      <p className="text-base text-text">{message}</p>
      <Button variant="outline" size="sm" onClick={clear} disabled={pending}>
        Clear filters
      </Button>
    </div>
  )
}

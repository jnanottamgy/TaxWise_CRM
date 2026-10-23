"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { GRID_RETURN_TYPES, type ReturnTypeGroup } from "@/lib/schemas/compliance"
import { withParams } from "@/components/compliance/logic/urls"

/**
 * The two choices that define the filings grid (§7.7): the return type (grouped GST · Income tax ·
 * TDS · ROC · Payroll) and the financial year (defaults to the top bar's FY; kept in `?fy=` so a
 * view can be shared). Changing either starts at page 1 and drops the chosen period.
 */
export function GridControls({ type, fy, fyOptions, currentFy }: { type: string; fy: string; fyOptions: string[]; currentFy: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const go = (patch: Record<string, string | null>) =>
    startTransition(() => router.push(withParams(pathname, sp, { ...patch, period: null }, { resetPage: true }), { scroll: false }))

  const groups = GRID_RETURN_TYPES.reduce<Array<{ group: ReturnTypeGroup; items: typeof GRID_RETURN_TYPES[number][] }>>((acc, t) => {
    const g = acc.find((x) => x.group === t.group)
    if (g) g.items.push(t)
    else acc.push({ group: t.group, items: [t] })
    return acc
  }, [])

  return (
    <div className="flex flex-wrap items-end gap-3 pb-3" aria-busy={pending}>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="grid-return" className="text-sm font-medium text-text">
          Return
        </label>
        <Select value={type} onValueChange={(v) => go({ type: v })}>
          <SelectTrigger id="grid-return" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-80">
            {groups.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel className="text-xs text-text-muted">{g.group}</SelectLabel>
                {g.items.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="grid-fy" className="text-sm font-medium text-text">
          Financial year
        </label>
        <Select value={fy} onValueChange={(v) => go({ fy: v })}>
          <SelectTrigger id="grid-fy" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {fyOptions.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
                {o === currentFy ? " (current)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

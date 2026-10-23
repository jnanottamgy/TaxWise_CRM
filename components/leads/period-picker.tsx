"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ANALYTICS_PRESETS, ANALYTICS_PRESET_LABELS, type AnalyticsPreset } from "@/lib/schemas/leads"

/**
 * The analytics period: This FY (the one chosen in the top bar), Last FY, the last 90 or 30 days,
 * or a custom range, kept in the URL (`?period=` or `?from=&to=`) so a view can be shared.
 */
export function PeriodPicker({ preset, from, to }: { preset: AnalyticsPreset; from: string; to: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [custom, setCustom] = React.useState(preset === "custom")
  const [range, setRange] = React.useState({ from, to })
  const [pending, startTransition] = React.useTransition()
  const fromId = React.useId()
  const toId = React.useId()

  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    startTransition(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }))
  }

  return (
    <div className="flex flex-col gap-2 pb-3 md:flex-row md:flex-wrap md:items-end" aria-busy={pending || undefined}>
      <div role="radiogroup" aria-label="Period" className="relative -mx-4 flex overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="inline-flex min-w-max items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
          {ANALYTICS_PRESETS.map((p) => {
            const on = custom ? p === "custom" : p === preset
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  if (p === "custom") {
                    setCustom(true)
                    return
                  }
                  setCustom(false)
                  go({ period: p === "fy" ? null : p, from: null, to: null })
                }}
                className={cn(
                  "inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                  on ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
                )}
              >
                {ANALYTICS_PRESET_LABELS[p]}
              </button>
            )
          })}
        </div>
      </div>
      {custom ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!range.from || !range.to || range.from > range.to) return
            go({ period: null, from: range.from, to: range.to })
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={fromId} className="text-sm font-medium text-text">
              From
            </label>
            <Input id={fromId} type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="num h-9 w-40 tabular-nums" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={toId} className="text-sm font-medium text-text">
              To
            </label>
            <Input id={toId} type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="num h-9 w-40 tabular-nums" />
          </div>
          <Button type="submit" variant="outline" size="sm" className="h-9" disabled={!range.from || !range.to || range.from > range.to}>
            Show
          </Button>
        </form>
      ) : null}
    </div>
  )
}

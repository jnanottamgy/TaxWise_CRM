"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { CalendarRangeIcon, ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/app/form/date-picker"
import { formatDateRange } from "@/lib/format"
import { compareDates, isDateString } from "@/lib/domain/fy"

export type PeriodPreset = { id: string; label: string; from: string; to: string }

/**
 * A period filter for a page's URL (`?from=YYYY-MM-DD&to=YYYY-MM-DD`): a chip that names the period,
 * opening a list of presets (this FY, last FY, this month …) and two dates for a custom range. Every
 * change resets the page to 1. "Clear" returns to the page's default period (`defaultLabel`).
 *
 *   <PeriodPicker from={from} to={to} presets={presets} defaultLabel="FY 2026-27" />
 */
export function PeriodPicker({
  from,
  to,
  presets,
  defaultLabel,
  isDefault,
  label = "Period",
  max,
  allowCustom = true,
  className,
}: {
  /** The period in force (default or chosen). */
  from: string
  to: string
  presets: PeriodPreset[]
  /** What the page shows when no period is chosen. */
  defaultLabel: string
  /** True when no `from`/`to` is in the URL. */
  isDefault: boolean
  label?: string
  /** Latest date that may be picked. */
  max?: string
  /** False for reports kept per FY: only the presets. */
  allowCustom?: boolean
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = React.useState(false)
  const [draftFrom, setDraftFrom] = React.useState(from)
  const [draftTo, setDraftTo] = React.useState(to)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  const apply = (next: { from: string; to: string } | null) => {
    const p = new URLSearchParams(searchParams.toString())
    p.delete("page")
    if (next) {
      p.set("from", next.from)
      p.set("to", next.to)
    } else {
      p.delete("from")
      p.delete("to")
    }
    const qs = p.toString()
    setOpen(false)
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  const active = presets.find((p) => p.from === from && p.to === to)
  const shown = isDefault ? defaultLabel : (active?.label ?? formatDateRange(from, to))

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setDraftFrom(from)
          setDraftTo(to)
          setError(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-busy={pending || undefined}
          className={cn("flex-none justify-between gap-1.5", !isDefault && "border-primary/40 bg-primary-soft text-text", className)}
        >
          <CalendarRangeIcon aria-hidden="true" className="text-text-muted" />
          <span className="text-text-muted">{label}</span>
          <span className="num max-w-[16rem] truncate font-medium">{shown}</span>
          <ChevronDownIcon aria-hidden="true" className="text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex flex-col gap-0.5 p-1.5" role="group" aria-label="Periods">
          {presets.map((p) => {
            const on = !isDefault && p.from === from && p.to === to
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => apply({ from: p.from, to: p.to })}
                aria-pressed={on}
                className={cn(
                  "flex min-h-9 items-center justify-between gap-3 rounded-md px-2.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11",
                  on ? "bg-primary-soft text-text" : "text-text"
                )}
              >
                <span>{p.label}</span>
                <span className="num text-xs text-text-muted">{formatDateRange(p.from, p.to)}</span>
              </button>
            )
          })}
        </div>
        {allowCustom ? (
          <form
            className="flex flex-col gap-3 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!isDateString(draftFrom) || !isDateString(draftTo)) return setError("Enter both dates.")
              if (compareDates(draftTo, draftFrom) < 0) return setError("The period has to end on or after the day it starts.")
              if (max && compareDates(draftTo, max) > 0) return setError("The period can't end in the future.")
              apply({ from: draftFrom, to: draftTo })
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="period-from" className="text-sm font-medium text-text">
                  From
                </label>
                <DatePicker id="period-from" value={draftFrom} onChange={setDraftFrom} max={max} />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="period-to" className="text-sm font-medium text-text">
                  To
                </label>
                <DatePicker id="period-to" value={draftTo} onChange={setDraftTo} max={max} />
              </div>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-danger-text">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" className="text-text-muted" disabled={isDefault} onClick={() => apply(null)}>
                Reset to {defaultLabel}
              </Button>
              <Button type="submit" size="sm">
                Apply
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex justify-end border-t border-border p-2">
            <Button type="button" variant="ghost" size="sm" className="text-text-muted" disabled={isDefault} onClick={() => apply(null)}>
              Reset to {defaultLabel}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

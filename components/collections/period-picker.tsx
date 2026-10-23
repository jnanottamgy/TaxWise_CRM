"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { CalendarRangeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DatePicker } from "@/components/app/form/date-picker"

/**
 * The period a report covers, as ?from=&to= in the URL (so it can be shared and Back works).
 * Presets (the financial year so far, this month, last month, each quarter of the FY) and a custom
 * range. Changing it goes back to the first page of the table.
 */

export type PeriodPreset = { id: string; label: string; from: string; to: string }

export function PeriodPicker({ from, to, presets, className }: { from: string; to: string; presets: PeriodPreset[]; className?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState({ from, to })
  const ids = { from: React.useId(), to: React.useId() }
  const active = presets.find((p) => p.from === from && p.to === to)

  const go = (range: { from: string; to: string }) => {
    const next = new URLSearchParams(sp.toString())
    next.set("from", range.from)
    next.set("to", range.to)
    next.delete("page")
    router.push(`${pathname}?${next.toString()}`, { scroll: false })
    setOpen(false)
  }

  const invalid = !draft.from || !draft.to || draft.to < draft.from

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft({ from, to })
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={cn("max-w-full", className)}>
          <CalendarRangeIcon aria-hidden="true" />
          <span className="truncate">{active ? `${active.label}: ` : ""}{`${formatDate(from)} – ${formatDate(to)}`}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Periods">
            {presets.map((p) => (
              <Button key={p.id} type="button" size="sm" variant={active?.id === p.id ? "secondary" : "ghost"} aria-pressed={active?.id === p.id} onClick={() => go(p)}>
                {p.label}
              </Button>
            ))}
          </div>
          <form
            className="flex flex-col gap-3 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!invalid) go(draft)
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.from} className="text-sm font-medium text-text">
                  From
                </label>
                <DatePicker id={ids.from} value={draft.from} onChange={(v) => setDraft((d) => ({ ...d, from: v }))} max={draft.to || undefined} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.to} className="text-sm font-medium text-text">
                  To
                </label>
                <DatePicker id={ids.to} value={draft.to} onChange={(v) => setDraft((d) => ({ ...d, to: v }))} min={draft.from || undefined} />
              </div>
            </div>
            {draft.from && draft.to && draft.to < draft.from ? <p className="text-sm text-danger-text">The end date is before the start date.</p> : null}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={invalid}>
                Show this period
              </Button>
            </div>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  )
}

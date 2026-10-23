"use client"

import * as React from "react"
import { CalendarRangeIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useTableUrlState } from "@/hooks/use-table-url-state"
import { readParam } from "@/components/app/data-table/params"
import { formatDate } from "@/lib/format"
import { isDateString } from "@/lib/domain/fy"

/**
 * The register's date filter (§7.5.4 "filters: outcome, date"): checks run between two days (IST),
 * kept in the URL as `?from=&to=` so the view can be shared and exported as it is.
 */
export function DateRangeFilter({ label = "Checked" }: { label?: string }) {
  const url = useTableUrlState({ filters: ["from", "to"] })
  const from = readParam(url.searchParams, "from") ?? ""
  const to = readParam(url.searchParams, "to") ?? ""
  const active = isDateString(from) || isDateString(to)
  const [open, setOpen] = React.useState(false)
  const [range, setRange] = React.useState({ from, to })
  const [error, setError] = React.useState<string | null>(null)
  const fromId = React.useId()
  const toId = React.useId()

  const summary = active
    ? isDateString(from) && isDateString(to)
      ? `${formatDate(from)} to ${formatDate(to)}`
      : isDateString(from)
        ? `From ${formatDate(from)}`
        : `Up to ${formatDate(to)}`
    : "Any date"

  return (
    <div className="flex items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (o) {
            setRange({ from, to })
            setError(null)
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" aria-label={`${label}: ${summary}`} className={active ? "border-primary/40" : undefined}>
            <CalendarRangeIcon aria-hidden="true" />
            <span className="text-text-muted">{label}:</span>
            <span className="num tabular-nums">{summary}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (range.from && range.to && range.from > range.to) {
                setError("The start can't be after the end.")
                return
              }
              url.navigate({ filters: { from: range.from ? [range.from] : null, to: range.to ? [range.to] : null } })
              setOpen(false)
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={fromId} className="text-sm font-medium text-text">
                From
              </label>
              <Input id={fromId} type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="num tabular-nums" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={toId} className="text-sm font-medium text-text">
                To
              </label>
              <Input id={toId} type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="num tabular-nums" />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-danger-text">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Apply
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      {active ? (
        <Button variant="ghost" size="icon-sm" aria-label="Clear the date filter" onClick={() => url.navigate({ filters: { from: null, to: null } })}>
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )
}

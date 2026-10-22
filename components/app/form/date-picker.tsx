"use client"

import * as React from "react"
import { CalendarIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { formatDate } from "@/lib/format"
import { isDateString, parseDateString, toDateString, todayIST } from "@/lib/domain/fy"
import { parseDateInput } from "@/components/app/form/format"

function toLocalDate(d: string): Date {
  const { year, month, day } = parseDateString(d)
  return new Date(year, month - 1, day)
}

function fromLocalDate(d: Date): string {
  return toDateString(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/**
 * A date-only field (§0.1 rule 13): the value is `YYYY-MM-DD` (or "" when empty); it displays as
 * `22 Oct 2026`. Type a date the usual ways (22/10/2026, 22-10-26, 22 Oct 2026) or pick it from the
 * calendar. Text that isn't a date is kept as typed and handed to the schema, which rejects it with a
 * field error, so nothing the user typed is lost.
 *
 *   <DatePicker value={due} onChange={setDue} id="due" min="2026-04-01" max="2027-03-31" />
 */
export function DatePicker({
  value,
  onChange,
  id,
  min,
  max,
  placeholder = "DD MMM YYYY",
  disabled,
  className,
  onBlur,
  ref,
  ...aria
}: {
  value: string | null | undefined
  onChange: (value: string) => void
  id?: string
  ref?: React.Ref<HTMLInputElement>
  /** Earliest selectable date, YYYY-MM-DD. */
  min?: string
  /** Latest selectable date, YYYY-MM-DD. */
  max?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  onBlur?: () => void
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "aria-required"?: boolean
  "aria-label"?: string
}) {
  const v = value ?? ""
  const valid = isDateString(v)
  const [draft, setDraft] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const shown = draft ?? (valid ? formatDate(v) : v)

  const commit = (text: string) => {
    setDraft(null)
    const t = text.trim()
    if (!t) return onChange("")
    const parsed = parseDateInput(t)
    onChange(parsed ?? t)
  }

  const selected = valid ? toLocalDate(v) : undefined
  const disabledDays = [
    ...(min && isDateString(min) ? [{ before: toLocalDate(min) }] : []),
    ...(max && isDateString(max) ? [{ after: toLocalDate(max) }] : []),
  ]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative w-full", className)}>
        <input
          id={id}
          ref={ref}
          {...aria}
          type="text"
          inputMode="text"
          autoComplete="off"
          disabled={disabled}
          value={shown}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            commit(e.target.value)
            onBlur?.()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit((e.target as HTMLInputElement).value)
            } else if (e.key === "ArrowDown" && e.altKey) {
              e.preventDefault()
              setOpen(true)
            }
          }}
          className="num h-9 w-full min-w-0 rounded-md border border-text-muted/30 bg-surface pr-11 pl-3 text-base text-text tabular-nums transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted aria-invalid:border-danger aria-invalid:ring-danger/20 max-md:text-md pointer-coarse:h-11"
        />
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Choose date from calendar"
            className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed pointer-coarse:size-10"
          >
            <CalendarIcon className="size-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="end" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? toLocalDate(todayIST())}
          captionLayout="dropdown"
          startMonth={new Date(2000, 0)}
          endMonth={new Date(2040, 11)}
          disabled={disabledDays.length ? disabledDays : undefined}
          onSelect={(d) => {
            if (d) {
              onChange(fromLocalDate(d))
              setDraft(null)
            }
            setOpen(false)
          }}
        />
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            className="cursor-pointer rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              onChange(todayIST())
              setDraft(null)
              setOpen(false)
            }}
          >
            Today
          </button>
          {v ? (
            <button
              type="button"
              className="cursor-pointer rounded-md px-2 py-1 text-sm text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                onChange("")
                setDraft(null)
                setOpen(false)
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

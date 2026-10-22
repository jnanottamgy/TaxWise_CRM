"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { formatMoneyDisplay, moneyValueFromTyping, cleanMoneyTyping } from "@/components/app/form/format"

type InputProps = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "defaultValue">

/**
 * Rupee amount input (§3.4): ₹ prefix, right-aligned tabular figures, Indian grouping when not
 * being edited (`1,23,456.50`). The value is the rupees string a numeric(14,2) column takes
 * (`"123456.5"`, or `""` when empty); the server parses it with parseAmount.
 *
 *   <MoneyInput value={fee} onChange={setFee} aria-label="Monthly fee" />
 */
export function MoneyInput({
  value,
  onChange,
  allowNegative = false,
  className,
  onBlur,
  onFocus,
  ...props
}: InputProps & {
  value: string | number | null | undefined
  onChange: (value: string) => void
  allowNegative?: boolean
}) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const stored = value === null || value === undefined ? "" : String(value)
  const shown = editing ?? formatMoneyDisplay(stored)

  return (
    <div className={cn("relative w-full", className)}>
      <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-text-muted">
        ₹
      </span>
      <input
        {...props}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={shown}
        onFocus={(e) => {
          setEditing(stored)
          onFocus?.(e)
        }}
        onChange={(e) => {
          const cleaned = cleanMoneyTyping(e.target.value, { allowNegative })
          setEditing(cleaned)
          onChange(moneyValueFromTyping(cleaned, { allowNegative }))
        }}
        onBlur={(e) => {
          setEditing(null)
          onBlur?.(e)
        }}
        className="num h-9 w-full min-w-0 rounded-md border border-text-muted/30 bg-surface pr-3 pl-7 text-right text-base text-text tabular-nums transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted aria-invalid:border-danger aria-invalid:ring-danger/20 max-md:text-md pointer-coarse:h-11"
      />
    </div>
  )
}

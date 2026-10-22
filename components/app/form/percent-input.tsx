"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { clampPercent, cleanPercentTyping } from "@/components/app/form/format"

type InputProps = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "defaultValue" | "max" | "min">

/**
 * Percentage input with a % suffix (GST rate, discount, TDS rate). Value is a decimal string
 * ("18", "12.5", or ""); clamped to [min, max] on blur.
 *
 *   <PercentInput value={rate} onChange={setRate} aria-label="Discount" />
 */
export function PercentInput({
  value,
  onChange,
  decimals = 2,
  max = 100,
  min = 0,
  className,
  onBlur,
  ...props
}: InputProps & {
  value: string | number | null | undefined
  onChange: (value: string) => void
  decimals?: number
  max?: number
  min?: number
}) {
  const shown = value === null || value === undefined ? "" : String(value)
  return (
    <div className={cn("relative w-full", className)}>
      <input
        {...props}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={shown}
        onChange={(e) => onChange(cleanPercentTyping(e.target.value, decimals))}
        onBlur={(e) => {
          const clamped = clampPercent(shown, max, min)
          if (clamped !== shown) onChange(clamped)
          onBlur?.(e)
        }}
        className="num h-9 w-full min-w-0 rounded-md border border-text-muted/30 bg-surface pr-8 pl-3 text-right text-base text-text tabular-nums transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted aria-invalid:border-danger aria-invalid:ring-danger/20 max-md:text-md pointer-coarse:h-11"
      />
      <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-text-muted">
        %
      </span>
    </div>
  )
}

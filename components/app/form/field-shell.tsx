"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface FieldAria {
  id: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "aria-required"?: boolean
}

/**
 * The frame every field shares (DESIGN.md §5): label above (13/500), `*` for required, the control,
 * helper text below, and the error in danger text. Wires `aria-describedby` / `aria-invalid` onto the
 * control through the render prop.
 *
 *   <FieldShell id="pan" label="PAN" required helper="10 characters, e.g. AAKFS1234C" error={err}>
 *     {(aria) => <Input {...aria} value={pan} onChange={…} />}
 *   </FieldShell>
 *
 * The RHF-bound fields in ./fields.tsx use it; use it directly for custom controls.
 */
export function FieldShell({
  id,
  label,
  required,
  helper,
  error,
  labelAction,
  hideLabel = false,
  className,
  children,
}: {
  id: string
  label: React.ReactNode
  required?: boolean
  helper?: React.ReactNode
  error?: string | null
  /** Small action at the right of the label row ("Look up GSTIN"). */
  labelAction?: React.ReactNode
  hideLabel?: boolean
  className?: string
  children: (aria: FieldAria) => React.ReactNode
}) {
  const helpId = helper ? `${id}-help` : undefined
  const errId = error ? `${id}-error` : undefined
  const describedBy = [errId, helpId].filter(Boolean).join(" ") || undefined
  return (
    <div data-slot="field" data-invalid={error ? true : undefined} className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className={cn("flex items-baseline justify-between gap-3", hideLabel && "sr-only")}>
        <label htmlFor={id} className="text-sm leading-5 font-medium text-text">
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-0.5 text-danger-text">
              *
            </span>
          ) : null}
        </label>
        {labelAction}
      </div>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required || undefined,
      })}
      {error ? (
        <p id={errId} className="text-sm leading-5 text-danger-text">
          {error}
        </p>
      ) : null}
      {helper ? (
        <p id={helpId} className="text-sm leading-5 text-text-muted">
          {helper}
        </p>
      ) : null}
    </div>
  )
}

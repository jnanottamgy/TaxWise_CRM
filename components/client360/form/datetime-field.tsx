"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { Input } from "@/components/ui/input"
import { FieldShell } from "@/components/app/form/field-shell"
import { fieldDomId } from "@/hooks/use-action-form"

/**
 * A date and time in IST (§0.1 rule 13) bound to react-hook-form: the browser's datetime-local
 * control, read and written as an ISO timestamp with the +05:30 offset whatever the device's
 * timezone. Empty stays "" (the schema treats it as "now").
 */

const IST = "+05:30"

/** "2026-10-23T14:05:00+05:30" → "2026-10-23T14:05" (the wall clock in IST). */
export function isoToIstLocal(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const ist = new Date(d.getTime() + 330 * 60_000)
  return ist.toISOString().slice(0, 16)
}

/** "2026-10-23T14:05" (IST wall clock) → "2026-10-23T14:05:00+05:30". */
export function istLocalToIso(local: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00${IST}` : ""
}

export function DateTimeField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  helper,
  required,
  max,
  className,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  label: React.ReactNode
  helper?: React.ReactNode
  required?: boolean
  /** Latest allowed, as an ISO timestamp. */
  max?: string
  className?: string
}) {
  const { field, fieldState } = useController({ control, name })
  const id = fieldDomId(control, name)
  return (
    <FieldShell id={id} label={label} helper={helper} required={required} error={fieldState.error?.message ?? null} className={className}>
      {(aria) => (
        <Input
          {...aria}
          ref={field.ref}
          type="datetime-local"
          name={field.name}
          value={isoToIstLocal(field.value as string | null | undefined)}
          max={max ? isoToIstLocal(max) : undefined}
          onChange={(e) => field.onChange(istLocalToIso(e.target.value))}
          onBlur={field.onBlur}
          className="num tabular-nums"
        />
      )}
    </FieldShell>
  )
}

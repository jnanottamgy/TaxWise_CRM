"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/app/form/date-picker"
import { fieldDomId } from "@/hooks/use-action-form"
import { istDateTimeParts, istInstant } from "@/lib/schemas/covers"

/** useController behind a hook of our own, as the form kit does (components/app/form/fields.tsx). */
function useBound<TFV extends FieldValues, TName extends FieldPath<TFV>, TT>(control: Control<TFV, unknown, TT>, name: TName) {
  const { field, fieldState } = useController({ control, name })
  return { field, error: fieldState.error?.message ?? null, id: fieldDomId(control, name) }
}

/**
 * A date and a time in IST, bound to an ISO timestamp field (cover From / Until, §4.7). The form
 * shows "22 Oct 2026" and "18:30"; the value is the instant. Quick picks render below it.
 */
export function DateTimeField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  minDate,
  children,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  label: string
  required?: boolean
  helper?: React.ReactNode
  minDate?: string
  /** Quick picks under the inputs. */
  children?: React.ReactNode
}) {
  const { field, error, id } = useBound(control, name)
  const { ref: fieldRef, value: fieldValue, onChange: fieldOnChange, onBlur: fieldOnBlur } = field
  const value = typeof fieldValue === "string" && fieldValue ? fieldValue : null
  const parts = value && !Number.isNaN(Date.parse(value)) ? istDateTimeParts(value) : { date: "", time: "" }
  const [date, setDate] = React.useState(parts.date)
  const [time, setTime] = React.useState(parts.time)
  const [seen, setSeen] = React.useState<string | null>(value)
  if (value !== seen) {
    setSeen(value)
    setDate(parts.date)
    setTime(parts.time)
  }

  const push = (d: string, t: string) => {
    const at = istInstant(d, t)
    const iso = at ? at.toISOString() : ""
    setSeen(iso || null)
    fieldOnChange(iso)
  }

  const errId = error ? `${id}-error` : undefined
  const helpId = helper ? `${id}-help` : undefined
  const describedBy = [errId, helpId].filter(Boolean).join(" ") || undefined
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={describedBy}>
      <legend className="mb-1.5 text-sm leading-5 font-medium text-text">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-danger-text">
            *
          </span>
        ) : null}
      </legend>
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
        <DatePicker
          id={id}
          ref={fieldRef}
          value={date}
          min={minDate}
          aria-label={`${label}: date`}
          aria-invalid={error ? true : undefined}
          onChange={(d) => {
            setDate(d)
            push(d, time || "23:59")
          }}
          onBlur={fieldOnBlur}
        />
        <Input
          type="time"
          aria-label={`${label}: time (IST)`}
          value={time}
          step={60}
          onChange={(e) => {
            setTime(e.target.value)
            push(date, e.target.value)
          }}
          onBlur={fieldOnBlur}
          aria-invalid={error ? true : undefined}
          className="num"
        />
      </div>
      {children}
      {helper ? (
        <p id={helpId} className="text-sm text-text-muted">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

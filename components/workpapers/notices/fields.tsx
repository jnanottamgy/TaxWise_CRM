"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { FieldShell } from "@/components/app/form/field-shell"
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select"
import { Input } from "@/components/ui/input"
import { fieldDomId } from "@/hooks/use-action-form"

export type NativeOption = { value: string; label: string }
export type NativeGroup = { label: string; options: NativeOption[] }

/**
 * A native select bound to react-hook-form, for choices that include an empty value ("Unassigned",
 * "Not set"), which the Radix select can't hold. Label above, helper and error below (FieldShell);
 * server field errors land on it through its DOM id.
 */
export function NativeSelectField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  options,
  groups,
  emptyLabel,
  className,
  disabled,
  onValueChange,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  label: React.ReactNode
  required?: boolean
  helper?: React.ReactNode
  options?: NativeOption[]
  groups?: NativeGroup[]
  /** An empty first option ("Unassigned"); omit for none. */
  emptyLabel?: string
  className?: string
  disabled?: boolean
  onValueChange?: (value: string) => void
}) {
  const { field, fieldState } = useController({ control, name })
  const id = fieldDomId(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={fieldState.error?.message ?? null} className={className}>
      {(aria) => (
        <div className="[&>[data-slot=native-select-wrapper]]:w-full">
          <NativeSelect
            {...aria}
            ref={field.ref}
            name={field.name}
            value={(field.value as string | null | undefined) ?? ""}
            onChange={(e) => {
              field.onChange(e.target.value)
              onValueChange?.(e.target.value)
            }}
            onBlur={field.onBlur}
            disabled={disabled}
          >
            {emptyLabel !== undefined ? <NativeSelectOption value="">{emptyLabel}</NativeSelectOption> : null}
            {(options ?? []).map((o) => (
              <NativeSelectOption key={o.value} value={o.value}>
                {o.label}
              </NativeSelectOption>
            ))}
            {(groups ?? []).map((g) => (
              <NativeSelectOptGroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <NativeSelectOption key={o.value} value={o.value}>
                    {o.label}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ))}
          </NativeSelect>
        </div>
      )}
    </FieldShell>
  )
}

/** A time of day (HH:MM, 24-hour) bound to react-hook-form. */
export function TimeField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  helper,
  className,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  label: React.ReactNode
  helper?: React.ReactNode
  className?: string
}) {
  const { field, fieldState } = useController({ control, name })
  const id = fieldDomId(control, name)
  return (
    <FieldShell id={id} label={label} helper={helper} error={fieldState.error?.message ?? null} className={className}>
      {(aria) => (
        <Input
          {...aria}
          ref={field.ref}
          type="time"
          step={300}
          name={field.name}
          value={(field.value as string | undefined) ?? ""}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
          className="num"
        />
      )}
    </FieldShell>
  )
}

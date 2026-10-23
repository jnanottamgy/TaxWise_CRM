"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { FieldShell } from "@/components/app/form/field-shell"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { fieldDomId } from "@/hooks/use-action-form"

/**
 * A react-hook-form select that may hold an empty value ("No UDIN", "No template"): the native
 * control, which keeps "" as a real choice and is the easiest select to use on a phone. Same frame
 * as the kit's fields (FieldShell: label above, helper, error).
 */
export function NativeSelectField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  options,
  required,
  helper,
  className,
  disabled,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  label: React.ReactNode
  options: Array<{ value: string; label: string; disabled?: boolean }>
  required?: boolean
  helper?: React.ReactNode
  className?: string
  disabled?: boolean
}) {
  const { field, fieldState } = useController({ control, name })
  const id = fieldDomId(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={fieldState.error?.message ?? null} className={className}>
      {(aria) => (
        <div className="min-w-0 [&>[data-slot=native-select-wrapper]]:w-full">
        <NativeSelect
          {...aria}
          ref={field.ref}
          name={field.name}
          value={(field.value as string | null | undefined) ?? ""}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
          className="w-full"
        >
          {options.map((o) => (
            <NativeSelectOption key={o.value || "none"} value={o.value} disabled={o.disabled}>
              {o.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        </div>
      )}
    </FieldShell>
  )
}

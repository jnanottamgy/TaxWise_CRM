"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { cn } from "@/lib/utils"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { fieldDomId } from "@/hooks/use-action-form"

export interface Choice {
  value: string
  label: string
  description?: React.ReactNode
}

/**
 * One choice from a few, each with a line saying what it means (approval modes, null/0 semantics
 * made explicit). Radio buttons bound to react-hook-form; `children` render under the chosen option
 * (an amount field that only applies to "Above an amount").
 */
export function ChoiceField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  legend,
  choices,
  renderUnder,
  className,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  legend: React.ReactNode
  choices: Choice[]
  /** Extra content under a choice while it is selected. */
  renderUnder?: (value: string) => React.ReactNode
  className?: string
}) {
  const { field, fieldState } = useController({ control, name })
  // Destructured: the React compiler treats `field` as holding a ref (react-hooks/refs).
  const { ref: fieldRef, name: fieldName, value: fieldValue, onChange, onBlur } = field
  const id = fieldDomId(control, name)
  const error = fieldState.error?.message
  const errId = error ? `${id}-error` : undefined
  return (
    <fieldset id={id} className={cn("flex min-w-0 flex-col gap-2", className)} aria-describedby={errId} aria-invalid={error ? true : undefined}>
      <legend className="mb-1.5 text-sm leading-5 font-medium text-text">{legend}</legend>
      <RadioGroup
        ref={fieldRef}
        name={fieldName}
        value={(fieldValue as string | undefined) ?? ""}
        onValueChange={(v) => {
          onChange(v)
          onBlur()
        }}
        className="gap-2.5"
      >
        {choices.map((c) => {
          const cid = `${id}-${c.value}`
          const selected = fieldValue === c.value
          return (
            <div key={c.value} className="flex min-w-0 flex-col gap-2">
              <div className="flex items-start gap-2.5">
                <RadioGroupItem id={cid} value={c.value} className="mt-0.5" />
                <label htmlFor={cid} className="min-w-0 cursor-pointer text-base leading-5 text-text">
                  {c.label}
                  {c.description ? <span className="mt-0.5 block text-sm text-text-muted">{c.description}</span> : null}
                </label>
              </div>
              {selected && renderUnder ? <div className="pl-6.5">{renderUnder(c.value)}</div> : null}
            </div>
          )
        })}
      </RadioGroup>
      {error ? (
        <p id={errId} className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

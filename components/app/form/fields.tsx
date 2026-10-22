"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldShell } from "@/components/app/form/field-shell"
import { MoneyInput } from "@/components/app/form/money-input"
import { PercentInput } from "@/components/app/form/percent-input"
import { DatePicker } from "@/components/app/form/date-picker"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { TagInput } from "@/components/app/form/tag-input"
import { PasswordInput } from "@/components/app/form/password-input"
import { fieldDomId } from "@/hooks/use-action-form"

/*
 * Form fields bound to react-hook-form (CONVENTIONS §5). Each takes `control` + `name` from
 * useActionForm, renders the shared FieldShell (label above, helper below, `*` for required, error
 * text, aria-describedby), and shows server field errors mapped by useActionForm.
 *
 *   <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
 *     <TextField control={f.control} name="name" label="Client name" required />
 *     <TextField control={f.control} name="pan" label="PAN" helper="10 characters" autoCapitalize="characters" />
 *     <SelectField control={f.control} name="entity_type" label="Entity type" options={ENTITY_OPTIONS} required />
 *     <DateField control={f.control} name="due_date" label="Due date" required />
 *     <MoneyField control={f.control} name="fee" label="Monthly fee" />
 *     <SwitchField control={f.control} name="send_welcome" label="Send welcome email" description="…" />
 *   </div>
 */

interface BaseProps<TFV extends FieldValues, TName extends FieldPath<TFV>, TT> {
  control: Control<TFV, unknown, TT>
  name: TName
  label: React.ReactNode
  required?: boolean
  helper?: React.ReactNode
  labelAction?: React.ReactNode
  hideLabel?: boolean
  className?: string
  disabled?: boolean
}

function useField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT>(control: Control<TFV, unknown, TT>, name: TName) {
  const { field, fieldState } = useController({ control, name })
  return { field, error: fieldState.error?.message ?? null, id: fieldDomId(control, name) }
}

type NativeInputProps = Omit<React.ComponentProps<typeof Input>, "name" | "value" | "onChange" | "onBlur" | "defaultValue" | "id" | "ref">

export function TextField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  ...input
}: BaseProps<TFV, TName, TT> & NativeInputProps) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <Input
          {...input}
          {...aria}
          ref={field.ref}
          name={field.name}
          value={(field.value as string | number | undefined) ?? ""}
          onChange={field.onChange}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

export function TextareaField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  rows = 4,
  ...textarea
}: BaseProps<TFV, TName, TT> &
  Omit<React.ComponentProps<typeof Textarea>, "name" | "value" | "onChange" | "onBlur" | "defaultValue" | "id" | "ref">) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <Textarea
          {...textarea}
          {...aria}
          rows={rows}
          ref={field.ref}
          name={field.name}
          value={(field.value as string | undefined) ?? ""}
          onChange={field.onChange}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export function SelectField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  options,
  placeholder = "Choose…",
}: BaseProps<TFV, TName, TT> & { options: SelectOption[]; placeholder?: string }) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <Select
          name={field.name}
          value={(field.value as string | undefined) || undefined}
          onValueChange={(v) => {
            field.onChange(v)
            field.onBlur()
          }}
          disabled={disabled || field.disabled}
        >
          <SelectTrigger {...aria} ref={field.ref} className="w-full" onBlur={field.onBlur}>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldShell>
  )
}

export function ComboboxField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  ...combo
}: BaseProps<TFV, TName, TT> &
  Omit<React.ComponentProps<typeof Combobox>, "value" | "onChange" | "id" | "onBlur" | "disabled" | "ref"> & {
    onSelectOption?: (option: ComboOption | undefined) => void
  }) {
  const { field, error, id } = useField(control, name)
  const { onSelectOption, ...rest } = combo
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <Combobox
          {...rest}
          {...aria}
          ref={field.ref}
          value={(field.value as string | null | undefined) ?? null}
          onChange={(v, o) => {
            field.onChange(v)
            onSelectOption?.(o)
          }}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

export function DateField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  min,
  max,
}: BaseProps<TFV, TName, TT> & { min?: string; max?: string }) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <DatePicker
          {...aria}
          ref={field.ref}
          value={(field.value as string | null | undefined) ?? ""}
          onChange={field.onChange}
          onBlur={field.onBlur}
          min={min}
          max={max}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

export function MoneyField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  allowNegative,
  placeholder,
}: BaseProps<TFV, TName, TT> & { allowNegative?: boolean; placeholder?: string }) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <MoneyInput
          {...aria}
          ref={field.ref}
          name={field.name}
          placeholder={placeholder}
          allowNegative={allowNegative}
          value={field.value as string | number | null | undefined}
          onChange={field.onChange}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

export function PercentField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  max,
  min,
  decimals,
}: BaseProps<TFV, TName, TT> & { max?: number; min?: number; decimals?: number }) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <PercentInput
          {...aria}
          ref={field.ref}
          name={field.name}
          max={max}
          min={min}
          decimals={decimals}
          value={field.value as string | number | null | undefined}
          onChange={field.onChange}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

export function PasswordField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  autoComplete = "current-password",
  checklist,
}: BaseProps<TFV, TName, TT> & {
  autoComplete?: "current-password" | "new-password"
  /** Render prop for the live policy checklist, given the current value. */
  checklist?: (value: string) => React.ReactNode
}) {
  const { field, error, id } = useField(control, name)
  const value = (field.value as string | undefined) ?? ""
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <PasswordInput
          {...aria}
          ref={field.ref}
          name={field.name}
          autoComplete={autoComplete}
          value={value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          disabled={disabled || field.disabled}
          checklist={checklist?.(value)}
        />
      )}
    </FieldShell>
  )
}

export function TagField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  labelAction,
  hideLabel,
  className,
  disabled,
  ...tags
}: BaseProps<TFV, TName, TT> & Omit<React.ComponentProps<typeof TagInput>, "value" | "onChange" | "id" | "disabled" | "ref">) {
  const { field, error, id } = useField(control, name)
  return (
    <FieldShell id={id} label={label} required={required} helper={helper} error={error} labelAction={labelAction} hideLabel={hideLabel} className={className}>
      {(aria) => (
        <TagInput
          {...tags}
          {...aria}
          ref={field.ref}
          value={(field.value as string[] | undefined) ?? []}
          onChange={(v) => {
            field.onChange(v)
            field.onBlur()
          }}
          disabled={disabled || field.disabled}
        />
      )}
    </FieldShell>
  )
}

/**
 * A setting as a row: title and description on the left, the switch on the right (taste §8.2).
 *
 *   <SwitchField control={f.control} name="whatsapp_signature" label="Add my signature to WhatsApp drafts"
 *     description="Clients see who wrote the message when it comes from a shared office number." />
 */
export function SwitchField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: Omit<BaseProps<TFV, TName, TT>, "required" | "helper" | "labelAction" | "hideLabel"> & { description?: React.ReactNode }) {
  const { field, error, id } = useField(control, name)
  const { ref: fieldRef, name: fieldName, value: fieldValue, onChange, onBlur, disabled: fieldDisabled } = field
  const descId = description ? `${id}-desc` : undefined
  const errId = error ? `${id}-error` : undefined
  return (
    <div data-slot="field" className={cn("flex items-start justify-between gap-4 py-1", className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-base leading-5 font-medium text-text">
          {label}
        </label>
        {description ? (
          <p id={descId} className="mt-0.5 text-sm text-text-muted">
            {description}
          </p>
        ) : null}
        {error ? (
          <p id={errId} className="mt-0.5 text-sm text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        ref={fieldRef}
        name={fieldName}
        checked={!!fieldValue}
        onCheckedChange={(v) => {
          onChange(v)
          onBlur()
        }}
        disabled={disabled || fieldDisabled}
        aria-describedby={[errId, descId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        className="mt-0.5"
      />
    </div>
  )
}

/**
 * Several checkboxes for one array value (services taken, document categories).
 *
 *   <CheckboxGroupField control={f.control} name="services" label="Services" required
 *     options={[{ value: "gst", label: "GST" }, { value: "income_tax", label: "Income tax" }]} columns={2} />
 */
export function CheckboxGroupField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  label,
  required,
  helper,
  className,
  disabled,
  options,
  columns = 1,
}: Omit<BaseProps<TFV, TName, TT>, "labelAction" | "hideLabel"> & {
  options: Array<{ value: string; label: string; description?: string; disabled?: boolean }>
  columns?: 1 | 2 | 3
}) {
  const { field, error, id } = useField(control, name)
  const { ref: fieldRef, value: fieldValue, onChange, onBlur, disabled: fieldDisabled } = field
  const value = ((fieldValue as string[] | undefined) ?? []) as string[]
  const helpId = helper ? `${id}-help` : undefined
  const errId = error ? `${id}-error` : undefined
  return (
    <fieldset
      id={id}
      data-slot="field"
      aria-describedby={[errId, helpId].filter(Boolean).join(" ") || undefined}
      aria-invalid={error ? true : undefined}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <legend className="mb-1.5 text-sm leading-5 font-medium text-text">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-danger-text">
            *
          </span>
        ) : null}
      </legend>
      <div className={cn("grid gap-x-6 gap-y-2", columns === 2 ? "sm:grid-cols-2" : columns === 3 ? "sm:grid-cols-3" : "grid-cols-1")}>
        {options.map((o, i) => {
          const cid = `${id}-${i}`
          const checked = value.includes(o.value)
          return (
            <div key={o.value} className="flex items-start gap-2.5">
              <Checkbox
                id={cid}
                ref={i === 0 ? fieldRef : undefined}
                checked={checked}
                disabled={disabled || fieldDisabled || o.disabled}
                onCheckedChange={(v) => {
                  onChange(v === true ? [...value, o.value] : value.filter((x) => x !== o.value))
                  onBlur()
                }}
                className="mt-0.5"
              />
              <label htmlFor={cid} className="min-w-0 cursor-pointer text-base leading-5 text-text">
                {o.label}
                {o.description ? <span className="block text-sm text-text-muted">{o.description}</span> : null}
              </label>
            </div>
          )
        })}
      </div>
      {error ? (
        <p id={errId} className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      {helper ? (
        <p id={helpId} className="text-sm text-text-muted">
          {helper}
        </p>
      ) : null}
    </fieldset>
  )
}

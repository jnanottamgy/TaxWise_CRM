"use client"

import * as React from "react"
import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form"
import { cn } from "@/lib/utils"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { DateField, MoneyField, SwitchField, TextField } from "@/components/app/form/fields"
import { fieldDomId } from "@/hooks/use-action-form"
import { ROLE_SCOPE, type StaffRole } from "@/lib/schemas/people"

/**
 * The role picker (§4.5 point 1: "the role picker shows what each role grants and where it stops"):
 * one card per role the actor may give, each saying what it grants and where it stops.
 */
/** useController behind a hook of our own, as the form kit does (components/app/form/fields.tsx). */
function useBound<TFV extends FieldValues, TName extends FieldPath<TFV>, TT>(control: Control<TFV, unknown, TT>, name: TName) {
  const { field, fieldState } = useController({ control, name })
  return { field, error: fieldState.error?.message ?? null, id: fieldDomId(control, name) }
}

export function RoleField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  roles,
  disabled,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  roles: readonly StaffRole[]
  disabled?: boolean
}) {
  const { field, error, id } = useBound(control, name)
  const { ref: fieldRef, value: fieldValue, onChange: fieldOnChange, onBlur: fieldOnBlur } = field
  const errId = error ? `${id}-error` : undefined
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5 md:col-span-2" aria-describedby={errId}>
      <legend className="mb-1.5 text-sm leading-5 font-medium text-text">
        Role
        <span aria-hidden="true" className="ml-0.5 text-danger-text">
          *
        </span>
      </legend>
      <RadioGroup
        id={id}
        ref={fieldRef}
        value={(fieldValue as string | undefined) ?? ""}
        onValueChange={(v) => {
          fieldOnChange(v)
          fieldOnBlur()
        }}
        disabled={disabled}
        className={cn("grid gap-2", roles.length > 1 ? "md:grid-cols-3" : "grid-cols-1")}
        aria-invalid={error ? true : undefined}
      >
        {roles.map((r) => {
          const scope = ROLE_SCOPE[r]
          const itemId = `${id}-${r}`
          const on = fieldValue === r
          return (
            <label
              key={r}
              htmlFor={itemId}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors duration-150",
                on ? "border-primary bg-primary-soft" : "border-border hover:bg-surface-2",
                disabled && "cursor-not-allowed opacity-70"
              )}
            >
              <RadioGroupItem id={itemId} value={r} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-base font-medium text-text">{scope.label}</span>
                <span className="mt-0.5 block text-sm text-text-muted">{scope.grants}</span>
                <span className="mt-1 block text-sm text-text-muted">
                  <span className="font-medium text-text">Stops at: </span>
                  {scope.stops}
                </span>
              </span>
            </label>
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

/** The contact and job fields shared by Add team member and Edit details. */
export function ContactAndJobFields<TFV extends FieldValues, TT = TFV>({
  control,
  showEmail,
}: {
  control: Control<TFV, unknown, TT>
  showEmail: boolean
}) {
  type N = FieldPath<TFV>
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <TextField control={control} name={"full_name" as N} label="Full name" required autoComplete="off" />
      {showEmail ? (
        <TextField control={control} name={"email" as N} label="Email" required type="email" autoComplete="off" helper="Their sign-in email. It must be unique." />
      ) : null}
      <TextField control={control} name={"phone" as N} label="Phone" type="tel" inputMode="tel" autoComplete="off" />
      <TextField control={control} name={"whatsapp" as N} label="WhatsApp" type="tel" inputMode="tel" autoComplete="off" helper="For sharing their login. Leave blank if it's the phone number." />
      <TextField control={control} name={"department" as N} label="Department" autoComplete="off" placeholder="GST, Audit, Income tax…" />
      <TextField control={control} name={"designation" as N} label="Designation" autoComplete="off" placeholder="Senior associate" />
      <DateField control={control} name={"date_of_joining" as N} label="Date of joining" />
    </div>
  )
}

/** Rates and Partner-only access (§4.5 point 1). */
export function RateAndAccessFields<TFV extends FieldValues, TT = TFV>({
  control,
  isPartner,
  showMembership,
}: {
  control: Control<TFV, unknown, TT>
  isPartner: boolean
  showMembership: boolean
}) {
  type N = FieldPath<TFV>
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <MoneyField control={control} name={"billing_rate_per_hour" as N} label="Billing rate (₹/hour)" helper="Excluding GST. Leave blank if they aren't billed hourly." />
      {isPartner ? (
        <MoneyField control={control} name={"cost_rate_per_hour" as N} label="Cost rate (₹/hour)" helper="Partners only: used for profitability, never shown to the team." />
      ) : null}
      {showMembership ? (
        <TextField control={control} name={"icai_membership_no" as N} label="ICAI membership number" inputMode="numeric" maxLength={7} helper="Six digits. Used for UDINs." />
      ) : null}
      {isPartner ? (
        <SwitchField
          control={control}
          name={"vault_access" as N}
          label="Vault access"
          description="Lets them reveal stored portal passwords of their own clients. Every reveal is logged."
          className="md:col-span-2"
        />
      ) : null}
    </div>
  )
}

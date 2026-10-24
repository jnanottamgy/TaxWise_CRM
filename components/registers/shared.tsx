"use client"

import * as React from "react"
import { MoreHorizontalIcon } from "lucide-react"
import { toast } from "sonner"
import type { Control, FieldPath, FieldValues } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ComboboxField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import type { ActionResult } from "@/lib/result"
import { searchClientsForRegisters } from "@/server/actions/registrations"

/** Toasts an action's result: the error (with its Ref), the warnings, and an optional success line. */
export function toastResult<T>(r: ActionResult<T>, success?: string): r is { ok: true; data: T; warnings?: string[] } {
  if (!r.ok) {
    toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
    return false
  }
  for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
  if (success) toast.success(success)
  return true
}

export interface RowMenuItem {
  key: string
  label: string
  icon?: React.ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/** One kebab at the far right of a row (taste §7.8). Clicks never reach the row. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  if (!items.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} data-row-click-ignore onClick={(e) => e.stopPropagation()}>
          <MoreHorizontalIcon aria-hidden="true" className="text-text-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map((m, i) => (
          <React.Fragment key={m.key}>
            {m.danger && i > 0 && !items[i - 1]?.danger ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={m.onSelect} disabled={m.disabled} className={m.danger ? "text-danger-text focus:text-danger-text" : undefined}>
              {m.icon}
              {m.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

async function searchClients(q: string): Promise<ComboOption[]> {
  const r = await searchClientsForRegisters({ q })
  if (!r.ok) throw new Error(r.error)
  return r.data
}

/** The client picker of the register forms: searches the clients the person can see, by name, code, legal name or PAN. */
export function ClientPickerField<TFV extends FieldValues, TName extends FieldPath<TFV>, TT = TFV>({
  control,
  name,
  selectedLabel,
  disabled,
  helper,
  onSelectOption,
  required = true,
}: {
  control: Control<TFV, unknown, TT>
  name: TName
  selectedLabel?: string
  disabled?: boolean
  helper?: React.ReactNode
  onSelectOption?: (option: ComboOption | undefined) => void
  required?: boolean
}) {
  return (
    <ComboboxField
      control={control}
      name={name}
      label="Client"
      required={required}
      loadOptions={searchClients}
      selectedLabel={selectedLabel}
      placeholder={required ? "Choose a client" : "No client (a firm-level document)"}
      searchPlaceholder="Name, code or PAN"
      emptyText="No client matches."
      clearable={!required}
      disabled={disabled}
      helper={helper}
      onSelectOption={onSelectOption}
    />
  )
}

/** A fresh value per send, so a double click doesn't send twice and a resend is a new send. */
export function newNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

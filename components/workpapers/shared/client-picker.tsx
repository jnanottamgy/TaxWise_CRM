"use client"

import * as React from "react"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { FieldShell } from "@/components/app/form/field-shell"
import type { ActionResult } from "@/lib/result"

/**
 * The client field of a workpaper (§7.8.1 step 1, §7.8.3 step 1): a searchable picker over the
 * clients the signed-in person may see (the server action runs under their RLS, so an Employee
 * finds only their own clients, §4.1).
 */
export function WorkpaperClientPicker({
  id,
  value,
  selectedLabel,
  onChange,
  search,
  error,
  disabled,
  helper,
}: {
  id: string
  value: string | null
  selectedLabel?: string
  onChange: (id: string | null, option?: ComboOption) => void
  search: (input: { q: string }) => Promise<ActionResult<ComboOption[]>>
  error?: string | null
  disabled?: boolean
  helper?: React.ReactNode
}) {
  const load = React.useCallback(
    async (q: string) => {
      const r = await search({ q })
      return r.ok ? r.data : []
    },
    [search],
  )
  return (
    <FieldShell id={id} label="Client" required error={error} helper={helper}>
      {(aria) => (
        <Combobox
          {...aria}
          value={value}
          onChange={onChange}
          loadOptions={load}
          selectedLabel={selectedLabel}
          placeholder="Choose a client"
          searchPlaceholder="Name, code, GSTIN or PAN"
          emptyText="No client matches. Employees see only their own clients."
          clearable={false}
          disabled={disabled}
        />
      )}
    </FieldShell>
  )
}

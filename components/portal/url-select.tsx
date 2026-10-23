"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

/**
 * A select that writes one search param (the FY on Compliance and Invoices, a type on Documents)
 * and resets the page, so the server re-renders the list for it (§2.3). The empty option removes
 * the param.
 */
export function UrlSelect({
  param,
  value,
  options,
  label,
  emptyLabel,
  className,
}: {
  param: string
  value: string
  options: Array<{ value: string; label: string }>
  label: string
  /** An option meaning "any" (removes the param). */
  emptyLabel?: string
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const id = React.useId()
  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <NativeSelect
        id={id}
        value={value}
        disabled={pending}
        aria-busy={pending}
        onChange={(e) => {
          const next = new URLSearchParams(sp.toString())
          if (e.target.value) next.set(param, e.target.value)
          else next.delete(param)
          next.delete("page")
          const qs = next.toString()
          startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
        }}
      >
        {emptyLabel !== undefined ? <NativeSelectOption value="">{emptyLabel}</NativeSelectOption> : null}
        {options.map((o) => (
          <NativeSelectOption key={o.value} value={o.value}>
            {o.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

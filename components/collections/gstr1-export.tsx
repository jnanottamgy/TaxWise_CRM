"use client"

import * as React from "react"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DownloadButton } from "@/components/collections/download-button"

/**
 * GSTR-1 for a month or a quarter (§7.9.8): B2B, B2CL / B2CS, credit notes (CDNR / CDNUR), HSN / SAC
 * summary and documents issued, as the offline tool's Excel sheets or as the JSON to upload.
 */
export function Gstr1Export({ months, quarters, initial }: { months: Array<{ value: string; label: string }>; quarters: string[]; initial: string }) {
  const [period, setPeriod] = React.useState(initial)
  const id = React.useId()
  const q = encodeURIComponent(period)
  const slug = period.replace(/\s+/g, "-")
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-text">
        Return period
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger id={id} className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Monthly</SelectLabel>
              {months.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Quarterly (QRMP)</SelectLabel>
              {quarters.map((x) => (
                <SelectItem key={x} value={x}>
                  {x}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <DownloadButton href={`/api/exports/gstr1?period=${q}&format=xlsx`} label="Excel" fallbackName={`GSTR-1-${slug}.xlsx`} />
        <DownloadButton href={`/api/exports/gstr1?period=${q}&format=json`} label="JSON" fallbackName={`GSTR-1-${slug}.json`} />
      </div>
    </div>
  )
}

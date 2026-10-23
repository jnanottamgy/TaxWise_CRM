"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { exportInvoices } from "@/server/actions/invoices"

/** Saves a file the server sent as base64. */
export function downloadBase64(file: { fileName: string; mimeType: string; base64: string }): void {
  const bin = atob(file.base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }))
  const a = document.createElement("a")
  a.href = url
  a.download = file.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/** CSV or Excel of the invoices the list shows (its search, filters and sort; every page). */
export function InvoiceExportMenu() {
  const searchParams = useSearchParams()
  const [pending, setPending] = React.useState<"csv" | "xlsx" | null>(null)

  const run = async (format: "csv" | "xlsx") => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("page")
    params.delete("size")
    setPending(format)
    try {
      const r = await exportInvoices({ query: params.toString(), format })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      downloadBase64(r.data)
      toast.success(
        r.data.truncated
          ? `Exported the first ${r.data.rows.toLocaleString("en-IN")} invoices. Narrow the filters to export the rest.`
          : `Exported ${r.data.rows.toLocaleString("en-IN")} ${r.data.rows === 1 ? "invoice" : "invoices"}.`,
      )
    } catch {
      toast.error("The export didn't go through. Check your connection and try again.")
    } finally {
      setPending(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending !== null} aria-busy={pending !== null}>
          {pending ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
          <span className="max-sm:sr-only">Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">This view</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void run("csv")}>
          <FileTextIcon aria-hidden="true" />
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("xlsx")}>
          <FileSpreadsheetIcon aria-hidden="true" />
          Excel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

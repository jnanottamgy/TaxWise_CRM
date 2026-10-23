"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { exportClients } from "@/server/actions/clients"
import { downloadBase64 } from "@/components/clients/client-ui"

/**
 * CSV or Excel export of the current view (§7.3.4): the list's search, filters and sort, or just the
 * selected rows. Employees' files carry no fees (the server leaves the column out, §4.1).
 */
export function ClientExportMenu({ ids, onDone, size = "sm", label = "Export" }: { ids?: string[]; onDone?: () => void; size?: "sm" | "default"; label?: string }) {
  const searchParams = useSearchParams()
  const [pending, setPending] = React.useState<"csv" | "xlsx" | null>(null)

  const run = async (format: "csv" | "xlsx") => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("page")
    params.delete("size")
    setPending(format)
    try {
      const r = await exportClients({ query: params.toString(), format, ids })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      downloadBase64(r.data)
      toast.success(
        r.data.truncated
          ? `Exported the first ${r.data.rows.toLocaleString("en-IN")} clients. Narrow the filters to export the rest.`
          : `Exported ${r.data.rows.toLocaleString("en-IN")} ${r.data.rows === 1 ? "client" : "clients"}.`,
      )
      onDone?.()
    } catch {
      toast.error("The export didn't go through. Check your connection and try again.")
    } finally {
      setPending(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size} disabled={pending !== null} aria-busy={pending !== null}>
          {pending ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
          <span className={size === "sm" ? "max-sm:sr-only" : undefined}>{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">{ids ? `${ids.length} selected` : "This view"}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void run("csv")}>
          <FileTextIcon aria-hidden="true" />
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("xlsx")}>
          <FileSpreadsheetIcon aria-hidden="true" />
          Excel (.xlsx)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

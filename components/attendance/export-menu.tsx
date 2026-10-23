"use client"

import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Attendance exports (§7.12): the report (person × day) and the monthly summary (present, late,
 * half days, absent, leave, hours), each as CSV or Excel. The route re-checks access and writes the
 * export_run audit row.
 */
export function AttendanceExportMenu({ month }: { month: string }) {
  const href = (kind: "report" | "summary", format: "csv" | "xlsx") => `/performance/export?month=${month}&kind=${kind}&format=${format}`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline">
          <DownloadIcon aria-hidden="true" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">Attendance report (person × day)</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={href("report", "xlsx")} download>
            Excel
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href("report", "csv")} download>
            CSV
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">Monthly summary</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={href("summary", "xlsx")} download>
            Excel
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href("summary", "csv")} download>
            CSV
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

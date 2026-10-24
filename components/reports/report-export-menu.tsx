"use client"

import * as React from "react"
import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

function fileNameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      return fallback
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain ? plain[1].trim() : fallback
}

/**
 * Fetches a file from an export route and saves it. A refusal (no access, the authenticator code,
 * a bad period) comes back as JSON with a sentence and a Ref and shows as a toast, never as a page
 * of JSON.
 */
export async function downloadFrom(href: string, fallbackName: string): Promise<boolean> {
  try {
    const res = await fetch(href, { cache: "no-store" })
    const type = res.headers.get("content-type") ?? ""
    if (!res.ok || type.includes("application/json")) {
      const body = (await res.json().catch(() => null)) as { error?: string; ref?: string } | null
      const message = body?.error ?? "The file couldn't be prepared. Please try again."
      toast.error(body?.ref ? `${message} (Ref ${body.ref})` : message)
      return false
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileNameFrom(res.headers.get("content-disposition"), fallbackName)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  } catch {
    toast.error("We couldn't reach the server. Check your connection and try again.")
    return false
  }
}

/** Excel or PDF of the report with its filters (every row, not the screen's page). The export is audited. */
export function ReportExportMenu({ slug, query }: { slug: string; query: string }) {
  const [pending, setPending] = React.useState<"xlsx" | "pdf" | null>(null)
  const run = async (format: "xlsx" | "pdf") => {
    setPending(format)
    const params = new URLSearchParams(query)
    params.set("format", format)
    const ok = await downloadFrom(`/api/exports/reports/${slug}?${params.toString()}`, `taxwise-${slug}-report.${format}`)
    if (ok) toast.success(format === "pdf" ? "The PDF is downloading." : "The Excel workbook is downloading.")
    setPending(null)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={pending !== null} aria-busy={pending !== null}>
          {pending ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
          {pending ? "Preparing…" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">This report, with its filters</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void run("xlsx")}>
          <FileSpreadsheetIcon aria-hidden="true" />
          Excel workbook
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("pdf")}>
          <FileTextIcon aria-hidden="true" />
          PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

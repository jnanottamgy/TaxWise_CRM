"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { DownloadIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/** `href` plus the current view's search params (search, filters, sort), without paging. */
export function exportHrefFor(href: string, current: URLSearchParams | null): string {
  if (!current) return href
  const params = new URLSearchParams(current.toString())
  params.delete("page")
  params.delete("size")
  const qs = params.toString()
  if (!qs) return href
  return `${href}${href.includes("?") ? "&" : "?"}${qs}`
}

/**
 * CSV export of the current view (§3.4: "CSV export of the current view"). With `href`, links to
 * the export route with the page's search, filters and sort attached (the route re-checks access and
 * writes the `export_run` audit row). With `onExport`, calls it and shows a pending spinner; a thrown
 * error becomes a toast.
 *
 *   <ExportButton href="/api/export/clients" />
 *   <ExportButton onExport={() => exportInvoices(filters)} label="Export CSV" />
 */
export function ExportButton({
  href,
  onExport,
  label = "Export CSV",
  size = "sm",
}: {
  href?: string
  onExport?: () => void | Promise<void>
  label?: string
  size?: "sm" | "default"
}) {
  const searchParams = useSearchParams()
  const [pending, setPending] = React.useState(false)

  if (href) {
    return (
      <Button variant="outline" size={size} asChild>
        <a href={exportHrefFor(href, searchParams)} download>
          <DownloadIcon aria-hidden="true" />
          <span className="max-sm:sr-only">{label}</span>
        </a>
      </Button>
    )
  }
  if (!onExport) return null
  return (
    <Button
      variant="outline"
      size={size}
      disabled={pending}
      aria-busy={pending}
      onClick={async () => {
        setPending(true)
        try {
          await onExport()
        } catch {
          toast.error("The export didn't go through. Please try again.")
        } finally {
          setPending(false)
        }
      }}
    >
      {pending ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
      <span className="max-sm:sr-only">{pending ? "Preparing…" : label}</span>
    </Button>
  )
}

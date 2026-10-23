"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { DownloadIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { downloadBase64 } from "@/components/clients/client-ui"
import { exportLeads } from "@/server/actions/leads"

/** CSV of the leads in the current view (search, filters, sort), audited on the server (§3.4, §12). */
export function LeadExportButton() {
  const searchParams = useSearchParams()
  const [pending, setPending] = React.useState(false)
  const run = async () => {
    const p = new URLSearchParams(searchParams.toString())
    p.delete("page")
    p.delete("size")
    p.delete("view")
    setPending(true)
    try {
      const r = await exportLeads({ query: p.toString() })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      downloadBase64(r.data)
      toast.success(r.data.truncated ? `Exported the first ${r.data.rows.toLocaleString("en-IN")} leads. Narrow the filters to export the rest.` : `Exported ${r.data.rows.toLocaleString("en-IN")} ${r.data.rows === 1 ? "lead" : "leads"}.`)
    } catch {
      toast.error("The export didn't go through. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void run()} disabled={pending} aria-busy={pending}>
      {pending ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
      <span className="max-sm:sr-only">Export CSV</span>
    </Button>
  )
}

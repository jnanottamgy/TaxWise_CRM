"use client"

import * as React from "react"
import { toast } from "sonner"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { gstr2bSourceUrl } from "@/server/actions/gst-recon"

/** Downloads the run's stored GSTR-2B file through a 60-second link signed for the viewer (§12). */
export function Gstr2bSourceDownload({ runId, fileName }: { runId: string; fileName: string }) {
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        const r = await gstr2bSourceUrl({ runId })
        setBusy(false)
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        window.location.assign(r.data.url)
      }}
      aria-label={`Download ${fileName}`}
    >
      {busy ? <Spinner /> : <DownloadIcon aria-hidden="true" />}
      Download
    </Button>
  )
}

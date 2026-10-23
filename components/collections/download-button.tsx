"use client"

import * as React from "react"
import { toast } from "sonner"
import { FileDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Downloads a report from one of the export or PDF routes. The route's refusal (no access, the
 * authenticator code needed, a bad period) comes back as JSON with a sentence and a Ref, and shows
 * as a toast instead of a page of JSON. The file keeps the name the route gives it.
 */

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

export function DownloadButton({
  href,
  label,
  fallbackName,
  variant = "outline",
  size = "sm",
  disabled,
  className,
}: {
  href: string
  label: string
  fallbackName: string
  variant?: "outline" | "ghost" | "default"
  size?: "sm" | "default"
  disabled?: boolean
  className?: string
}) {
  const [busy, setBusy] = React.useState(false)
  const download = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(href, { cache: "no-store" })
      const type = res.headers.get("content-type") ?? ""
      if (!res.ok || type.includes("application/json")) {
        const body = (await res.json().catch(() => null)) as { error?: string; ref?: string } | null
        const message = body?.error ?? "The file couldn't be prepared. Please try again."
        toast.error(body?.ref ? `${message} (Ref ${body.ref})` : message)
        return
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
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button type="button" variant={variant} size={size} onClick={download} disabled={disabled || busy} aria-busy={busy || undefined} className={className}>
      <FileDownIcon aria-hidden="true" />
      {busy ? "Preparing…" : label}
    </Button>
  )
}

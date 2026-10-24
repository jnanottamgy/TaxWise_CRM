import { toast } from "sonner"
import type { ActionResult } from "@/lib/result"

/**
 * Toasts an action's result for buttons that aren't forms: the error with its Ref, each warning
 * (work after the save that didn't go through, §0.1 rule 5), and an optional success line.
 * Shared by the quality, audit and data-protection screens.
 */
export function toastResult<T>(r: ActionResult<T>, success?: string): r is { ok: true; data: T; warnings?: string[] } {
  if (!r.ok) {
    toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
    return false
  }
  for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
  if (success) toast.success(success)
  return true
}

/** Saves a file the server sent as base64 (a CSV export from an action). Browser-only. */
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
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

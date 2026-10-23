"use client"

import { toast } from "sonner"
import type { ActionResult } from "@/lib/result"

/** Toasts an action's result: the error (with its Ref), the warnings, and an optional success line. */
export function toastResult<T>(r: ActionResult<T>, success?: string): r is { ok: true; data: T; warnings?: string[] } {
  if (!r.ok) {
    toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
    return false
  }
  for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
  if (success) toast.success(success)
  return true
}

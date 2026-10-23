"use client"

import { toast } from "sonner"
import type { ActionResult } from "@/lib/result"
import { ENTITY_TYPE_LABELS, SERVICE_TYPE_LABELS, type EntityType, type ServiceType } from "@/lib/domain/enums"

/**
 * Small browser helpers shared by the client list, the wizard and the group pages: running an
 * action with the house toasts (warnings stay up longer, errors carry the Ref), downloading an
 * export, and the short labels the list shows.
 */

/** Runs a server action; shows its warnings and error as toasts. Returns the data, or null on failure. */
export async function runWithToasts<T>(
  call: () => Promise<ActionResult<T>>,
  opts: { success?: string | ((data: T) => string) } = {},
): Promise<T | null> {
  let result: ActionResult<T>
  try {
    result = await call()
  } catch {
    toast.error("We couldn't reach the server. Check your connection and try again.")
    return null
  }
  if (!result.ok) {
    toast.error(result.ref ? `${result.error} (Ref ${result.ref})` : result.error)
    return null
  }
  for (const w of result.warnings ?? []) toast.warning(w, { duration: 12_000 })
  const msg = typeof opts.success === "function" ? opts.success(result.data) : opts.success
  if (msg) toast.success(msg)
  return result.data
}

/** Saves an export the server returned as base64 (no data leaves the page except to the person's disk). */
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

/** Entity badges in the name cell: short forms an Indian CA office uses. */
export const ENTITY_SHORT: Record<EntityType, string> = {
  proprietorship: "Prop.",
  partnership: "Firm",
  llp: "LLP",
  pvt_ltd: "Pvt Ltd",
  public_ltd: "Public Ltd",
  section_8: "Sec. 8",
  trust: "Trust",
  aop: "AOP",
  huf: "HUF",
  individual: "Individual",
  other: "Other",
}

export function entityLabel(type: EntityType | null, other?: string | null): string | null {
  if (!type) return null
  return type === "other" && other ? other : ENTITY_TYPE_LABELS[type]
}

/** Service chips in dense rows. */
export const SERVICE_SHORT: Record<ServiceType, string> = {
  gst: "GST",
  income_tax: "IT",
  tds: "TDS",
  payroll: "Payroll",
  bookkeeping: "Books",
  audit: "Audit",
  company_law: "ROC",
  incorporation: "Incorp.",
  other: "Other",
}

export function serviceTitle(s: ServiceType): string {
  return SERVICE_TYPE_LABELS[s]
}

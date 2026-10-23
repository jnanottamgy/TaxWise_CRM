"use client"

import { toast } from "sonner"
import type { ActionResult } from "@/lib/result"

/**
 * Small browser helpers shared by the Inbox, the message threads, the templates page and the bulk
 * queue: running an action with the house toasts (warnings stay up longer, errors carry the Ref),
 * and telling the shell's bell that the unread count moved (components/shell/staff-shell.tsx
 * listens for `tw:inbox-changed`).
 */

/** Shows an action's error (with Ref) or warnings; returns true on success. */
export function toastResult<T>(r: ActionResult<T>, success?: string | ((data: T) => string)): r is { ok: true; data: T; warnings?: string[] } {
  if (!r.ok) {
    toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
    return false
  }
  for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
  const msg = typeof success === "function" ? success(r.data) : success
  if (msg) toast.success(msg)
  return true
}

/** Runs an action and reports a dropped connection the same way as a refusal. */
export async function runAction<T>(call: () => Promise<ActionResult<T>>, success?: string | ((data: T) => string)): Promise<T | null> {
  let r: ActionResult<T>
  try {
    r = await call()
  } catch {
    toast.error("We couldn't reach the server. Check your connection and try again.")
    return null
  }
  return toastResult(r, success) ? r.data : null
}

/** Asks the top bar to refresh the Inbox count now (§7.17). */
export function announceInboxChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("tw:inbox-changed"))
}

/** A thread was opened and its unread portal messages are read: the list beside it can clear its badge. */
export const THREAD_READ_EVENT = "tw:thread-read"

export function announceThreadRead(clientId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(THREAD_READ_EVENT, { detail: { clientId } }))
}

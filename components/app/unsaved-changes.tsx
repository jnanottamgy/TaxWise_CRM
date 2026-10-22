"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ConfirmDialog } from "@/components/app/confirm-dialog"

/**
 * Warns before leaving a page with unsaved changes (§3.4): the browser's own prompt on reload or tab
 * close, and a confirm dialog when an in-app link is clicked. Render it anywhere on a full-page form.
 *
 *   <UnsavedChangesGuard when={form.formState.isDirty && !form.formState.isSubmitSuccessful} />
 *
 * Dialogs use FormDialog's built-in guard instead.
 */
export function UnsavedChangesGuard({
  when,
  message = "Your changes haven't been saved. If you leave now, they'll be lost.",
}: {
  when: boolean
  message?: string
}) {
  const router = useRouter()
  const [pendingHref, setPendingHref] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!when) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Some browsers still need returnValue set to show their prompt.
      e.returnValue = ""
    }
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return
      const url = new URL(a.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname && url.search === window.location.search) return
      e.preventDefault()
      e.stopPropagation()
      setPendingHref(url.pathname + url.search + url.hash)
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    document.addEventListener("click", onClick, true)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      document.removeEventListener("click", onClick, true)
    }
  }, [when])

  return (
    <ConfirmDialog
      open={pendingHref !== null}
      onOpenChange={(o) => {
        if (!o) setPendingHref(null)
      }}
      title="Leave without saving?"
      description={message}
      confirmLabel="Leave and discard"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => {
        const href = pendingHref
        setPendingHref(null)
        if (href) router.push(href)
      }}
    />
  )
}

/**
 * The "Discard changes?" dialog FormDialog, FormSheet and Wizard show when closed while dirty.
 */
export function DiscardChangesDialog({
  open,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onKeepEditing()
      }}
      title="Discard your changes?"
      description="What you've entered here hasn't been saved. Closing now discards it."
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      destructive
      onConfirm={onDiscard}
    />
  )
}

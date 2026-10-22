"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

/**
 * Confirmation for destructive or irreversible actions (§3.4: delete, send to client, approve,
 * issue credit note, disable user). The title asks the question; the body says exactly what will
 * happen. `typeToConfirm` makes the user type a word (or the record's name) first, for purges.
 * While `onConfirm` runs, the dialog stays open with a spinner; it closes when it resolves to
 * anything but `false`.
 *
 *   <ConfirmDialog
 *     open={open} onOpenChange={setOpen}
 *     title="Delete Sharma Traders?"
 *     description="The client, its 14 open tasks and 3 document requests move to the recycle bin. A Partner can restore them for 30 days."
 *     confirmLabel="Delete client"
 *     destructive
 *     onConfirm={async () => { const r = await deleteClient({ id }); if (!r.ok) { toast.error(r.error); return false } }}
 *   />
 *   <ConfirmDialog … typeToConfirm="PURGE" title="Purge 12 items permanently?" />
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  details,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  typeToConfirm,
  onConfirm,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Optional trigger element (uncontrolled use). */
  trigger?: React.ReactElement
  title: React.ReactNode
  /** Exactly what will happen, in a sentence or two. */
  description: React.ReactNode
  /** Extra content: the list of affected records, a reason field. */
  details?: React.ReactNode
  /** Names the action: "Delete client", "Send to client", "Issue credit note". Never just "OK". */
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  /** The exact text to type before the action unlocks. */
  typeToConfirm?: string
  /** Return false to keep the dialog open (e.g. the action failed and you showed why). */
  onConfirm: () => void | boolean | Promise<void | boolean>
}) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const isOpen = open ?? internalOpen
  const [typed, setTyped] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const inputId = React.useId()

  const setOpen = (next: boolean) => {
    if (pending) return
    if (!next) setTyped("")
    if (open === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  const locked = !!typeToConfirm && typed.trim() !== typeToConfirm

  const confirm = async () => {
    if (locked || pending) return
    setPending(true)
    try {
      const result = await onConfirm()
      if (result !== false) {
        setTyped("")
        if (open === undefined) setInternalOpen(false)
        onOpenChange?.(false)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialogPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger> : null}
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 ease-out starting:opacity-0" />
        <AlertDialogPrimitive.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[min(92dvh,40rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-surface text-text shadow-2 outline-none",
            "transition-[opacity,scale] duration-200 ease-out starting:scale-[0.98] starting:opacity-0"
          )}
          onEscapeKeyDown={(e) => pending && e.preventDefault()}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-4">
            <AlertDialogPrimitive.Title className="text-md leading-6 font-semibold text-text">{title}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-2 text-base text-text-muted">
              {description}
            </AlertDialogPrimitive.Description>
            {details ? <div className="mt-3 text-base">{details}</div> : null}
            {typeToConfirm ? (
              <div className="mt-4 flex flex-col gap-2">
                <label htmlFor={inputId} className="text-sm font-medium text-text">
                  Type <span className="font-mono">{typeToConfirm}</span> to confirm
                </label>
                <Input
                  id={inputId}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void confirm()
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="sticky bottom-0 flex flex-shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t border-border bg-surface px-6 py-3 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline" disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={locked || pending}
              aria-busy={pending}
              onClick={() => void confirm()}
            >
              {pending ? <Spinner /> : null}
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}

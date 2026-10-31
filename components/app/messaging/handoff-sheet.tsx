"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The small preview sheet both hand-off buttons open (§7.13.2: recipient, editable draft, template
 * picker, then "Open WhatsApp"). Docks to the right on desktop and to the bottom on phones; footer
 * sticky like every dialog.
 */
export function HandoffSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 ease-out starting:opacity-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border-border bg-surface text-text shadow-2 outline-none transition-[translate,opacity] duration-200 ease-out",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl border-t starting:translate-y-8",
            "sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:h-dvh sm:max-h-none sm:w-[min(100%,28rem)] sm:rounded-l-xl sm:rounded-tr-none sm:border-t-0 sm:border-l sm:starting:translate-x-full sm:starting:translate-y-0"
          )}
        >
          <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="font-serif text-[20px] leading-7 font-medium tracking-[-0.005em] text-text">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-sm text-text-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mt-1 -mr-2 inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:size-11"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
          <div className="sticky bottom-0 flex flex-shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** "+91 98450 12345" for an Indian mobile in E.164 digits; "+44 7700 900123"-ish grouping otherwise. */
export function displayPhone(digits: string): string {
  if (/^91[6-9]\d{9}$/.test(digits)) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`
  return `+${digits}`
}

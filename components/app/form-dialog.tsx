"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DiscardChangesDialog } from "@/components/app/unsaved-changes"

/*
 * Dialog and sheet frames for forms (§0.1 rule 4, §3.4). Header, a body that scrolls, and a footer
 * that is ALWAYS visible: `position: sticky; bottom: 0; flex-shrink: 0` under a scrolling body, with
 * the whole frame capped at `max-height: min(…, 92dvh)` so Save is on screen at 1366×768 and
 * 390×844. Nothing inside sets a min-height above min(560px, 68dvh). On phones the dialog docks to
 * the bottom of the screen as a sheet.
 *
 * Closing while `dirty` asks "Discard your changes?" first (Esc, overlay click, ✕ and Cancel).
 */

export interface FormFrameProps {
  title: React.ReactNode
  description?: React.ReactNode
  /** The form's submit handler (e.g. useActionForm's `onSubmit`). Omit for a dialog with its own form. */
  onSubmit?: React.FormEventHandler<HTMLFormElement>
  submitLabel?: string
  cancelLabel?: string
  /** Shows a spinner on the submit button and blocks closing. */
  pending?: boolean
  /** Disable submit (e.g. nothing to save). */
  submitDisabled?: boolean
  /** Left side of the footer: "Draft saved · 12:41", a hint. */
  footerStart?: React.ReactNode
  /** Replace the default Cancel + submit buttons. */
  footer?: React.ReactNode
  /** Unsaved changes: closing asks first. */
  dirty?: boolean
  /** Body content (form fields). */
  children: React.ReactNode
  bodyClassName?: string
}

const SIZE: Record<"sm" | "md" | "lg" | "xl", string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-xl",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-5xl",
}

function useGuardedOpen(open: boolean, onOpenChange: (open: boolean) => void, dirty: boolean, pending: boolean) {
  const [confirming, setConfirming] = React.useState(false)
  const request = (next: boolean) => {
    if (next) return onOpenChange(true)
    if (pending) return
    if (dirty) return setConfirming(true)
    onOpenChange(false)
  }
  return {
    request,
    discard: (
      <DiscardChangesDialog
        open={open && confirming}
        onKeepEditing={() => setConfirming(false)}
        onDiscard={() => {
          setConfirming(false)
          onOpenChange(false)
        }}
      />
    ),
  }
}

function FrameInner({
  title,
  description,
  onSubmit,
  submitLabel = "Save",
  cancelLabel = "Cancel",
  pending = false,
  submitDisabled = false,
  footerStart,
  footer,
  children,
  bodyClassName,
  onCancel,
}: FormFrameProps & { onCancel: () => void }) {
  const content = (
    <>
      <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <DialogPrimitive.Title className="text-md leading-6 font-semibold text-text">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-0.5 text-sm text-text-muted">{description}</DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : "Form"}</DialogPrimitive.Description>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="-mt-1 -mr-2 inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:size-11"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div
        data-slot="form-dialog-body"
        className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6", bodyClassName)}
      >
        {children}
      </div>
      <div
        data-slot="form-dialog-footer"
        className="sticky bottom-0 flex flex-shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
      >
        <div className="min-w-0 text-sm text-text-muted">{footerStart}</div>
        {footer ?? (
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button type={onSubmit ? "submit" : "button"} disabled={pending || submitDisabled} aria-busy={pending}>
              {pending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </div>
        )}
      </div>
    </>
  )

  return onSubmit ? (
    <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      {content}
    </form>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">{content}</div>
  )
}

/**
 * A form in a dialog.
 *
 *   const f = useActionForm(TaskSchema, createTask, { defaultValues, onSuccess: () => setOpen(false) })
 *   <FormDialog
 *     open={open} onOpenChange={setOpen}
 *     title="New task" description="GSTR-3B · Sep 2026 for TW-C-0042 · Sharma Traders"
 *     onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty}
 *     submitLabel="Create task"
 *   >
 *     <FormAlert state={f} />
 *     <TextField control={f.form.control} name="title" label="Title" required />
 *   </FormDialog>
 *
 * `size="full"` is the full-screen variant for wizards (§7.3.2).
 */
export function FormDialog({
  open,
  onOpenChange,
  size = "md",
  trigger,
  ...frame
}: FormFrameProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
  size?: "sm" | "md" | "lg" | "xl" | "full"
  trigger?: React.ReactElement
}) {
  const guard = useGuardedOpen(open, onOpenChange, !!frame.dirty, !!frame.pending)
  const full = size === "full"
  return (
    <DialogPrimitive.Root open={open} onOpenChange={guard.request}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 ease-out starting:opacity-0" />
        <DialogPrimitive.Content
          data-slot="form-dialog"
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border border-border bg-surface text-text shadow-2 outline-none",
            "transition-[opacity,translate,scale] duration-200 ease-out starting:opacity-0",
            full
              ? "inset-0 h-dvh w-full sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,56rem)] sm:w-[min(calc(100vw-2rem),76rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:starting:scale-[0.98]"
              : cn(
                  "inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-xl starting:translate-y-6",
                  "sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(92dvh,48rem)] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:starting:-translate-y-1/2 sm:starting:scale-[0.98]",
                  SIZE[size]
                )
          )}
          onInteractOutside={(e) => {
            if (frame.pending) e.preventDefault()
          }}
        >
          <FrameInner {...frame} onCancel={() => guard.request(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      {guard.discard}
    </DialogPrimitive.Root>
  )
}

/**
 * A form in a side sheet (edit panels beside a list or detail page). Same frame and guard as
 * FormDialog; full width on phones.
 *
 *   <FormSheet open={open} onOpenChange={setOpen} title="Edit contact" onSubmit={f.onSubmit} pending={f.pending} dirty={isDirty}>
 *     …fields
 *   </FormSheet>
 */
export function FormSheet({
  open,
  onOpenChange,
  side = "right",
  width = "md",
  trigger,
  ...frame
}: FormFrameProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: "right" | "left"
  width?: "sm" | "md" | "lg"
  trigger?: React.ReactElement
}) {
  const guard = useGuardedOpen(open, onOpenChange, !!frame.dirty, !!frame.pending)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={guard.request}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 ease-out starting:opacity-0" />
        <DialogPrimitive.Content
          data-slot="form-sheet"
          className={cn(
            "fixed inset-y-0 z-50 flex h-dvh w-full flex-col overflow-hidden border-border bg-surface text-text shadow-2 outline-none",
            "transition-[translate,opacity] duration-200 ease-out",
            side === "right" ? "right-0 border-l starting:translate-x-full sm:rounded-l-xl" : "left-0 border-r starting:-translate-x-full sm:rounded-r-xl",
            width === "sm" ? "sm:max-w-sm" : width === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg"
          )}
          onInteractOutside={(e) => {
            if (frame.pending) e.preventDefault()
          }}
        >
          <FrameInner {...frame} onCancel={() => guard.request(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      {guard.discard}
    </DialogPrimitive.Root>
  )
}

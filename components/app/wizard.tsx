"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { CheckIcon, ChevronLeftIcon, LockIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DiscardChangesDialog } from "@/components/app/unsaved-changes"
import { canComplete, stepLabel, stepStates, type StepState } from "@/components/app/wizard-state"

export interface WizardStep {
  id: string
  title: string
  /** One grey line under the title in the sidebar: "Name, PAN, entity type". */
  description?: string
  /** The step's fields pass validation (drives ✓ and unlocking). */
  valid: boolean
  optional?: boolean
}

export interface WizardProps {
  title: React.ReactNode
  steps: WizardStep[]
  current: number
  onStepChange: (index: number) => void
  /**
   * Validate the current step before moving on (e.g. `() => form.trigger(["name", "pan"])`).
   * Return false to stay. Defaults to the step's `valid`.
   */
  onContinue?: () => boolean | Promise<boolean>
  onComplete: () => void | Promise<void>
  /** Shows "Save draft" in the footer. */
  onSaveDraft?: () => void | Promise<void>
  /** "Draft saved · 12:41" (a <DraftStamp />). */
  draftStatus?: React.ReactNode
  completeLabel?: string
  pending?: boolean
  /** Close button in the header (WizardDialog wires it). */
  onClose?: () => void
  /** The current step's fields. */
  children: React.ReactNode
  className?: string
}

/**
 * A multi-step form frame (§7.3.2): a steps sidebar on desktop (a compact top stepper on phones)
 * with ✓ on valid steps; steps unlock in order; a sticky footer with Back · Save draft ·
 * Continue / Complete and the draft stamp. Fills its parent's height: use it in WizardDialog
 * (full screen) or a full-page route.
 *
 *   <WizardDialog open={open} onOpenChange={setOpen} dirty={isDirty}
 *     title="Add client" steps={steps} current={step} onStepChange={setStep}
 *     onContinue={() => form.trigger(STEP_FIELDS[step])} onComplete={f.onSubmit}
 *     onSaveDraft={draft.saveNow} draftStatus={<DraftStamp {...draft} />} completeLabel="Create client" pending={f.pending}>
 *     {step === 0 ? <IdentityStep control={f.control} /> : …}
 *   </WizardDialog>
 */
export function Wizard({
  title,
  steps,
  current,
  onStepChange,
  onContinue,
  onComplete,
  onSaveDraft,
  draftStatus,
  completeLabel = "Complete",
  pending = false,
  onClose,
  children,
  className,
}: WizardProps) {
  const states = stepStates(steps, current)
  const isLast = current === steps.length - 1
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const [advancing, setAdvancing] = React.useState(false)
  const [savingDraft, setSavingDraft] = React.useState(false)
  const busy = pending || advancing

  const go = (i: number) => {
    onStepChange(i)
    requestAnimationFrame(() => headingRef.current?.focus())
  }

  const next = async () => {
    setAdvancing(true)
    try {
      const ok = onContinue ? await onContinue() : steps[current]?.valid
      if (!ok) return
      if (isLast) {
        if (canComplete(steps) || onContinue) await onComplete()
      } else {
        go(current + 1)
      }
    } finally {
      setAdvancing(false)
    }
  }

  const step = steps[current]

  return (
    <div data-slot="wizard" className={cn("flex h-full min-h-0 flex-col bg-surface", className)}>
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <div className="text-md leading-6 font-semibold text-text">{title}</div>
          <p className="text-sm text-text-muted lg:hidden">
            {stepLabel(current, steps.length)} · {step?.title}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:size-11"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* Phone / tablet stepper: one segment per step. */}
      <ol className="flex flex-shrink-0 gap-1 px-4 pt-3 sm:px-6 lg:hidden" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.id} className="flex-1">
            <button
              type="button"
              disabled={states[i] === "locked"}
              onClick={() => go(i)}
              aria-current={i === current ? "step" : undefined}
              aria-label={`${s.title}${states[i] === "complete" ? ", done" : states[i] === "locked" ? ", locked" : ""}`}
              className={cn(
                "relative block h-1.5 w-full cursor-pointer rounded-full transition-colors duration-150 disabled:cursor-not-allowed pointer-coarse:after:absolute pointer-coarse:after:-inset-y-4 pointer-coarse:after:content-['']",
                i === current ? "bg-primary" : states[i] === "complete" ? "bg-success" : "bg-border"
              )}
            />
          </li>
        ))}
      </ol>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Steps" className="hidden w-64 flex-none overflow-y-auto border-r border-border bg-surface-2/40 p-3 lg:block">
          <ol className="flex flex-col gap-0.5">
            {steps.map((s, i) => (
              <li key={s.id}>
                <StepButton index={i} step={s} state={states[i]} onClick={() => go(i)} />
              </li>
            ))}
          </ol>
        </nav>
        <div data-slot="wizard-body" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg leading-7 font-semibold text-text outline-none">
              {step?.title}
            </h2>
            {step?.description ? <p className="mt-0.5 text-base text-text-muted">{step.description}</p> : null}
            <div className="mt-5">{children}</div>
          </div>
        </div>
      </div>

      <div
        data-slot="wizard-footer"
        className="sticky bottom-0 flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
      >
        {/* Phones: Back is icon-only, so Back · Save draft · Complete stay on one row above the stamp. */}
        <Button type="button" variant="outline" onClick={() => go(current - 1)} disabled={current === 0 || busy} className="max-sm:px-2.5">
          <ChevronLeftIcon aria-hidden="true" />
          <span className="max-sm:sr-only">Back</span>
        </Button>
        <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">{draftStatus}</div>
        <div className="ml-auto flex items-center gap-2">
          {onSaveDraft ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy || savingDraft}
              onClick={async () => {
                setSavingDraft(true)
                try {
                  await onSaveDraft()
                } finally {
                  setSavingDraft(false)
                }
              }}
            >
              {savingDraft ? <Spinner /> : null}
              Save draft
            </Button>
          ) : null}
          <Button type="button" onClick={() => void next()} disabled={busy} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {isLast ? completeLabel : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StepButton({
  index,
  step,
  state,
  onClick,
}: {
  index: number
  step: WizardStep
  state: StepState
  onClick: () => void
}) {
  const locked = state === "locked"
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked}
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed",
        state === "current" ? "bg-primary-soft" : !locked && "hover:bg-surface-2"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "num mt-px flex size-6 flex-none items-center justify-center rounded-full border text-xs font-medium tabular-nums",
          state === "current" && "border-primary bg-primary text-primary-foreground",
          state === "complete" && "border-success bg-success-soft text-success-text",
          state === "available" && "border-text-muted/40 bg-surface text-text",
          state === "locked" && "border-border bg-surface text-text-muted"
        )}
      >
        {state === "complete" ? <CheckIcon className="size-3.5" /> : locked ? <LockIcon className="size-3" /> : index + 1}
      </span>
      <span className="min-w-0">
        <span className={cn("block text-base leading-5 font-medium", state === "current" ? "text-primary" : locked ? "text-text-muted" : "text-text")}>
          {step.title}
          {step.optional ? <span className="font-normal text-text-muted"> (optional)</span> : null}
        </span>
        {step.description ? <span className="mt-0.5 block text-sm leading-5 text-text-muted">{step.description}</span> : null}
        <span className="sr-only">{state === "complete" ? "Done" : locked ? "Locked until the earlier steps are done" : ""}</span>
      </span>
    </button>
  )
}

/**
 * The Wizard in a full-screen dialog (the client wizard's "full-screen dialog", §7.3.2). Closing
 * while `dirty` asks first.
 */
export function WizardDialog({
  open,
  onOpenChange,
  dirty = false,
  ...wizard
}: Omit<WizardProps, "onClose"> & { open: boolean; onOpenChange: (open: boolean) => void; dirty?: boolean }) {
  const [confirming, setConfirming] = React.useState(false)
  const request = (next: boolean) => {
    if (next) return onOpenChange(true)
    if (wizard.pending) return
    if (dirty) return setConfirming(true)
    onOpenChange(false)
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={request}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 ease-out starting:opacity-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex h-dvh w-full flex-col overflow-hidden bg-surface text-text shadow-2 outline-none transition-[opacity,scale] duration-200 ease-out starting:opacity-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,56rem)] sm:w-[min(calc(100vw-2rem),76rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-border sm:starting:scale-[0.98]"
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            // Radix would focus the first button, the header's Close, and ring it. With a mouse or
            // trackpad start in the step's first field instead; on touch screens focus the step's
            // heading, so the keyboard doesn't jump up over the step before the person reads it.
            e.preventDefault()
            const content = e.currentTarget as HTMLElement | null
            const body = content?.querySelector<HTMLElement>('[data-slot="wizard-body"]')
            if (!content || !body) return
            const field = window.matchMedia("(pointer: fine)").matches
              ? body.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)")
              : null
            ;(field ?? body.querySelector<HTMLElement>("h2[tabindex]") ?? content).focus({ preventScroll: true })
          }}
        >
          <DialogPrimitive.Title className="sr-only">{typeof wizard.title === "string" ? wizard.title : "Wizard"}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{stepLabel(wizard.current, wizard.steps.length)}</DialogPrimitive.Description>
          <Wizard {...wizard} onClose={() => request(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      <DiscardChangesDialog
        open={open && confirming}
        onKeepEditing={() => setConfirming(false)}
        onDiscard={() => {
          setConfirming(false)
          onOpenChange(false)
        }}
      />
    </DialogPrimitive.Root>
  )
}

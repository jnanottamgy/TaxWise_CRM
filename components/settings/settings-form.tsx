"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { DefaultValues, FieldValues } from "react-hook-form"
import type { z } from "zod"
import { RotateCwIcon } from "lucide-react"
import type { ActionResult } from "@/lib/result"
import { formatDateTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { useActionForm, type ActionFormState } from "@/hooks/use-action-form"
import type { LastChange } from "@/lib/data/settings"

/**
 * A settings panel's form (§7.21, taste §8.2: one Save per view): react-hook-form + the shared zod
 * schema, the form-level alert, an unsaved-changes guard, and a footer that sticks to the bottom of
 * the window while the form is longer than the screen.
 *
 * After a save the form keeps the values it sent and takes the new `updated_at`, so the next save
 * passes the concurrency check (§13); the page then refreshes on the server. A conflict says who
 * changed the settings and offers Reload.
 */
export function useSettingsForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  action: (input: z.input<S>) => Promise<ActionResult<{ updated_at: string; changed?: number }>>,
  defaultValues: DefaultValues<z.input<S>>,
  opts: { savedMessage?: string; onSaved?: (data: { updated_at: string; changed?: number }) => void } = {}
) {
  const router = useRouter()
  const [conflict, setConflict] = React.useState(false)
  const wrapped = React.useCallback(
    async (input: z.input<S>) => {
      const r = await action(input)
      setConflict(!r.ok && r.code === "conflict")
      return r
    },
    [action]
  )
  const f = useActionForm(schema, wrapped, {
    defaultValues,
    resetOnSuccess: false,
    onSuccess: (data, values) => {
      f.form.reset({ ...values, updated_at: data.updated_at } as z.input<S>)
      if (data.changed === 0) toast.info("Nothing had changed, so nothing was saved.")
      else toast.success(opts.savedMessage ?? "Settings saved")
      opts.onSaved?.(data)
      router.refresh()
    },
  })
  return { ...f, conflict }
}

export function SettingsForm<In extends FieldValues, Out, T>({
  state,
  lastChange,
  submitLabel = "Save changes",
  conflict = false,
  children,
}: {
  state: ActionFormState<In, Out, T>
  lastChange?: LastChange | null
  submitLabel?: string
  conflict?: boolean
  children: React.ReactNode
}) {
  const router = useRouter()
  const [reloading, startReload] = React.useTransition()
  const { form, pending } = state
  const dirty = form.formState.isDirty

  return (
    <form noValidate onSubmit={state.onSubmit} className="flex min-w-0 flex-col gap-4 md:gap-5">
      <UnsavedChangesGuard when={dirty && !pending} />
      {state.formError ? (
        <div>
          <FormAlert state={state} className="mb-0" />
          {conflict ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={reloading}
              onClick={() =>
                startReload(() => {
                  // The page keys each settings form on the row's updated_at, so the refreshed row
                  // remounts the form with the other person's values and the new token.
                  form.reset()
                  state.clearFormError()
                  router.refresh()
                })
              }
            >
              <RotateCwIcon aria-hidden="true" className={reloading ? "animate-spin" : undefined} />
              Reload to see their changes
            </Button>
          ) : null}
        </div>
      ) : null}

      {children}

      <div
        data-slot="settings-footer"
        className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:mx-0 md:rounded-lg md:border md:px-5"
      >
        <p className="min-w-0 text-sm text-text-muted" aria-live="polite">
          {dirty ? (
            <span className="font-medium text-warning-text">Unsaved changes</span>
          ) : lastChange?.at ? (
            <>
              Last changed{lastChange.byName ? ` by ${lastChange.byName}` : ""} · <span className="num">{formatDateTime(lastChange.at)}</span>
            </>
          ) : (
            "No changes yet"
          )}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <Button type="button" variant="outline" disabled={pending} onClick={() => form.reset()}>
              Discard
            </Button>
          ) : null}
          <Button type="submit" disabled={pending || !dirty} aria-busy={pending}>
            {pending ? <Spinner /> : null}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}

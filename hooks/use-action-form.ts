"use client"

import * as React from "react"
import { useForm, type Control, type Resolver, type DefaultValues, type FieldValues, type Path, type UseFormReturn } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import type { z } from "zod"
import type { ActionResult } from "@/lib/result"

/*
 * Each form's DOM id prefix, keyed by its react-hook-form control, so field components can give
 * their inputs predictable ids (`<formId>-<name>`) without a provider. Browser-only UI state.
 */
const formIds = new WeakMap<object, string>()

/** The id prefix for fields of the form that owns `control` ("f" when the form isn't a useActionForm). */
export function formIdFor(control: unknown): string {
  if (!control || typeof control !== "object") return "f"
  return formIds.get(control) ?? "f"
}

/** The DOM id of a field's input: `fieldDomId(control, "contacts.0.email")`. */
export function fieldDomId(control: unknown, name: string): string {
  return `${formIdFor(control)}-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

export interface FormError {
  message: string
  ref?: string
  /** Server field errors that have no field on screen: shown as a list in the alert. */
  unplaced?: Array<{ name: string; message: string }>
  /** Client validation failed (fields are highlighted; focus went to the first one). */
  client?: boolean
}

export interface UseActionFormOptions<In extends FieldValues, T> {
  defaultValues?: DefaultValues<In>
  /** After a successful save: close the dialog, navigate, refresh. */
  onSuccess?: (data: T, values: In) => void | Promise<void>
  /** Toast on success ("Client saved"). Omit when the next screen says it already. */
  successMessage?: string | ((data: T) => string)
  /** After success, reset the form to the submitted values (clears dirty). Default true. */
  resetOnSuccess?: boolean
  /** Validate on blur and again on submit (default), or on every change. */
  mode?: "onBlur" | "onChange" | "onSubmit" | "onTouched" | "all"
}

export interface ActionFormState<In extends FieldValues, Out, T> {
  form: UseFormReturn<In, unknown, Out>
  control: Control<In, unknown, Out>
  /** Pass to <form onSubmit> or FormDialog's onSubmit. */
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>
  pending: boolean
  formError: FormError | null
  clearFormError: () => void
  /** Attach to the FormAlert (it does this itself when given `state`). */
  alertRef: React.RefObject<HTMLDivElement | null>
  /** The last successful result's data. */
  lastData: T | undefined
}

/**
 * react-hook-form + zodResolver wired to a server action (CONVENTIONS §5, §0.2):
 * - validates on blur and on submit with the shared zod schema;
 * - sends the RAW input to the action (the server parses it again with the same schema);
 * - maps `result.fieldErrors` onto the fields (`setError`), and lists any it can't place;
 * - shows `result.error` in the form-level alert (with Ref + copy), which receives focus;
 * - shows `result.warnings` as warning toasts (work after the save that didn't go through);
 * - keeps the user's input on any error.
 *
 *   const f = useActionForm(ClientSchema, createClient, {
 *     defaultValues: { name: "", pan: "" },
 *     successMessage: "Client added",
 *     onSuccess: ({ id }) => router.push(`/clients/${id}`),
 *   })
 *   <form onSubmit={f.onSubmit} noValidate>
 *     <FormAlert state={f} />
 *     <TextField control={f.control} name="name" label="Client name" required />
 *     <Button type="submit" disabled={f.pending}>Save</Button>
 *   </form>
 */
export function useActionForm<S extends z.ZodType<FieldValues, FieldValues>, T>(
  schema: S,
  action: (input: z.input<S>) => Promise<ActionResult<T>>,
  opts: UseActionFormOptions<z.input<S>, T> = {}
): ActionFormState<z.input<S>, z.output<S>, T> {
  type In = z.input<S>
  type Out = z.output<S>

  const form = useForm<In, unknown, Out>({
    resolver: zodResolver(schema) as unknown as Resolver<In, unknown, Out>,
    defaultValues: opts.defaultValues,
    mode: opts.mode ?? "onBlur",
    reValidateMode: "onChange",
    shouldFocusError: true,
  })

  const id = React.useId()
  const control = form.control
  // Registered once, before the first field renders, so field ids are stable from the first paint.
  React.useState(() => {
    formIds.set(control, `form${id.replace(/[^a-zA-Z0-9]/g, "")}`)
    return null
  })

  const [formError, setFormError] = React.useState<FormError | null>(null)
  const [lastData, setLastData] = React.useState<T | undefined>(undefined)
  const alertRef = React.useRef<HTMLDivElement | null>(null)
  const optsRef = React.useRef(opts)
  React.useEffect(() => {
    optsRef.current = opts
  })

  const focusAlert = () => {
    requestAnimationFrame(() => alertRef.current?.focus())
  }

  const onValid = async () => {
    setFormError(null)
    const values = form.getValues()
    let result: ActionResult<T>
    try {
      result = await action(values)
    } catch {
      setFormError({ message: "We couldn't reach the server. Check your connection and try again." })
      focusAlert()
      return
    }

    if (!result.ok) {
      const unplaced: Array<{ name: string; message: string }> = []
      let formLevel: string | undefined
      for (const [name, messages] of Object.entries(result.fieldErrors ?? {})) {
        const message = messages[0]
        if (!message) continue
        if (name === "_form" || name === "") {
          formLevel = message
          continue
        }
        form.setError(name as Path<In>, { type: "server", message })
        if (typeof document !== "undefined" && !document.getElementById(fieldDomId(control, name))) {
          unplaced.push({ name, message })
        }
      }
      setFormError({
        message: formLevel && result.code === "validation" ? formLevel : result.error,
        ref: result.ref,
        unplaced: unplaced.length ? unplaced : undefined,
      })
      focusAlert()
      return
    }

    for (const w of result.warnings ?? []) toast.warning(w, { duration: 12_000 })
    const o = optsRef.current
    const msg = typeof o.successMessage === "function" ? o.successMessage(result.data) : o.successMessage
    if (msg) toast.success(msg)
    if (o.resetOnSuccess !== false) form.reset(values)
    setLastData(result.data)
    await o.onSuccess?.(result.data, values)
  }

  const onInvalid = () => {
    const count = Object.keys(form.formState.errors).length
    setFormError({
      message: count > 1 ? `Please check the ${count} highlighted fields.` : "Please check the highlighted field.",
      client: true,
    })
  }

  // Built at event time, so nothing reads refs during render.
  const onSubmit = (e?: React.BaseSyntheticEvent) => form.handleSubmit(onValid, onInvalid)(e)

  return {
    form,
    control,
    onSubmit,
    pending: form.formState.isSubmitting,
    formError,
    clearFormError: () => setFormError(null),
    alertRef,
    lastData,
  }
}

"use client";

import { useRef, useState } from "react";
import { useForm, type DefaultValues, type FieldValues, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import type { ActionResult } from "@/lib/result";

/**
 * The auth forms' submit loop (CONVENTIONS §5): react-hook-form with the shared zod schema,
 * validate on blur then on change, call the server action, put server field errors on their
 * fields, show anything else in a form-level alert that takes focus, keep the user's input.
 */

export interface FormNotice {
  message: string;
  ref?: string;
}

const OFFLINE = "We couldn't reach TaxWise. Check your internet connection and try again.";

/** Full page load: after a sign-in state change the proxy and every layout must see the new cookies. */
export function navigateTo(path: string) {
  window.location.assign(path);
}

export function useAuthForm<TValues extends FieldValues, TOutput extends FieldValues, TData>({
  schema,
  defaultValues,
  action,
  onSuccess,
  onFailure,
}: {
  schema: z.ZodType<TOutput, TValues>;
  defaultValues: DefaultValues<TValues>;
  action: (values: TValues) => Promise<ActionResult<TData>>;
  /** Return true to keep the form busy (a navigation is under way). */
  onSuccess: (data: TData, warnings: string[]) => boolean | void;
  /** Runs after a refused submit, once errors are shown (e.g. clear a one-time code). */
  onFailure?: () => void;
}) {
  const form = useForm<TValues, unknown, TOutput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema as any) as any,
    defaultValues,
    mode: "onTouched",
  });
  const [formError, setFormError] = useState<FormNotice | null>(null);
  const [leaving, setLeaving] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const showFormError = (notice: FormNotice) => {
    setFormError(notice);
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const onValid = async () => {
    setFormError(null);
    // The raw values go to the server, which parses them again with the same schema.
    const values = form.getValues();
    let result: ActionResult<TData>;
    try {
      result = await action(values);
    } catch {
      showFormError({ message: OFFLINE });
      return;
    }
    if (!result.ok) {
      let firstField: string | null = null;
      for (const [name, messages] of Object.entries(result.fieldErrors ?? {})) {
        if (name === "_form" || !messages?.length) continue;
        form.setError(name as Path<TValues>, { type: "server", message: messages[0] });
        firstField ??= name;
      }
      if (firstField && result.code === "validation") {
        form.setFocus(firstField as Path<TValues>);
      } else {
        showFormError({ message: result.error, ref: result.ref });
      }
      onFailure?.();
      return;
    }
    if (onSuccess(result.data, result.warnings ?? [])) setLeaving(true);
  };

  // An event handler (never called during render): validate with the schema, then run onValid.
  const submit = (event?: React.BaseSyntheticEvent) => form.handleSubmit(onValid)(event);

  return {
    form,
    submit,
    formError,
    alertRef,
    clearFormError: () => setFormError(null),
    busy: form.formState.isSubmitting || leaving,
  };
}

"use client";

import { useState } from "react";
import { useWatch, type FieldPath } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { completeSetup } from "@/server/actions/setup";
import { SetupSchema, type SetupInput } from "@/lib/schemas/auth";
import { cn } from "@/lib/utils";
import { describedBy, FormField, FormMessage, PasswordChecklist, PasswordInput, SubmitButton } from "../_components/form-bits";
import { navigateTo, useAuthForm } from "../_components/use-auth-form";
import type { FirmDetails } from "../_lib/firm-defaults";

interface StateOption {
  code: string;
  name: string;
}

/**
 * First run (§4.3): the first Partner's login, then the firm's details from §1, pre-filled.
 * Two columns once the card is wide enough, one on a phone; the submit row stays in view.
 */
export function SetupForm({ firm, lockedEmail, states }: { firm: FirmDetails; lockedEmail: string | null; states: StateOption[] }) {
  const [done, setDone] = useState<{ redirectTo: string; warnings: string[] } | null>(null);
  const defaults = {
    fullName: "",
    email: lockedEmail ?? "",
    password: "",
    confirm: "",
    ...firm,
  } satisfies SetupInput;
  const { form, submit, formError, alertRef, busy } = useAuthForm({
    schema: SetupSchema,
    defaultValues: defaults,
    action: completeSetup,
    onSuccess: ({ redirectTo }, warnings) => {
      if (warnings.length === 0) {
        navigateTo(redirectTo);
        return true;
      }
      setDone({ redirectTo, warnings });
    },
  });
  const {
    register,
    control,
    formState: { errors },
  } = form;
  const password = useWatch({ control, name: "password" }) ?? "";

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <FormMessage tone="warning" notice={{ message: "Your Partner login is ready." }}>
          {done.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </FormMessage>
        <Button size="lg" className="w-full" onClick={() => navigateTo(done.redirectTo)}>
          Continue
        </Button>
      </div>
    );
  }

  const text = (
    name: FieldPath<SetupInput>,
    label: string,
    opts: {
      required?: boolean;
      type?: string;
      autoComplete?: string;
      inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
      helper?: string;
      className?: string;
      inputClassName?: string;
      readOnly?: boolean;
      maxLength?: number;
    } = {},
  ) => {
    const error = errors[name as keyof typeof errors]?.message as string | undefined;
    const helperId = opts.helper ? `${name}-help` : undefined;
    return (
      <FormField
        label={label}
        htmlFor={name}
        required={opts.required}
        helper={opts.helper}
        helperId={helperId}
        error={error}
        className={opts.className}
      >
        <Input
          id={name}
          type={opts.type ?? "text"}
          autoComplete={opts.autoComplete ?? "off"}
          inputMode={opts.inputMode}
          readOnly={opts.readOnly}
          maxLength={opts.maxLength}
          // Rendered on the server too, so pre-filled values don't flash empty before hydration.
          defaultValue={(defaults as Record<string, string | undefined>)[name]}
          aria-required={opts.required ? "true" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(helperId, error && `${name}-error`)}
          className={cn("h-10", opts.inputClassName)}
          {...register(name)}
        />
      </FormField>
    );
  };

  const stateError = errors.stateCode?.message;
  const addressError = errors.address?.message;

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="@container flex flex-col gap-8">
      <FormMessage notice={formError} alertRef={alertRef} />

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 flex flex-col gap-1">
          <span className="text-md font-semibold text-text">Your login</span>
          <span className="text-sm text-text-muted">You become the first Partner. You&apos;ll add the team after this.</span>
        </legend>
        <div className="grid gap-4 @md:grid-cols-2">
          {text("fullName", "Full name", { required: true, autoComplete: "name" })}
          {text("email", "Email", {
            required: true,
            type: "email",
            autoComplete: "username",
            inputMode: "email",
            readOnly: !!lockedEmail,
            helper: lockedEmail ? "Set for this installation." : "You'll sign in with this.",
          })}
          <FormField
            label="Password"
            htmlFor="password"
            required
            error={errors.password?.message}
            helper={<PasswordChecklist id="password-rules" password={password} columns={2} />}
            className="@md:col-span-2"
          >
            <PasswordInput
              id="password"
              autoComplete="new-password"
              aria-required="true"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={describedBy("password-rules", errors.password && "password-error")}
              {...register("password")}
            />
          </FormField>
          <FormField label="Type it again" htmlFor="confirm" required error={errors.confirm?.message}>
            <PasswordInput
              id="confirm"
              autoComplete="new-password"
              aria-required="true"
              aria-invalid={errors.confirm ? true : undefined}
              aria-describedby={describedBy(errors.confirm && "confirm-error")}
              {...register("confirm")}
            />
          </FormField>
        </div>
      </fieldset>

      <div aria-hidden="true" className="h-px bg-border" />

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 flex flex-col gap-1">
          <span className="text-md font-semibold text-text">The firm</span>
          <span className="text-sm text-text-muted">Filled in from the firm&apos;s records. Check them; Partners can change them later in Settings.</span>
        </legend>
        <div className="grid gap-4 @md:grid-cols-2">
          {text("firmName", "Firm name", { required: true, autoComplete: "organization" })}
          {text("tagline", "Tagline")}
          <FormField label="Registered address" htmlFor="address" required error={addressError} className="@md:col-span-2">
            <Textarea
              id="address"
              rows={2}
              autoComplete="street-address"
              aria-required="true"
              aria-invalid={addressError ? true : undefined}
              aria-describedby={describedBy(addressError && "address-error")}
              className="min-h-16"
              defaultValue={defaults.address}
              {...register("address")}
            />
          </FormField>
          {text("city", "City", { required: true, autoComplete: "address-level2" })}
          <FormField
            label="State"
            htmlFor="stateCode"
            required
            error={stateError}
            className="[&_[data-slot=native-select-wrapper]]:w-full"
          >
            <NativeSelect
              id="stateCode"
              aria-required="true"
              aria-invalid={stateError ? true : undefined}
              aria-describedby={describedBy(stateError && "stateCode-error")}
              className="h-10"
              defaultValue={defaults.stateCode}
              {...register("stateCode")}
            >
              {states.map((s) => (
                <NativeSelectOption key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          {text("pincode", "Pincode", { required: true, autoComplete: "postal-code", inputMode: "numeric", maxLength: 7, inputClassName: "num" })}
          {text("phone", "Phone", { type: "tel", autoComplete: "tel", inputMode: "tel", inputClassName: "num" })}
          {text("firmEmail", "Firm email", { required: true, type: "email", inputMode: "email", helper: "Shown on invoices and quotations." })}
          {text("website", "Website", { type: "url", inputMode: "url" })}
          {text("gstin", "GSTIN", { maxLength: 20, inputClassName: "num uppercase" })}
          {text("pan", "PAN", { maxLength: 12, inputClassName: "num uppercase" })}
        </div>
      </fieldset>

      <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-col gap-3 border-t border-border bg-surface px-6 py-4 sm:-mx-8 sm:-mb-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="text-sm text-text-muted">Next, you&apos;ll turn on two-step sign-in.</p>
        <SubmitButton busy={busy} busyText="Setting up…" className="sm:w-auto">
          Create Partner login
        </SubmitButton>
      </div>
    </form>
  );
}

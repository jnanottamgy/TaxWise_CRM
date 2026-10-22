"use client";

import { Controller } from "react-hook-form";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { verifyMfa } from "@/server/actions/auth";
import { MfaCodeSchema } from "@/lib/schemas/auth";
import { cn } from "@/lib/utils";
import { FieldMessage, FormMessage, SubmitButton } from "./form-bits";
import { navigateTo, useAuthForm } from "./use-auth-form";

const SLOT = "h-11 w-10 text-md num sm:w-11";

/**
 * The 6-digit code from the authenticator app (§12). Submits by itself when the sixth digit lands
 * (typed or pasted); the Verify button is there for anyone who prefers it. After success the page
 * either goes on to `next` or reloads (when the code was needed before setting a password).
 */
export function MfaCodeForm({
  factorId,
  next,
  after = "navigate",
  submitLabel = "Verify",
  autoFocus = true,
}: {
  factorId: string;
  next?: string | null;
  after?: "navigate" | "reload";
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const { form, submit, formError, alertRef, busy } = useAuthForm({
    schema: MfaCodeSchema,
    defaultValues: { factorId, code: "", next: next ?? undefined },
    action: verifyMfa,
    onSuccess: ({ redirectTo }) => {
      if (after === "reload") window.location.reload();
      else navigateTo(redirectTo);
      return true;
    },
    onFailure: () => {
      // A wrong code is useless: clear it (keeping the error) so the next one can be typed straight in.
      form.setValue("code", "");
      requestAnimationFrame(() => form.setFocus("code"));
    },
  });
  const {
    control,
    formState: { errors },
  } = form;
  const codeError = errors.code?.message;

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="flex flex-col gap-4">
      <FormMessage notice={formError} alertRef={alertRef} />
      <div className="flex flex-col gap-2">
        <label htmlFor="code" className="text-sm font-medium text-text">
          6-digit code
        </label>
        <Controller
          control={control}
          name="code"
          render={({ field }) => (
            <InputOTP
              id="code"
              maxLength={6}
              inputMode="numeric"
              pattern="^[0-9]*$"
              autoComplete="one-time-code"
              autoFocus={autoFocus}
              disabled={busy}
              value={field.value ?? ""}
              onChange={(v) => field.onChange(v.replace(/[^0-9]/g, ""))}
              onBlur={field.onBlur}
              ref={field.ref}
              onComplete={() => void submit()}
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? "code-error" : undefined}
              containerClassName="justify-start"
            >
              <InputOTPGroup>
                {[0, 1, 2].map((i) => (
                  <InputOTPSlot key={i} index={i} className={cn(SLOT, codeError && "border-danger")} />
                ))}
              </InputOTPGroup>
              <InputOTPSeparator className="text-text-muted" />
              <InputOTPGroup>
                {[3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} className={cn(SLOT, codeError && "border-danger")} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          )}
        />
        <FieldMessage id="code-error" message={codeError} />
      </div>
      <SubmitButton busy={busy} busyText="Checking…">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}

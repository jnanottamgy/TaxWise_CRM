"use client";

import { useState } from "react";
import { useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { setNewPassword } from "@/server/actions/auth";
import { NewPasswordSchema } from "@/lib/schemas/auth";
import { describedBy, FormField, FormMessage, PasswordChecklist, PasswordInput, SubmitButton } from "./form-bits";
import { navigateTo, useAuthForm } from "./use-auth-form";

/**
 * New password + confirm, with the §4.4 checklist updating as they type. Used by the reset link's
 * page and by the forced change after a temporary password.
 */
export function NewPasswordForm({ email, submitLabel }: { email: string; submitLabel: string }) {
  const [done, setDone] = useState<{ redirectTo: string; warnings: string[] } | null>(null);
  const { form, submit, formError, alertRef, busy } = useAuthForm({
    schema: NewPasswordSchema,
    defaultValues: { password: "", confirm: "" },
    action: setNewPassword,
    onSuccess: ({ redirectTo }, warnings) => {
      if (warnings.length === 0) {
        navigateTo(redirectTo);
        return true;
      }
      // §0.1 rule 5: the password is saved; say what didn't happen before moving on.
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
        <FormMessage tone="warning" notice={{ message: "Your new password is saved." }}>
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

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="flex flex-col gap-4">
      <FormMessage notice={formError} alertRef={alertRef} />
      {/* Lets password managers file the new password under the right login. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />

      <FormField
        label="New password"
        htmlFor="password"
        required
        error={errors.password?.message}
        helper={<PasswordChecklist id="password-rules" password={password} />}
        helperId="password-rules-wrap"
      >
        <PasswordInput
          id="password"
          autoComplete="new-password"
          autoFocus
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

      <SubmitButton busy={busy} busyText="Saving…">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}

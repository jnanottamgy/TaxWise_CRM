"use client";

import Link from "next/link";
import { Input } from "@/components/ui/input";
import { signIn } from "@/server/actions/auth";
import { SignInSchema, type SignInInput } from "@/lib/schemas/auth";
import { describedBy, FormField, FormMessage, PasswordInput, SubmitButton } from "../_components/form-bits";
import { navigateTo, useAuthForm, type FormNotice } from "../_components/use-auth-form";

export function LoginForm({
  next,
  notice,
  noticeTone,
}: {
  next: string | null;
  notice: FormNotice | null;
  noticeTone: "info" | "success" | "danger";
}) {
  const { form, submit, formError, alertRef, busy } = useAuthForm({
    schema: SignInSchema,
    defaultValues: { email: "", password: "", next: next ?? undefined } satisfies SignInInput,
    action: signIn,
    onSuccess: ({ redirectTo }) => {
      navigateTo(redirectTo);
      return true;
    },
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="flex flex-col gap-4">
      {formError ? <FormMessage notice={formError} alertRef={alertRef} /> : notice ? <FormMessage notice={notice} tone={noticeTone} /> : null}

      <FormField label="Email" htmlFor="email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          className="h-10"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy(errors.email && "email-error")}
          {...register("email")}
        />
      </FormField>

      <FormField label="Password" htmlFor="password" error={errors.password?.message}>
        <PasswordInput
          id="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={describedBy(errors.password && "password-error")}
          {...register("password")}
        />
      </FormField>

      <div className="-mt-1 flex justify-end">
        <Link
          href="/forgot-password"
          className="rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:py-2"
        >
          Forgot password?
        </Link>
      </div>

      <SubmitButton busy={busy} busyText="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}

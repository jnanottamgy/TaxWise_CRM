"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MailCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestPasswordReset } from "@/server/actions/auth";
import { ForgotPasswordSchema } from "@/lib/schemas/auth";
import { describedBy, FormField, FormMessage, SubmitButton } from "../_components/form-bits";
import { useAuthForm } from "../_components/use-auth-form";

export function ForgotPasswordForm({ initialEmail }: { initialEmail: string }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const sentRef = useRef<HTMLDivElement>(null);
  // The form disappears on success: move focus to the confirmation so it isn't lost.
  useEffect(() => {
    if (sentTo) sentRef.current?.focus();
  }, [sentTo]);
  const { form, submit, formError, alertRef, busy } = useAuthForm({
    schema: ForgotPasswordSchema,
    defaultValues: { email: initialEmail },
    action: requestPasswordReset,
    onSuccess: ({ email }) => {
      setSentTo(email);
    },
  });
  const {
    register,
    formState: { errors },
  } = form;

  if (sentTo) {
    return (
      <div className="flex flex-col gap-5">
        <div
          ref={sentRef}
          tabIndex={-1}
          role="status"
          className="flex items-start gap-3 rounded-md border border-success/30 bg-success-soft px-3 py-3 text-sm text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <MailCheckIcon aria-hidden="true" className="mt-px size-4 flex-none text-success-text" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">Check your email</p>
            <p>
              If <span className="font-medium break-all">{sentTo}</span> has a TaxWise login, a link to choose a new password is on its
              way. The link works once.
            </p>
          </div>
        </div>
        <p className="text-sm text-text-muted">Nothing after a few minutes? Check the spam folder, or ask a Partner to reset your access.</p>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button asChild size="lg" className="sm:flex-1">
            <Link href="/login">Back to sign in</Link>
          </Button>
          <Button type="button" variant="outline" size="lg" className="sm:flex-1" onClick={() => setSentTo(null)}>
            Use another email
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="flex flex-col gap-4">
      <FormMessage notice={formError} alertRef={alertRef} />
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
          defaultValue={initialEmail}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy(errors.email && "email-error")}
          {...register("email")}
        />
      </FormField>
      <SubmitButton busy={busy} busyText="Sending…">
        Send reset link
      </SubmitButton>
    </form>
  );
}

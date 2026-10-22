"use client";

import { useState, useTransition } from "react";
import { Loader2Icon, LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/server/actions/auth";
import { navigateTo } from "./use-auth-form";

/** Signs out on the server (revokes the session, §4.4), then reloads into /login. */
export function SignOutButton({
  variant = "outline",
  className,
  label = "Sign out",
}: {
  variant?: "default" | "outline" | "ghost" | "link";
  className?: string;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant={variant}
        className={className}
        disabled={pending}
        aria-disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            try {
              const result = await signOut();
              if (result.ok) navigateTo(result.data.redirectTo);
              else setError(result.error);
            } catch {
              setError("We couldn't reach TaxWise. Check your internet connection and try again.");
            }
          })
        }
      >
        {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : <LogOutIcon aria-hidden="true" />}
        {pending ? "Signing out…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

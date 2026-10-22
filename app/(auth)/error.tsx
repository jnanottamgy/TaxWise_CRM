"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthCard, TroubleLine } from "./_components/auth-card";
import { FormMessage } from "./_components/form-bits";

/**
 * Error boundary for the sign-in pages (§0.1 rule 3). The auth layout is static, so it stays on
 * screen: the brand panel, then this card in place of the page that failed.
 */
export default function AuthError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : undefined;

  useEffect(() => {
    console.error(JSON.stringify({ level: "error", msg: "auth page error", source: "boundary:(auth)", ref: digest ?? null }));
  }, [digest]);

  return (
    <AuthCard title="This page didn't load" footer={<TroubleLine />}>
      <div className="flex flex-col gap-4">
        <FormMessage
          notice={{
            message: digest
              ? `Something went wrong on our side. Please try again, and if it keeps happening, quote Ref ${digest}.`
              : "Something went wrong on our side. Please try again.",
            ref: digest,
          }}
        />
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" size="lg" className="sm:flex-1" onClick={() => retry()}>
            <RotateCwIcon aria-hidden="true" />
            Try again
          </Button>
          <Button asChild variant="outline" size="lg" className="sm:flex-1">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </div>
    </AuthCard>
  );
}

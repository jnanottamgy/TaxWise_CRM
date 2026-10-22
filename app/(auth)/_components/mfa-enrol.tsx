"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/app/copy-button";
import { startMfaEnrolment, type MfaEnrolment } from "@/server/actions/auth";
import { FormMessage } from "./form-bits";
import { MfaCodeForm } from "./mfa-code-form";
import type { FormNotice } from "./use-auth-form";

type State = { kind: "loading" } | { kind: "error"; notice: FormNotice } | { kind: "ready"; enrolment: MfaEnrolment };

/**
 * Turning on two-step sign-in (§12): the set-up starts as soon as the page opens, shows a QR code
 * and the key for typing in by hand, then asks for the first code to confirm it works.
 */
export function MfaEnrol({ next }: { next: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const started = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await startMfaEnrolment({});
      if (result.ok) setState({ kind: "ready", enrolment: result.data });
      else setState({ kind: "error", notice: { message: result.error, ref: result.ref } });
    } catch {
      setState({ kind: "error", notice: { message: "We couldn't reach TaxWise. Check your internet connection and try again." } });
    }
  }, []);

  useEffect(() => {
    // Once per page view (React's development double-mount keeps the ref).
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const retry = () => {
    setState({ kind: "loading" });
    void load();
  };

  return (
    <ol className="flex flex-col gap-6">
      <Step n={1} title="Install an authenticator app on your phone">
        <p>Google Authenticator, Microsoft Authenticator or 1Password all work. Skip this if you already use one.</p>
      </Step>

      <Step n={2} title="Scan this code with the app">
        {state.kind === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <FormMessage notice={state.notice} />
            <Button type="button" variant="outline" onClick={retry}>
              <RotateCwIcon aria-hidden="true" />
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {/* QR codes need dark on light to scan, in either theme. */}
            <div className="flex size-[200px] flex-none items-center justify-center rounded-md border border-border bg-white p-2">
              {state.kind === "ready" ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data URL made on the server
                <img src={state.enrolment.qrDataUrl} alt="QR code to add TaxWise to your authenticator app" width={184} height={184} />
              ) : (
                <>
                  <Skeleton className="size-[184px] rounded-sm" />
                  <span role="status" className="sr-only">
                    Preparing your code…
                  </span>
                </>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 text-sm">
              <p className="text-text-muted">Can&apos;t scan it? Choose &ldquo;Enter a setup key&rdquo; in the app and type this key:</p>
              {state.kind === "ready" ? (
                <div className="flex items-center gap-1.5">
                  <code className="num rounded-sm bg-surface-2 px-2 py-1 font-mono text-sm break-all text-text">{state.enrolment.secret}</code>
                  <CopyButton value={state.enrolment.secret.replace(/\s+/g, "")} label="setup key" />
                </div>
              ) : (
                <Skeleton className="h-7 w-56 max-w-full" />
              )}
              <p className="text-text-muted">Account: TaxWise. Time-based.</p>
            </div>
          </div>
        )}
      </Step>

      <Step n={3} title="Enter the 6-digit code the app shows">
        {state.kind === "ready" ? (
          <MfaCodeForm factorId={state.enrolment.factorId} next={next} submitLabel="Turn on two-step sign-in" autoFocus={false} />
        ) : (
          <p className="text-text-muted">The code box appears once the QR code is ready.</p>
        )}
      </Step>
    </ol>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[24px_1fr] gap-x-3 gap-y-2">
      <span aria-hidden="true" className="num flex size-6 items-center justify-center rounded-full border border-border text-xs font-semibold text-text-muted">
        {n}
      </span>
      <h2 className="text-base font-semibold text-text">{title}</h2>
      <div className="col-start-2 flex flex-col gap-2 text-sm text-text-muted">{children}</div>
    </li>
  );
}

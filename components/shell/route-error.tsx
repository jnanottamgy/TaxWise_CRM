"use client";

import * as React from "react";
import Link from "next/link";
import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/app/copy-button";
import { TwMonogram } from "./brand";

/**
 * The body of the error boundaries (§0.1 rules 2–3): a plain sentence, the Ref to quote (Next's
 * error digest, which matches the server log), Try again and Go home. Never the error's message:
 * in production that would be a generic string, and in development it can leak internals.
 */

export function errorDigest(error: unknown): string | null {
  if (error && typeof error === "object" && "digest" in error) {
    const d = (error as { digest?: unknown }).digest;
    if (typeof d === "string" && d.length > 0) return d;
  }
  return null;
}

export function RouteError({
  error,
  retry,
  source,
  homeHref = "/",
  homeLabel = "Go home",
  standalone = false,
}: {
  error: unknown;
  retry: () => void;
  /** For the console line: "boundary:(staff)". */
  source: string;
  homeHref?: string;
  homeLabel?: string;
  /** Outside any shell (the root boundary): draws its own frame with the firm's band. */
  standalone?: boolean;
}) {
  const ref = errorDigest(error);

  React.useEffect(() => {
    console.error(JSON.stringify({ level: "error", msg: "route error boundary", source, ref }));
  }, [source, ref]);

  const body = (
    <div className="flex flex-col gap-4 px-5 py-6 sm:px-6">
      <div className="flex items-start gap-3">
        <CircleAlertIcon aria-hidden="true" className="mt-1 size-4 flex-none text-danger-text" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-text">This page didn&apos;t load</h1>
          <p className="mt-1 text-base text-text-muted">
            Something went wrong on our side. Please try again, and if it keeps happening, quote the Ref below to a
            Partner.
          </p>
          {ref ? (
            <p className="mt-2 flex items-center gap-1 text-sm text-text-muted">
              Ref <span className="font-mono text-[13px] text-text">{ref}</span>
              <CopyButton value={ref} label="Ref" />
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button asChild variant="outline">
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
        <Button type="button" onClick={() => retry()}>
          <RotateCwIcon aria-hidden="true" />
          Try again
        </Button>
      </div>
    </div>
  );

  if (standalone) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
        <div role="alert" className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex h-14 items-center gap-2.5 bg-brand-navy px-5 text-white">
            <TwMonogram className="size-8" />
            <span className="text-base font-semibold tracking-[-0.01em]">TaxWise Consultants</span>
          </div>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center py-6 md:py-12">
      <div role="alert" className="w-full max-w-lg rounded-lg border border-border bg-surface">
        {body}
      </div>
    </div>
  );
}

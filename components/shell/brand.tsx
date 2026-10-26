"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The firm's marks in the shells (§0, §3.3): the TW monogram in gold on the navy band, the firm's
 * own logo when one is uploaded (Settings → Firm details), and "Powered by J-TACS".
 */

/** The TW monogram, drawn as strokes in --accent-gold inside a gold-ruled square. */
export function TwMonogram({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("flex-none text-gold", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
      {/* T */}
      <path d="M5.5 10.5h7.5M9.25 10.5v11" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="square" />
      {/* W */}
      <path
        d="M16.5 10.5l2.5 11 2.5-8.25 2.5 8.25 2.5-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

/**
 * The firm's logo on a white tile (so any artwork reads on navy), or the TW monogram when there is
 * no logo or it fails to load.
 */
export function FirmMark({ logoUrl, firmName, className }: { logoUrl: string | null; firmName: string; className?: string }) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  if (logoUrl && failedUrl !== logoUrl) {
    return (
      <span className={cn("flex size-8 flex-none items-center justify-center overflow-hidden rounded-md bg-white p-0.5", className)}>
        {/* The branding bucket is public-read for the logo only (§2.3); next/image would need a remote pattern. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt={`${firmName} logo`}
          className="max-h-full max-w-full object-contain"
          decoding="async"
          onError={() => setFailedUrl(logoUrl)}
        />
      </span>
    );
  }
  return <TwMonogram className={cn("size-8", className)} />;
}

/** The J-TACS mark for the 64px rail: a navy J on a small gold square, named for screen readers. */
export function JTacsMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex justify-center", className)} title="Powered by J-TACS">
      <span
        aria-hidden="true"
        className="inline-flex size-5 flex-none select-none items-center justify-center rounded-sm bg-gold text-xs font-bold text-brand-navy"
      >
        J
      </span>
      <span className="sr-only">Powered by J-TACS</span>
    </span>
  );
}

/** "Powered by J-TACS", small and in gold text (§0). */
export function PoweredBy({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs text-gold-text", className)}>
      Powered by <span className="font-semibold tracking-[0.02em]">J-TACS</span>
    </p>
  );
}

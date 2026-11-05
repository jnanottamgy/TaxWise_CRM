"use client";

import * as React from "react";
import { TaxWiseShield } from "@/components/brand/taxwise-logo";
import { cn } from "@/lib/utils";

/**
 * The firm's marks in the shells (§0, §3.3): the TaxWise shield on the navy band (or the firm's own
 * uploaded logo, Settings → Firm details), and "Powered by J-TACS".
 */

/**
 * A logo uploaded in Settings, on a white tile (so any artwork reads on navy); otherwise, or if it
 * fails to load, the TaxWise shield that ships with the app (lib/brand.ts).
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
  return <TaxWiseShield className={className} />;
}

/** The J-TACS mark for the 64px rail: a navy J on a small gold square, named for screen readers. */
export function JTacsMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex justify-center", className)} title="Powered by J-TACS">
      <span
        aria-hidden="true"
        className="inline-flex size-5 flex-none select-none items-center justify-center rounded-sm bg-gold text-xs font-bold text-[#0c1830]"
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

import { cn } from "@/lib/utils";
import { TaxWiseLockup } from "@/components/brand/taxwise-logo";

/**
 * The sign-in screen's brand moment (§3.5): a navy panel with a faint diagonal line pattern, the
 * firm's logo large (the shield with its wordmark, lib/brand.ts), its tagline, one quiet line, and
 * "Powered by J-TACS" with the gold J mark at the foot. On a phone only the card shows, with the
 * logo above it.
 */

/** The J-TACS mark: a navy J on a small gold square. */
export function JMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-5 flex-none select-none items-center justify-center rounded-sm bg-gold text-xs font-bold text-brand-navy",
        className,
      )}
    >
      J
    </span>
  );
}

/** "Powered by J-TACS" with the gold J mark: on the navy panel, or (`onLight`) under the phone card. */
export function PoweredBy({ className, onLight = false }: { className?: string; onLight?: boolean }) {
  return (
    <p className={cn("flex items-center gap-2", onLight ? "text-xs" : "text-sm", className)}>
      <span className={onLight ? "text-text-muted" : "text-white/70"}>Powered by</span>
      <JMark />
      <span className={cn("font-semibold tracking-[0.02em]", onLight ? "text-gold-text" : "text-gold")}>J-TACS</span>
    </p>
  );
}

/** Thin diagonal hairlines, drawn as an SVG pattern (no gradients). */
function DiagonalLines() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full text-white/[0.055]" focusable="false">
      <defs>
        <pattern id="tw-diagonal-lines" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <line x1="0" y1="0" x2="0" y2="22" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#tw-diagonal-lines)" />
    </svg>
  );
}

/** Left 40% on tablets and up; hidden on phones. */
export function BrandPanel() {
  return (
    <aside
      aria-label="TaxWise Consultants"
      className="relative hidden overflow-hidden bg-frame text-white md:sticky md:top-0 md:flex md:h-dvh md:w-2/5 md:flex-none md:flex-col md:p-10 lg:p-14"
    >
      <DiagonalLines />
      <div className="relative my-auto flex flex-col">
        {/* The logo is the firm's name in large type (§3.5). */}
        <TaxWiseLockup title="TaxWise Consultants" className="h-20 self-start text-white lg:h-24 xl:h-28" />
        <p className="mt-8 text-base text-white/75">Chartered Accountants · Bengaluru</p>
        <span aria-hidden="true" className="my-8 block h-px w-12 bg-gold/80" />
        <p className="max-w-xs font-serif text-xl leading-7 text-white/80 italic">Your practice, in one place.</p>
      </div>
      <PoweredBy className="relative" />
    </aside>
  );
}

/** Phones: the logo above the card (§3.5). */
export function PhoneBrand() {
  return (
    <div className="mb-6 flex flex-col items-center gap-2.5 text-center md:hidden">
      <TaxWiseLockup title="TaxWise Consultants" className="h-14" />
      <p className="text-sm text-text-muted">Chartered Accountants · Bengaluru</p>
    </div>
  );
}

/** Phones: the J-TACS credit under the card, since the navy panel is hidden there (§0, §3.5). */
export function PhonePoweredBy() {
  return <PoweredBy onLight className="mt-8 md:hidden" />;
}

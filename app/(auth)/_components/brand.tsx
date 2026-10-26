import { cn } from "@/lib/utils";
import { TwMonogram } from "@/components/shell/brand";

/**
 * The sign-in screen's brand moment (§3.5): a navy panel with a faint diagonal line pattern, the
 * firm's name in large type, its tagline, one quiet line, and "Powered by J-TACS" with the gold J
 * mark at the foot. On a phone only the card shows, with the monogram and name above it.
 */

/**
 * The TW monogram on a navy tile: the same mark the app's sidebar band and error pages draw
 * (components/shell/brand.tsx), so the brand reads identically before and after sign-in.
 */
export function TwMark({ className, size = "md" }: { className?: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-[10px] bg-[#0c1830]",
        size === "md" ? "size-11" : "size-9",
        className,
      )}
    >
      <TwMonogram className="size-full" />
    </span>
  );
}

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
      className="relative hidden overflow-hidden bg-frame text-white md:sticky md:top-0 md:flex md:h-dvh md:w-2/5 md:flex-none md:flex-col md:justify-between md:p-10 lg:p-14"
    >
      <DiagonalLines />
      <div className="relative">
        <TwMark />
      </div>
      <div className="relative flex flex-col">
        {/* The firm's name in large type (§3.5), set in the serif like the app's titles. */}
        <p className="font-serif text-[44px] leading-[1.02] font-[420] tracking-[-0.02em] text-white lg:text-[56px]">
          TaxWise
          <br />
          Consultants
        </p>
        <p className="mt-5 text-base text-white/75">Chartered Accountants · Bengaluru</p>
        <span aria-hidden="true" className="my-8 block h-px w-12 bg-gold/80" />
        <p className="max-w-xs font-serif text-xl leading-7 text-white/80 italic">Your practice, in one place.</p>
      </div>
      <PoweredBy className="relative" />
    </aside>
  );
}

/** Phones: the monogram and name above the card (§3.5). */
export function PhoneBrand() {
  return (
    <div className="mb-6 flex flex-col items-center gap-3 text-center md:hidden">
      <TwMark />
      <div>
        <p className="text-md font-semibold text-text">TaxWise Consultants</p>
        <p className="text-sm text-text-muted">Chartered Accountants · Bengaluru</p>
      </div>
    </div>
  );
}

/** Phones: the J-TACS credit under the card, since the navy panel is hidden there (§0, §3.5). */
export function PhonePoweredBy() {
  return <PoweredBy onLight className="mt-8 md:hidden" />;
}

import { cn } from "@/lib/utils";

/**
 * The sign-in screen's brand moment (§3.5): a navy panel with a faint diagonal line pattern, the
 * firm's name in large type, its tagline, one quiet line, and "Powered by J-TACS" with the gold J
 * mark at the foot. On a phone only the card shows, with the monogram and name above it.
 */

/** The TW monogram: gold letters in a gold-ruled square, on navy. */
export function TwMark({ className, size = "md" }: { className?: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none select-none items-center justify-center rounded-md border border-gold/60 bg-brand-navy font-semibold tracking-[0.04em] text-gold",
        size === "md" ? "size-11 text-base" : "size-9 text-sm",
        className,
      )}
    >
      TW
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

export function PoweredBy({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 text-sm", className)}>
      <span className="text-white/70">Powered by</span>
      <JMark />
      <span className="font-semibold tracking-[0.02em] text-gold">J-TACS</span>
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
      className="relative hidden overflow-hidden bg-brand-navy text-white md:sticky md:top-0 md:flex md:h-dvh md:w-2/5 md:flex-none md:flex-col md:justify-between md:p-10 lg:p-14"
    >
      <DiagonalLines />
      <div className="relative">
        <TwMark />
      </div>
      <div className="relative flex flex-col gap-3">
        <p className="text-2xl font-semibold tracking-[-0.01em] text-white">TaxWise Consultants</p>
        <p className="text-base text-white/80">Chartered Accountants · Bengaluru</p>
        <span aria-hidden="true" className="my-3 block h-px w-10 bg-gold/70" />
        <p className="max-w-xs text-base text-white/70">Your practice, in one place.</p>
      </div>
      <PoweredBy className="relative" />
    </aside>
  );
}

/** Phones: the monogram and name above the card. */
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

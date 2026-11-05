import { LOGO } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The firm's logo on screen (geometry in lib/brand.ts): the shield alone, or the shield with
 * "TAXWISE CONSULTANTS" beside it. The shield keeps its own blue and gold everywhere; on the navy
 * frame its gold rim carries it (DESIGN.md §2). The wordmark takes --logo-ink: the logo's blue on
 * paper, light ink on navy and in the dark theme. Server-safe. Decorative (hidden from screen
 * readers) unless given a `title`, which then names it.
 */

type LogoProps = {
  /** Size it by height (`h-9`); the width follows the logo's proportions. */
  className?: string;
  /** Names the logo for screen readers when nothing beside it already says the firm's name. */
  title?: string;
};

function named(title: string | undefined) {
  return title ? ({ role: "img", "aria-label": title } as const) : ({ "aria-hidden": true } as const);
}

/** The rim is a gold stroke under each shape's blue fill, so half of it shows outside the blue. */
function Shield() {
  return (
    <>
      <g fill={LOGO.gold} stroke={LOGO.gold} strokeWidth={LOGO.rim} strokeLinejoin="miter" strokeMiterlimit={8}>
        {LOGO.shield.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill={LOGO.blue}>
        {LOGO.shield.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </>
  );
}

/** The shield: the sidebar band, the portal band, error pages, the letterhead preview. */
export function TaxWiseShield({ className, title }: LogoProps) {
  const { width, height } = LOGO.mark;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-9 w-auto flex-none", className)}
      style={{ aspectRatio: `${width} / ${height}` }}
      focusable="false"
      {...named(title)}
    >
      <Shield />
    </svg>
  );
}

/** The shield with the wordmark: the sign-in screen. */
export function TaxWiseLockup({ className, title }: LogoProps) {
  const { width, height } = LOGO.lockup;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-14 w-auto flex-none text-logo-ink", className)}
      style={{ aspectRatio: `${width} / ${height}` }}
      focusable="false"
      {...named(title)}
    >
      <Shield />
      <g fill="currentColor">
        {LOGO.wordmark.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

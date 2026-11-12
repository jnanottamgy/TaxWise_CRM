"use client";

import * as React from "react";
import NextLink from "next/link";

/**
 * The app's link: `next/link` that loads a page ahead of the click only when someone points at it
 * (hover, keyboard focus or touch), not for every link that scrolls into view.
 *
 * Next's default prefetches each visible link. With a sidebar of 30 places and tables of 50 rows that
 * was 30–60 extra requests on every page view (each one runs the session check and, on the host, is
 * billed as an invocation), for pages nobody opens. Pointing at a link still warms it, so the page
 * opens as fast as before. `prefetch={false}` keeps a link cold altogether (heavy tabs).
 *
 * Same props as `next/link`; works inside `<Button asChild>`. It needs no router of its own, so it
 * renders in plain markup too (unit tests, error pages).
 */
type LinkProps = React.ComponentProps<typeof NextLink>;

export default function Link({ prefetch, onMouseEnter, onFocus, onTouchStart, ...rest }: LinkProps) {
  // Cold until pointed at; then Next's own prefetch takes over (the link is on screen by definition).
  const [warm, setWarm] = React.useState(false);
  const cold = prefetch === false || !warm;
  return (
    <NextLink
      prefetch={cold ? false : (prefetch ?? null)}
      onMouseEnter={(e) => {
        setWarm(true);
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        setWarm(true);
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        setWarm(true);
        onTouchStart?.(e);
      }}
      {...rest}
    />
  );
}

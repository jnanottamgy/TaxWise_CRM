"use client";

import * as React from "react";

/**
 * True while the media query matches. On the server and in the first client render it returns
 * `serverValue` (no hydration mismatch), then follows the window.
 *
 *   const wide = useMediaQuery("(min-width: 1024px)", true);
 */
export function useMediaQuery(query: string, serverValue: boolean): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

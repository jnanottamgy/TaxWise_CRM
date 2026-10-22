import * as React from "react"

const MOBILE_BREAKPOINT = 768

function subscribeTo(query: string) {
  return (onChange: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {}
    const mql = window.matchMedia(query)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }
}

/**
 * True while the media query matches. Server render (and the first client render) use
 * `serverValue`, so markup never mismatches during hydration.
 *
 *   const wide = useMediaQuery("(min-width: 1024px)")
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = React.useMemo(() => subscribeTo(query), [query])
  return React.useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue
  )
}

/** True below 768px (the phone layout of §3.3). Prefer CSS breakpoints for layout; use this only for behaviour. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}

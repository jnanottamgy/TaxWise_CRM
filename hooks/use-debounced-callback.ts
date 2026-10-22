"use client"

import * as React from "react"

/**
 * A stable function that runs `fn` once input has been quiet for `delay` ms. `flush()` runs the
 * pending call now; `cancel()` drops it. Cleared on unmount.
 *
 *   const pushQuery = useDebouncedCallback((q: string) => setQuery(q), 300)
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay = 300
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  const fnRef = React.useRef(fn)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = React.useRef<A | null>(null)

  React.useEffect(() => {
    fnRef.current = fn
  }, [fn])

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return React.useMemo(() => {
    const run = () => {
      timer.current = null
      const args = pending.current
      pending.current = null
      if (args) fnRef.current(...args)
    }
    const debounced = (...args: A) => {
      pending.current = args
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(run, delay)
    }
    debounced.flush = () => {
      if (timer.current) clearTimeout(timer.current)
      run()
    }
    debounced.cancel = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      pending.current = null
    }
    return debounced
  }, [delay])
}

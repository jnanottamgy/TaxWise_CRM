"use client"

import * as React from "react"

/**
 * Copies text to the clipboard and reports `copied` for `resetMs` (default 1.5 s).
 * Falls back to a hidden textarea where the async Clipboard API is unavailable (http, old browsers).
 *
 *   const { copy, copied } = useCopy()
 *   <button onClick={() => copy(pan)}>{copied ? "Copied" : "Copy"}</button>
 */
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = React.useCallback(
    async (text: string): Promise<boolean> => {
      let ok = false
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          ok = true
        }
      } catch {
        ok = false
      }
      if (!ok) {
        try {
          const el = document.createElement("textarea")
          el.value = text
          el.setAttribute("readonly", "")
          el.style.position = "fixed"
          el.style.opacity = "0"
          document.body.appendChild(el)
          el.select()
          ok = document.execCommand("copy")
          document.body.removeChild(el)
        } catch {
          ok = false
        }
      }
      if (ok) {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), resetMs)
      }
      return ok
    },
    [resetMs]
  )

  return { copy, copied }
}

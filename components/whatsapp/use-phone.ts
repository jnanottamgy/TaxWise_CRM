"use client"

import * as React from "react"

/**
 * True on a phone: a touch screen narrower than 768px (§7.25.8 "Phone: Open chat copies the group
 * name and opens the WhatsApp app"). False on the server and in the first client render, so the
 * markup never mismatches; it settles on the next paint.
 */
const QUERY = "(max-width: 767px) and (pointer: coarse)"

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const mq = window.matchMedia(QUERY)
  mq.addEventListener("change", onChange)
  return () => mq.removeEventListener("change", onChange)
}

export function useIsPhone(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && !!window.matchMedia ? window.matchMedia(QUERY).matches : false),
    () => false
  )
}

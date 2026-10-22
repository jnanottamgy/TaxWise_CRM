"use client"

import * as React from "react"

/**
 * Tiny localStorage helpers for per-browser conveniences (hidden table columns, form drafts).
 * Every access is wrapped in try/catch: storage can be blocked (private mode, policies) and the
 * UI must work without it. Never store anything sensitive here.
 */

const EVENT = "tw:local-storage"

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the value simply isn't remembered.
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }))
  } catch {
    // Non-browser environment.
  }
}

function subscribe(key: string, onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) onChange()
  }
  const onLocal = (e: Event) => {
    if ((e as CustomEvent<string>).detail === key) onChange()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener(EVENT, onLocal)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(EVENT, onLocal)
  }
}

/**
 * The raw string stored under `key`, kept in sync across components and tabs.
 * Returns null on the server and when nothing (or nothing readable) is stored.
 *
 *   const [raw, setRaw] = useLocalStorageString("tw:table:clients:hidden")
 */
export function useLocalStorageString(key: string): [string | null, (v: string | null) => void] {
  const sub = React.useCallback((cb: () => void) => subscribe(key, cb), [key])
  const value = React.useSyncExternalStore(
    sub,
    () => readLocal(key),
    () => null
  )
  const set = React.useCallback((v: string | null) => writeLocal(key, v), [key])
  return [value, set]
}

/**
 * JSON value stored under `key` with a fallback. Invalid JSON reads as the fallback.
 *
 *   const [hidden, setHidden] = useLocalStorageJSON<string[]>("tw:table:clients:hidden", [])
 */
export function useLocalStorageJSON<T>(key: string, fallback: T): [T, (v: T | null) => void] {
  const [raw, setRaw] = useLocalStorageString(key)
  const parsed = React.useMemo((): { ok: true; value: T } | { ok: false } => {
    if (raw === null) return { ok: false }
    try {
      return { ok: true, value: JSON.parse(raw) as T }
    } catch {
      return { ok: false }
    }
  }, [raw])
  const set = React.useCallback((v: T | null) => setRaw(v === null ? null : JSON.stringify(v)), [setRaw])
  return [parsed.ok ? parsed.value : fallback, set]
}

"use client"

import * as React from "react"
import { readLocal, writeLocal } from "@/hooks/use-local-storage"

export interface StoredDraft<T> {
  value: T
  /** ISO timestamp of the save. */
  at: string
}

export function draftStorageKey(key: string): string {
  return `tw:draft:${key}`
}

/** The draft saved on this device under `key`, or null. */
export function readDraft<T>(key: string): StoredDraft<T> | null {
  const raw = readLocal(draftStorageKey(key))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredDraft<T>
    return parsed && typeof parsed === "object" && "value" in parsed ? parsed : null
  } catch {
    return null
  }
}

export function clearDraft(key: string): void {
  writeLocal(draftStorageKey(key), null)
}

export interface AutosaveOptions<T> {
  /** Unique per form and record: "client-wizard:new", `quotation:${id}`. */
  key: string
  value: T
  /** Off until the form has something worth saving (e.g. `isDirty`). */
  enabled?: boolean
  /** §3.4: every 5 seconds. */
  intervalMs?: number
  /** Also save a server DRAFT where the entity has a draft status. Throw or return {ok:false} on failure. */
  onServerSave?: (value: T) => Promise<{ ok: boolean; error?: string } | void>
}

/**
 * Autosaves a long form's draft (§3.4): every 5 s when the value changed, to this device's
 * localStorage, plus an optional server draft. `savedAt` drives the "Draft saved · 12:41" stamp.
 * A server failure keeps the local draft and reports it; it never throws.
 *
 *   const draft = useAutosave({ key: "client-wizard:new", value: form.watch(), enabled: form.formState.isDirty,
 *     onServerSave: (v) => saveClientDraft(v) })
 *   <DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} />
 *   // after the final save: draft.clear()
 */
export function useAutosave<T>({ key, value, enabled = true, intervalMs = 5000, onServerSave }: AutosaveOptions<T>) {
  const [savedAt, setSavedAt] = React.useState<Date | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const latest = React.useRef({ value, enabled, onServerSave, key })
  const lastSaved = React.useRef<string | null>(null)
  const inFlight = React.useRef(false)

  React.useEffect(() => {
    latest.current = { value, enabled, onServerSave, key }
  })

  const saveNow = React.useCallback(async (force = false) => {
    const { value: v, enabled: on, onServerSave: server, key: k } = latest.current
    if (!on && !force) return
    let json: string
    try {
      json = JSON.stringify(v)
    } catch {
      return
    }
    if (!force && json === lastSaved.current) return
    if (inFlight.current) return
    inFlight.current = true
    const at = new Date()
    writeLocal(draftStorageKey(k), JSON.stringify({ value: v, at: at.toISOString() } satisfies StoredDraft<T>))
    lastSaved.current = json
    if (!server) {
      setSavedAt(at)
      setError(null)
      inFlight.current = false
      return
    }
    setSaving(true)
    try {
      const res = await server(v)
      if (res && res.ok === false) {
        setError(res.error ?? "Couldn't save the draft to the server. It's kept on this device.")
      } else {
        setError(null)
      }
      setSavedAt(at)
    } catch {
      setError("Couldn't save the draft to the server. It's kept on this device.")
      setSavedAt(at)
    } finally {
      setSaving(false)
      inFlight.current = false
    }
  }, [])

  React.useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => void saveNow(), intervalMs)
    return () => clearInterval(t)
  }, [enabled, intervalMs, saveNow])

  return {
    savedAt,
    saving,
    error,
    /** Save immediately (the "Save draft" button). */
    saveNow: () => saveNow(true),
    /** The draft stored on this device for this key (to offer "Restore your draft from 12:41?"). */
    restore: () => readDraft<T>(key),
    /** Forget the local draft (after the record is saved for real). */
    clear: () => {
      clearDraft(key)
      lastSaved.current = null
      setSavedAt(null)
    },
  }
}

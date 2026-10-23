"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import type { FormError } from "@/hooks/use-action-form"
import { CONSENT_PURPOSES } from "@/lib/schemas/portal"
import { acknowledgePrivacyNotice } from "@/server/actions/portal"

/**
 * The acknowledgement under the privacy notice (§6.10, §7.22 first sign-in): what the firm uses the
 * client's data for, one box to tick, and Continue. Writes a consent record for this version (with
 * the purposes, channel "portal" and the IP) and then opens the portal. The button stays on screen
 * at the bottom on a phone.
 */
export function WelcomeForm({ version, firmName, next = "/portal" }: { version: string; firmName: string; /** A checked portal path to continue to. */ next?: string }) {
  const router = useRouter()
  const [checked, setChecked] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)
  const [boxError, setBoxError] = React.useState<string | null>(null)
  const alertRef = React.useRef<HTMLDivElement | null>(null)
  const boxId = React.useId()
  const errId = React.useId()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!checked) {
      setBoxError("Tick the box to confirm you've read the privacy notice.")
      return
    }
    setPending(true)
    try {
      const res = await acknowledgePrivacyNotice({ noticeVersion: version, accepted: true })
      if (!res.ok) {
        setError({ message: res.error, ref: res.ref })
        requestAnimationFrame(() => alertRef.current?.focus())
        if (res.code === "conflict") router.refresh()
        return
      }
      // The shell shows the portal's navigation again once off /portal/welcome; refresh so the
      // layout re-reads the acknowledgement.
      router.replace(next)
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormAlert error={error} state={{ formError: error, alertRef }} className="mb-0" />
      <div>
        <p className="text-base font-medium text-text">{firmName} uses your personal data to:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-text">
          {CONSENT_PURPOSES.map((p) => (
            <li key={p.key}>{p.label}</li>
          ))}
        </ul>
      </div>
      <div className="flex items-start gap-3 rounded-md border border-border bg-surface-2 px-3 py-3">
        <Checkbox
          id={boxId}
          checked={checked}
          onCheckedChange={(v) => {
            setChecked(v === true)
            if (v === true) setBoxError(null)
          }}
          aria-invalid={boxError ? true : undefined}
          aria-describedby={boxError ? errId : undefined}
          className="mt-0.5 pointer-coarse:size-5"
        />
        <label htmlFor={boxId} className="text-base text-text">
          I have read the privacy notice (version {version}) and understand how {firmName} uses my personal data.
        </label>
      </div>
      {boxError ? (
        <p id={errId} className="-mt-2 text-sm text-danger-text">
          {boxError}
        </p>
      ) : null}
      <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
        <Button type="submit" disabled={pending} aria-busy={pending} className="w-full sm:w-auto">
          {pending ? <Spinner /> : null}
          Acknowledge and continue
        </Button>
      </div>
    </form>
  )
}

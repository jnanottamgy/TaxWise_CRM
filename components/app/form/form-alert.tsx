"use client"

import * as React from "react"
import { CircleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { CopyButton } from "@/components/app/copy-button"
import type { FormError } from "@/hooks/use-action-form"

/**
 * The form-level alert (§3.4): anything not tied to a field, the Ref for unexpected errors (with
 * copy), and server field errors that have no field on screen. It receives focus after a failed
 * server submit so keyboard and screen-reader users land on it.
 *
 *   <FormAlert state={f} />                       // from useActionForm
 *   <FormAlert error={{ message: "Email or password is incorrect." }} />
 */
export function FormAlert({
  state,
  error,
  className,
}: {
  state?: { formError: FormError | null; alertRef: React.RefObject<HTMLDivElement | null> }
  error?: FormError | null
  className?: string
}) {
  const e = error ?? state?.formError ?? null
  if (!e) return null
  return (
    <div
      ref={state?.alertRef}
      role="alert"
      tabIndex={-1}
      data-slot="form-alert"
      className={cn(
        "mb-4 flex gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-base text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
      <div className="min-w-0 flex-1">
        <p>{e.message}</p>
        {e.unplaced?.length ? (
          <ul className="mt-1 list-disc pl-4 text-sm">
            {e.unplaced.map((u) => (
              <li key={u.name}>{u.message}</li>
            ))}
          </ul>
        ) : null}
        {e.ref ? (
          <p className="mt-1 flex items-center gap-1 text-sm text-text-muted">
            Ref <span className="font-mono text-[13px] text-text">{e.ref}</span>
            <CopyButton value={e.ref} label="Ref" />
          </p>
        ) : null}
      </div>
    </div>
  )
}

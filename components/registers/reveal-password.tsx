"use client"

import * as React from "react"
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, LockIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Explain } from "@/components/app/explain"
import { useCopy } from "@/hooks/use-copy"
import { cn } from "@/lib/utils"
import { REVEAL_SECONDS } from "@/lib/schemas/registers"
import { logCredentialCopy, revealCredential } from "@/server/actions/credentials"

/**
 * Reveal a stored portal password (§7.15.1, §4.6): the server checks who may see it, logs who, when
 * and from which IP (access trail + audit), and only then returns it. It shows for 30 seconds with a
 * countdown, Copy (logged as "copied") and Hide, then disappears. The password lives only in this
 * component's state and is cleared on hide, on unmount and when the tab is hidden.
 */
export function RevealPassword({ credentialId, canReveal, portalName, deniedReason }: { credentialId: string; canReveal: boolean; portalName: string; deniedReason?: string }) {
  const [state, setState] = React.useState<{ password: string; until: number } | null>(null)
  const [pending, setPending] = React.useState(false)
  const [left, setLeft] = React.useState(REVEAL_SECONDS)
  const { copy, copied } = useCopy()

  const hide = React.useCallback(() => {
    setState(null)
    setLeft(REVEAL_SECONDS)
  }, [])

  React.useEffect(() => {
    if (!state) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((state.until - Date.now()) / 1000))
      setLeft(remaining)
      if (remaining <= 0) hide()
    }
    tick()
    const id = window.setInterval(tick, 250)
    const onHidden = () => {
      if (document.visibilityState === "hidden") hide()
    }
    document.addEventListener("visibilitychange", onHidden)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onHidden)
    }
  }, [state, hide])

  if (!canReveal) {
    return (
      <Explain content={deniedReason ?? "Only Partners, Managers and staff with Vault access can reveal this client's stored password."}>
        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md px-1 text-sm text-text-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Why the ${portalName} password is hidden`}>
          <LockIcon aria-hidden="true" className="size-3.5" />
          Hidden
        </button>
      </Explain>
    )
  }

  if (!state) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`Reveal the ${portalName} password`}
        onClick={async (e) => {
          e.stopPropagation()
          if (pending) return
          setPending(true)
          try {
            const r = await revealCredential({ id: credentialId })
            if (!r.ok) {
              toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
              return
            }
            setState({ password: r.data.password, until: Date.now() + r.data.visibleForSeconds * 1000 })
          } catch {
            toast.error("We couldn't reach the server. Check your connection and try again.")
          } finally {
            setPending(false)
          }
        }}
      >
        {pending ? <Spinner /> : <EyeIcon aria-hidden="true" />}
        Reveal
      </Button>
    )
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1.5" data-row-click-ignore>
      <code className="max-w-[14rem] truncate rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-sm text-text" aria-label={`${portalName} password`}>
        {state.password}
      </code>
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation()
          const done = await copy(state.password)
          if (done) void logCredentialCopy({ id: credentialId }).catch(() => undefined)
        }}
        aria-label={copied ? "Password copied" : "Copy the password"}
        title={copied ? "Copied" : "Copy"}
        className={cn(
          "inline-flex size-7 flex-none items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11",
          copied && "text-success-text",
        )}
      >
        {copied ? <CheckIcon aria-hidden="true" className="size-3.5" /> : <CopyIcon aria-hidden="true" className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          hide()
        }}
        aria-label="Hide the password"
        title="Hide"
        className="inline-flex size-7 flex-none items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
      >
        <EyeOffIcon aria-hidden="true" className="size-3.5" />
      </button>
      <span className="num text-xs text-text-muted tabular-nums" aria-hidden="true" title="Hides itself after 30 seconds">
        {left} s
      </span>
      <span className="sr-only">Shown for {REVEAL_SECONDS} seconds, then hidden.</span>
    </span>
  )
}

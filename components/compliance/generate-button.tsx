"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CalendarClockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { generateDeadlinesForClient, generateDeadlinesForClients } from "@/server/actions/compliance"

/**
 * "Generate deadlines" (§7.7): plans one client's deadlines (or several, the coverage-gaps fix)
 * from the statutory calendar and the ops templates. Idempotent: running it again adds nothing
 * that is already planned, and never touches filed deadlines.
 */
export function GenerateButton({
  clientIds,
  label = "Generate deadlines",
  variant = "outline",
  size = "sm",
  className,
}: {
  clientIds: string[]
  label?: string
  variant?: "default" | "outline" | "ghost"
  size?: "sm" | "xs" | "default"
  className?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const run = async () => {
    setBusy(true)
    try {
      if (clientIds.length === 1) {
        const r = await generateDeadlinesForClient({ clientId: clientIds[0] })
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        const { created, updated, retired } = r.data
        toast.success(
          created === 0 && updated === 0 && retired === 0
            ? "Deadlines are already up to date."
            : [
                created ? `${created} ${created === 1 ? "deadline" : "deadlines"} added` : null,
                updated ? `${updated} ${updated === 1 ? "date" : "dates"} updated` : null,
                retired ? `${retired} cancelled because the service ended` : null,
              ]
                .filter(Boolean)
                .join(", ") + ".",
        )
      } else {
        const r = await generateDeadlinesForClients({ clientIds })
        if (!r.ok) {
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
        toast.success(`${r.data.created} ${r.data.created === 1 ? "deadline" : "deadlines"} planned for ${r.data.clients} ${r.data.clients === 1 ? "client" : "clients"}.`)
      }
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={() => void run()} disabled={busy || clientIds.length === 0} aria-busy={busy} className={className}>
      {busy ? <Spinner /> : <CalendarClockIcon aria-hidden="true" />}
      {label}
    </Button>
  )
}

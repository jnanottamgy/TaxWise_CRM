"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { nextFinancialYear } from "@/lib/domain/fy"
import { renewLetter } from "@/server/actions/engagement-letters"
import { toastResult } from "@/components/registers/shared"

/**
 * "Renew for next FY" (§7.15.3): one click makes a Draft for the next FY with the same scope,
 * services, schedule and audit terms (a tax audit's report form follows the new year's statute),
 * then opens it to check the fees and issue it.
 */
export function RenewButton({ letterId, financialYear, size = "sm", variant = "outline" }: { letterId: string; financialYear: string; size?: "sm" | "default"; variant?: "outline" | "default" | "ghost" }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const next = nextFinancialYear(financialYear)
  return (
    <Button
      size={size}
      variant={variant}
      disabled={pending}
      aria-busy={pending}
      onClick={async (e) => {
        e.stopPropagation()
        if (pending) return
        setPending(true)
        try {
          const r = await renewLetter({ id: letterId })
          if (!toastResult(r, `Renewed as a draft for FY ${r.ok ? r.data.financialYear : next}`)) return
          router.push(`/engagement-letters/${r.data.id}`)
          router.refresh()
        } catch {
          toastResult({ ok: false, error: "We couldn't reach the server. Check your connection and try again." })
        } finally {
          setPending(false)
        }
      }}
    >
      {pending ? <Spinner /> : <RefreshCwIcon aria-hidden="true" />}
      Renew for FY {next}
    </Button>
  )
}

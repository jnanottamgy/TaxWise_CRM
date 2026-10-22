"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BadgeCheckIcon } from "lucide-react"
import { formatDate } from "@/lib/format"
import type { VerifiableTable } from "@/lib/schemas/law"
import { markVerified } from "@/server/actions/law"
import { Button } from "@/components/ui/button"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"

export const AWAITING_MEANING =
  "Checked only against secondary sources, or the sources disagreed. Confirm it against the notification or circular it cites, then mark it verified. Every one must be confirmed before go-live."

/** "Verified" or "Awaiting partner confirmation", with who and when underneath. */
export function VerificationCell({ verified, byName, on }: { verified: boolean; byName: string | null; on: string | null }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      {verified ? (
        <StatusChip
          label="Verified"
          tone="success"
          meaning={byName || on ? `Confirmed${byName ? ` by ${byName}` : ""}${on ? ` on ${formatDate(on)}` : ""}.` : "Confirmed against its source."}
        />
      ) : (
        <StatusChip label="Awaiting partner confirmation" tone="warning" meaning={AWAITING_MEANING} />
      )}
      {verified && (byName || on) ? (
        <span className="text-xs text-text-muted">
          {byName ?? "—"}
          {on ? <span className="num"> · {formatDate(on)}</span> : null}
        </span>
      ) : null}
    </div>
  )
}

/** The row action on an unconfirmed item: confirm it against its source. */
export function MarkVerifiedButton({
  table,
  id,
  updatedAt,
  what,
  source,
}: {
  table: VerifiableTable
  id: string
  updatedAt: string
  /** What is being confirmed, in words: "tds.professional_fees.rate from 01 Apr 2026". */
  what: string
  source: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BadgeCheckIcon aria-hidden="true" />
        Confirm
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Confirm against the source?"
        description={
          <>
            You confirm that <span className="font-medium text-text">{what}</span> matches {source ? <span className="font-medium text-text">{source}</span> : "its legal source"}. Your name and today&apos;s date are recorded, and it stops showing as awaiting confirmation.
          </>
        }
        confirmLabel="Mark verified"
        onConfirm={async () => {
          const r = await markVerified({ table, id, updated_at: updatedAt })
          if (!r.ok) {
            toast.error(r.error)
            if (r.code === "conflict") router.refresh()
            return false
          }
          toast.success("Marked verified")
          router.refresh()
        }}
      />
    </>
  )
}

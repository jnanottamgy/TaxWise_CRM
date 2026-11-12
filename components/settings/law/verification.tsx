"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BadgeCheckIcon } from "lucide-react"
import { formatDate } from "@/lib/format"
import type { VerifiableTable } from "@/lib/schemas/law"
import { markVerified, markVerifiedMany } from "@/server/actions/law"
import { Button } from "@/components/ui/button"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"

export const AWAITING_MEANING =
  "Checked only against secondary sources, or the sources disagreed. A Partner confirms it against the notification or circular it cites and marks it verified. Every one must be confirmed before go-live."

/** "Verified" or "Awaiting confirmation" (by a Partner: the hover says so), with who and when underneath. */
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
        <StatusChip label="Awaiting confirmation" tone="warning" meaning={AWAITING_MEANING} />
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

/**
 * The bulk action on ticked rows: a Partner who has checked a group against one source (every TDS
 * row against the Finance Act, say) confirms them together. Only rows still awaiting confirmation
 * are sent; each gets its own audit row.
 */
export function ConfirmSelectedButton({
  table,
  rows,
  onDone,
}: {
  table: VerifiableTable
  /** The ticked rows that still await confirmation: id, concurrency token, and what each is in words. */
  rows: Array<{ id: string; updatedAt: string; what: string }>
  onDone: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  if (rows.length === 0) return <span className="text-sm text-text-muted">The ticked rows are already confirmed.</span>
  const shown = rows.slice(0, 8)
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <BadgeCheckIcon aria-hidden="true" />
        Confirm {rows.length} against the source
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Confirm ${rows.length} ${rows.length === 1 ? "item" : "items"} against the source?`}
        description="You confirm that each of these matches the notification, circular or section it cites. Your name and today's date are recorded on every one."
        details={
          <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto text-sm text-text">
            {shown.map((r) => (
              <li key={r.id} className="flex gap-2">
                <BadgeCheckIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none text-text-muted" />
                <span className="min-w-0">{r.what}</span>
              </li>
            ))}
            {rows.length > shown.length ? <li className="pl-5.5 text-text-muted">and {rows.length - shown.length} more</li> : null}
          </ul>
        }
        confirmLabel={`Confirm ${rows.length}`}
        onConfirm={async () => {
          const r = await markVerifiedMany({ table, items: rows.map((x) => ({ id: x.id, updated_at: x.updatedAt })) })
          if (!r.ok) {
            toast.error(r.error)
            if (r.code === "conflict") router.refresh()
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success(`${r.data.confirmed} confirmed`)
          onDone()
          router.refresh()
        }}
      />
    </>
  )
}

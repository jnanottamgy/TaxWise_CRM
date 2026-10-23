"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { deleteClient } from "@/server/actions/clients"

/**
 * Delete a client (§7.3.4, Partner only): it moves to the recycle bin with its tasks, documents,
 * invoices and WhatsApp groups. Refused while an issued invoice is unpaid; the refusal says what to
 * do first. Restoring is a Partner or Manager action in the recycle bin (§7.19).
 */
export function DeleteClientDialog({
  client,
  open,
  onOpenChange,
  onDeleted,
}: {
  client: { id: string; name: string; code: string; updatedAt: string; openTasks?: number } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const router = useRouter()
  if (!client) return null
  const tasks = client.openTasks ?? 0
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={`Delete ${client.name}?`}
      description={`${client.name} (${client.code})${tasks ? `, its ${tasks} open ${tasks === 1 ? "task" : "tasks"},` : ""} its documents, invoices and WhatsApp groups move to the recycle bin. A Partner or Manager can restore them from there. Clients with unpaid invoices can't be deleted.`}
      confirmLabel="Delete client"
      onConfirm={async () => {
        try {
          const r = await deleteClient({ clientId: client.id, updatedAt: client.updatedAt })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error, { duration: 12_000 })
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success(`${r.data.display_name} is in the recycle bin.`)
          onDeleted?.()
          router.refresh()
        } catch {
          toast.error("We couldn't reach the server. Check your connection and try again.")
          return false
        }
      }}
    />
  )
}

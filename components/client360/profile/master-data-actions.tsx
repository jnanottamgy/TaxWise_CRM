"use client"

import * as React from "react"
import { NotebookPenIcon, PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Paise } from "@/lib/domain/money"
import type { MasterDataInput } from "@/components/client360/logic/master-data"
import { MasterDataDialog } from "@/components/client360/profile/master-data-dialog"
import { NotesDialog } from "@/components/client360/profile/notes-dialog"

/**
 * The Master data card's actions: Edit details (Partner/Manager, §7.3.3) and Edit notes (everyone
 * who can see the client: an Employee's limited edit, §4.1).
 */
export function MasterDataActions({
  canEdit,
  defaults,
  clientName,
  qrmpMaxTurnoverPaise,
  notes,
}: {
  canEdit: boolean
  defaults: MasterDataInput
  clientName: string
  qrmpMaxTurnoverPaise: Paise
  notes: string | null
}) {
  const [open, setOpen] = React.useState<"details" | "notes" | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {canEdit ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen("details")}>
          <PencilIcon aria-hidden="true" />
          Edit details
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen("notes")}>
          <NotebookPenIcon aria-hidden="true" />
          Edit notes
        </Button>
      )}
      {canEdit ? (
        <MasterDataDialog open={open === "details"} onOpenChange={(o) => setOpen(o ? "details" : null)} defaults={defaults} clientName={clientName} qrmpMaxTurnoverPaise={qrmpMaxTurnoverPaise} />
      ) : (
        <NotesDialog open={open === "notes"} onOpenChange={(o) => setOpen(o ? "notes" : null)} clientId={defaults.clientId} updatedAt={defaults.updatedAt} notes={notes} />
      )}
    </div>
  )
}

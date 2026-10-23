"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { startWhatsAppGroup } from "@/server/actions/whatsapp-groups"
import { AddGroupDialog } from "@/components/whatsapp/group-dialogs"

/** "Set up the WhatsApp group" (§7.25.2): a To create group named from the Settings format, with its checklist. */
export function StartGroupButton({ clientId, groupName }: { clientId: string; groupName: string }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const start = async () => {
    setPending(true)
    try {
      const r = await startWhatsAppGroup({ clientId })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`${r.data.name}: follow the checklist to create it in WhatsApp.`)
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <Button type="button" onClick={start} disabled={pending} title={`It will be named ${groupName}`}>
      {pending ? <Spinner /> : <PlusIcon aria-hidden="true" />}
      Set up the WhatsApp group
    </Button>
  )
}

/** "Add another group", for example a separate group for a statutory audit (§7.25.2). */
export function AddGroupButton({ clientId, baseName, clientCode }: { clientId: string; baseName: string; clientCode: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Add another group
      </Button>
      {open ? <AddGroupDialog open={open} onOpenChange={setOpen} clientId={clientId} baseName={baseName} clientCode={clientCode} /> : null}
    </>
  )
}

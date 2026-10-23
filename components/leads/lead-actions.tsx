"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Building2Icon, EllipsisIcon, FileTextIcon, PencilIcon, RotateCcwIcon, SearchCheckIcon, Trash2Icon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { ConflictCheckDialog } from "@/components/clients/onboarding/conflict-check-dialog"
import { EditLeadDialog, type StaffChoice } from "@/components/leads/lead-form-dialog"
import { useLeadMover } from "@/components/leads/lead-mover"
import type { LeadListRow } from "@/lib/data/leads"
import { deleteLead } from "@/server/actions/leads"

type DetailLead = LeadListRow & { requirement_notes: string | null }

/**
 * The lead page's actions (§7.5.1 lead detail): Create quotation (primary), Convert to client (the
 * onboarding wizard pre-filled from the lead), Run conflict check (§7.5.4, shared with onboarding),
 * Mark lost (reason*), and in the menu Edit, Reopen and Delete. A lead that became a client links
 * to it instead.
 */
export function LeadActions({
  lead,
  staff,
  latestCheck,
}: {
  lead: DetailLead
  staff: StaffChoice[]
  latestCheck: { acceptanceId: string; outcome: string; summary: string } | null
}) {
  const router = useRouter()
  const mover = useLeadMover()
  const [editing, setEditing] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const closed = lead.status === "won" || lead.status === "lost"
  const converted = Boolean(lead.converted_client_id)

  return (
    <>
      {converted ? (
        <Button asChild>
          <Link href={`/clients/${lead.converted_client_id}`}>
            <Building2Icon aria-hidden="true" />
            Open {lead.converted_client_name ?? "the client"}
          </Link>
        </Button>
      ) : (
        <>
          {lead.status !== "lost" ? (
            <Button asChild variant="outline">
              <Link href={`/clients/new?fromLead=${lead.id}`}>
                <Building2Icon aria-hidden="true" />
                Convert to client
              </Link>
            </Button>
          ) : null}
          <Button asChild>
            <Link href={`/quotations/new?lead=${lead.id}`}>
              <FileTextIcon aria-hidden="true" />
              Create quotation
            </Link>
          </Button>
        </>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions for this lead">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <PencilIcon aria-hidden="true" />
            Edit lead
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setChecking(true)}>
            <SearchCheckIcon aria-hidden="true" />
            Run conflict check
          </DropdownMenuItem>
          {!closed ? (
            <DropdownMenuItem onSelect={() => mover.move(lead, "lost")}>
              <XCircleIcon aria-hidden="true" />
              Mark lost
            </DropdownMenuItem>
          ) : null}
          {lead.status === "lost" ? (
            <DropdownMenuItem onSelect={() => mover.move(lead, "follow_up_required")}>
              <RotateCcwIcon aria-hidden="true" />
              Reopen (follow-up required)
            </DropdownMenuItem>
          ) : null}
          {!converted ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDeleting(true)} className="text-danger-text focus:text-danger-text">
                <Trash2Icon aria-hidden="true" />
                Delete lead
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditLeadDialog open={editing} onOpenChange={setEditing} lead={lead} staff={staff} />
      <ConflictCheckDialog
        open={checking}
        onOpenChange={setChecking}
        prospectName={lead.company || lead.name}
        legalName={lead.company ? lead.name : ""}
        pan=""
        gstin=""
        leadId={lead.id}
        attest={lead.services_required.includes("audit")}
        current={latestCheck}
        onDecided={(r) => {
          if (r.outcome !== "pending") toast.success(`Conflict check recorded: ${r.outcome === "accepted" ? "Accept" : "Decline"}.`)
          router.refresh()
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete ${lead.company || lead.name}?`}
        description="The lead moves to the recycle bin with its timeline. A Partner or Manager can restore it from there. Its quotations stay where they are."
        confirmLabel="Delete lead"
        onConfirm={async () => {
          const r = await deleteLead({ id: lead.id, updatedAt: lead.updated_at })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success("Lead moved to the recycle bin.")
          router.push("/leads")
        }}
      />
      {mover.dialogs}
    </>
  )
}

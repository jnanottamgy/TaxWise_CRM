"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PlusIcon, ShieldCheckIcon, ShieldIcon, UserMinusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { MemberChip } from "@/components/whatsapp/member-chips"
import { formatDate } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import type { ContactLike } from "@/lib/domain/whatsapp"
import { updateWhatsAppMember } from "@/server/actions/whatsapp-groups"
import { AddMemberDialog, type NumberOption } from "@/components/whatsapp/group-dialogs"

export interface MemberRow {
  id: string
  kind: string
  firm_kind: string | null
  display_name: string
  number: string | null
  display: string | null
  is_admin: boolean
  added_on: string | null
  removed_on: string | null
  source: string
  updated_at: string
}

/**
 * Who is in the group (Partner/Manager): make someone an admin or not, record that someone left
 * (house rule 7: a departed Partner's number is removed from every group), add someone who was
 * added in WhatsApp. Members fill in from the checklist when the group is marked created; this is
 * for changes after that.
 */
export function MembersDialog({
  open,
  onOpenChange,
  groupId,
  groupName,
  members,
  former,
  numbers,
  contacts,
  countryCode,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  groupName: string
  members: MemberRow[]
  former: MemberRow[]
  numbers: NumberOption[]
  contacts: ContactLike[]
  countryCode: string
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)

  const run = async (m: MemberRow, patch: { isAdmin?: boolean; removedOn?: string }, done: string) => {
    setBusy(m.id)
    try {
      const r = await updateWhatsAppMember({ memberId: m.id, updatedAt: m.updated_at, ...patch })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      toast.success(done)
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <FormDialog
        open={open && !adding}
        onOpenChange={onOpenChange}
        title="Members"
        description={`Who is in ${groupName}. Change the group in WhatsApp first, then record it here.`}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" />
              Add a member
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        }
      >
        <ul className="flex flex-col">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/70 py-2.5 first:border-t-0">
              <div className="flex min-w-0 flex-col gap-0.5">
                <MemberChip member={m} className="self-start" />
                <span className="text-xs text-text-muted">
                  {m.display ?? "No number"}
                  {m.added_on ? ` · added ${formatDate(m.added_on)}` : ""}
                  {m.source === "manual" ? " · added by hand" : ""}
                </span>
              </div>
              <div className="flex flex-none items-center gap-1.5">
                {busy === m.id ? <Spinner /> : null}
                <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => run(m, { isAdmin: !m.is_admin }, m.is_admin ? `${m.display_name} is no longer marked as an admin.` : `${m.display_name} is marked as an admin.`)}>
                  {m.is_admin ? <ShieldIcon aria-hidden="true" /> : <ShieldCheckIcon aria-hidden="true" />}
                  {m.is_admin ? "Not admin" : "Make admin"}
                </Button>
                <Button type="button" variant="destructive-outline" size="sm" disabled={!!busy} onClick={() => run(m, { removedOn: todayIST() }, `${m.display_name} is recorded as removed today.`)}>
                  <UserMinusIcon aria-hidden="true" />
                  Removed
                </Button>
              </div>
            </li>
          ))}
          {members.length === 0 ? <li className="py-3 text-sm text-text-muted">Nobody is recorded in this group yet.</li> : null}
        </ul>
        {former.length ? (
          <div className="mt-4">
            <p className="text-sm font-medium text-text">Left the group</p>
            <ul className="mt-1 flex flex-col text-sm text-text-muted">
              {former.map((m) => (
                <li key={m.id} className="py-1">
                  {m.display_name}
                  {m.removed_on ? ` · removed ${formatDate(m.removed_on)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </FormDialog>
      {adding ? (
        <AddMemberDialog
          open={adding}
          onOpenChange={(o) => setAdding(o)}
          groupId={groupId}
          numbers={numbers}
          contacts={contacts}
          countryCode={countryCode}
          memberNumbers={members.map((m) => m.number).filter((n): n is string => !!n)}
        />
      ) : null}
    </>
  )
}

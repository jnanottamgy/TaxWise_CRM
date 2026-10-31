"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ListChecksIcon, MoreHorizontalIcon, PencilIcon, StarIcon, UsersIcon, XCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { StatusChip } from "@/components/app/status-chip"
import { CopyButton } from "@/components/app/copy-button"
import { formatDate } from "@/lib/format"
import { lastOpenedSentence, numbersToAdd, type ChecklistState, type ContactLike } from "@/lib/domain/whatsapp"
import { setPrimaryWhatsAppGroup } from "@/server/actions/whatsapp-groups"
import { MemberChips, MemberLegend } from "@/components/whatsapp/member-chips"
import { OpenChatButton } from "@/components/whatsapp/open-chat-button"
import { InviteLink } from "@/components/whatsapp/invite-link"
import { SetupChecklist, type ChecklistNumber } from "@/components/whatsapp/setup-checklist"
import { CloseGroupDialog, EditGroupDialog, MarkCreatedDialog } from "@/components/whatsapp/group-dialogs"
import { MembersDialog, type MemberRow } from "@/components/whatsapp/members-dialog"

export interface GroupCardGroup {
  id: string
  name: string
  purpose: string | null
  is_primary: boolean
  status: "to_create" | "active" | "closed"
  created_on: string | null
  created_by_label: string | null
  checklist: ChecklistState
  progress: { done: number; total: number }
  last_opened_at: string | null
  last_opened_by_name: string | null
  closed_at: string | null
  closed_reason: string | null
  notes: string | null
  updated_at: string
  has_invite_link: boolean
  members: MemberRow[]
  former: MemberRow[]
}

type Dialog = null | "mark" | "close" | "edit" | "members"

/**
 * One client WhatsApp group (§7.25.1): the name (copy), status and purpose; members as chips
 * coloured by kind with admins marked; the checklist progress; the invite link (Partner/Manager,
 * hidden until Reveal); "Last opened 2 hours ago by Anita". Actions: Open chat · Checklist · Close
 * group, and for Partners and Managers Edit, Make primary and Members. A group still To create
 * opens with its checklist showing.
 */
export function GroupCard({
  clientId,
  clientCode,
  group,
  canManage,
  browserAllowed,
  viewerId,
  names,
  firmNumbers,
  contacts,
  shortName,
  countryCode,
  welcomeText,
}: {
  clientId: string
  clientCode: string
  group: GroupCardGroup
  canManage: boolean
  browserAllowed: boolean
  viewerId: string
  names: Record<string, string>
  firmNumbers: ChecklistNumber[]
  contacts: ContactLike[]
  shortName: string
  countryCode: string
  welcomeText: string
}) {
  const router = useRouter()
  const [updatedAt, setUpdatedAt] = React.useState(group.updated_at)
  const [seen, setSeen] = React.useState(group.updated_at)
  if (seen !== group.updated_at) {
    setSeen(group.updated_at)
    setUpdatedAt(group.updated_at)
  }
  const [showChecklist, setShowChecklist] = React.useState(group.status === "to_create")
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const [now] = React.useState(() => new Date())
  const closeDialog = (o: boolean) => {
    if (!o) setDialog(null)
  }

  const live = group.status !== "closed"
  const ownerNames = new Map(firmNumbers.filter((n) => n.employee_id && n.owner_name).map((n) => [n.employee_id!, n.owner_name!]))
  const toAdd = numbersToAdd({ firmNumbers, contacts, selectedContactIds: group.checklist.contactIds, shortName, countryCode, ownerNames })

  const facts = [
    group.purpose,
    group.status === "active" && group.created_on ? `Created ${formatDate(group.created_on)}${group.created_by_label ? ` from ${group.created_by_label}` : ""}` : null,
    group.status === "to_create" ? `Setup ${group.progress.done} of ${group.progress.total} steps done` : null,
    group.status === "closed" && group.closed_at ? `Closed ${formatDate(group.closed_at)}` : null,
  ].filter(Boolean) as string[]

  const makePrimary = async () => {
    try {
      const r = await setPrimaryWhatsAppGroup({ groupId: group.id })
      if (!r.ok) return void toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      toast.success(`${group.name} is now the primary group. It's listed first and shown on the client's overview.`)
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    }
  }

  return (
    <section aria-labelledby={`group-${group.id}`} className="min-w-0 rounded-lg border border-border bg-surface">
      {/* Phones: the actions go under the name, which otherwise shrinks to a sliver beside them. */}
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3 sm:flex-row sm:items-start sm:justify-between sm:gap-x-4 md:px-5">
        <div className="min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={`group-${group.id}`} className="min-w-0 text-md leading-6 font-semibold [overflow-wrap:anywhere] text-text">
              {group.name}
            </h3>
            <CopyButton value={group.name} label="group name" />
            <StatusChip kind="whatsapp_group_status" value={group.status} variant="pill" />
            {group.is_primary && live ? (
              <span className="inline-flex h-5 flex-none items-center rounded-full border border-border px-2 text-xs font-medium text-text-muted" title="The client's main group: listed first and shown on the client's overview">
                Primary
              </span>
            ) : null}
          </div>
          {facts.length ? <p className="mt-1 text-sm text-text-muted">{facts.join(" · ")}</p> : null}
          {group.status === "active" ? <p className="mt-0.5 text-sm text-text-muted" suppressHydrationWarning>{lastOpenedSentence(group.last_opened_at, group.last_opened_by_name, now)}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-none sm:justify-end">
          {group.status === "active" ? (
            <OpenChatButton clientId={clientId} groupId={group.id} groupName={group.name} browserAllowed={browserAllowed} />
          ) : null}
          {live ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowChecklist((v) => !v)} aria-expanded={showChecklist} aria-controls={`checklist-panel-${group.id}`}>
              <ListChecksIcon aria-hidden="true" />
              {showChecklist ? "Hide checklist" : "Checklist"}
              <span className="num text-text-muted">
                {group.progress.done}/{group.progress.total}
              </span>
            </Button>
          ) : null}
          {canManage && live ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setDialog("close")}>
              <XCircleIcon aria-hidden="true" />
              Close group
            </Button>
          ) : null}
          {canManage && live ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${group.name}`}>
                  <MoreHorizontalIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog("edit")}>
                  <PencilIcon aria-hidden="true" />
                  Edit name and purpose
                </DropdownMenuItem>
                {group.status === "active" ? (
                  <DropdownMenuItem onSelect={() => setDialog("members")}>
                    <UsersIcon aria-hidden="true" />
                    Members
                  </DropdownMenuItem>
                ) : null}
                {!group.is_primary ? (
                  <DropdownMenuItem onSelect={() => void makePrimary()}>
                    <StarIcon aria-hidden="true" />
                    Make primary
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border px-4 py-3 md:px-5">
        {group.members.length ? (
          <div className="flex flex-col gap-2">
            <MemberChips members={group.members} />
            <MemberLegend />
          </div>
        ) : group.status === "to_create" ? (
          <p className="text-sm text-text-muted">The members fill in from the checklist when the group is marked created.</p>
        ) : (
          <p className="text-sm text-text-muted">No members are recorded for this group.</p>
        )}
      </div>

      {canManage || group.notes || group.closed_reason ? (
        <dl className="grid grid-cols-1 gap-x-8 border-t border-border px-4 py-2 md:px-5">
          {canManage && group.status !== "to_create" ? (
            <div className="grid min-h-10 grid-cols-[minmax(7.5rem,30%)_1fr] items-center gap-3 py-1.5">
              <dt className="text-sm text-text-muted">Invite link</dt>
              <dd className="min-w-0">
                <InviteLink groupId={group.id} updatedAt={updatedAt} hasLink={group.has_invite_link} editable={live} />
              </dd>
            </div>
          ) : null}
          {group.status === "closed" && group.closed_reason ? (
            <div className="grid min-h-10 grid-cols-[minmax(7.5rem,30%)_1fr] items-baseline gap-3 py-1.5">
              <dt className="text-sm text-text-muted">Why it closed</dt>
              <dd className="text-base whitespace-pre-line text-text">{group.closed_reason}</dd>
            </div>
          ) : null}
          {group.notes ? (
            <div className="grid min-h-10 grid-cols-[minmax(7.5rem,30%)_1fr] items-baseline gap-3 py-1.5">
              <dt className="text-sm text-text-muted">Notes</dt>
              <dd className="text-base whitespace-pre-line text-text">{group.notes}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {showChecklist && live ? (
        <div id={`checklist-panel-${group.id}`} className="border-t border-border pb-2">
          <SetupChecklist
            clientId={clientId}
            groupId={group.id}
            groupName={group.name}
            status={group.status}
            updatedAt={updatedAt}
            onSaved={setUpdatedAt}
            checklist={group.checklist}
            names={names}
            viewerId={viewerId}
            canManage={canManage}
            firmNumbers={firmNumbers}
            contacts={contacts}
            shortName={shortName}
            countryCode={countryCode}
            welcomeText={welcomeText}
            onMarkCreated={() => setDialog("mark")}
            onEditName={() => setDialog("edit")}
          />
        </div>
      ) : null}

      {dialog === "mark" ? (
        <MarkCreatedDialog open onOpenChange={closeDialog} groupId={group.id} groupName={group.name} updatedAt={updatedAt} numbers={firmNumbers} members={toAdd} />
      ) : null}
      {dialog === "close" ? (
        <CloseGroupDialog open onOpenChange={closeDialog} groupId={group.id} groupName={group.name} updatedAt={updatedAt} isPrimary={group.is_primary} createdOn={group.created_on} />
      ) : null}
      {dialog === "edit" ? (
        <EditGroupDialog
          open
          onOpenChange={closeDialog}
          groupId={group.id}
          updatedAt={updatedAt}
          name={group.name}
          purpose={group.purpose}
          notes={group.notes}
          clientCode={clientCode}
          status={group.status}
        />
      ) : null}
      {dialog === "members" ? (
        <MembersDialog
          open
          onOpenChange={closeDialog}
          groupId={group.id}
          groupName={group.name}
          members={group.members}
          former={group.former}
          numbers={firmNumbers}
          contacts={contacts}
          countryCode={countryCode}
        />
      ) : null}
    </section>
  )
}

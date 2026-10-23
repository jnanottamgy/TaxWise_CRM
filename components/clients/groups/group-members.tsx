"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Building2Icon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { GROUP_MEMBERS_MAX } from "@/lib/schemas/client-groups"
import { addGroupMembers, deleteClientGroup, removeGroupMember, searchGroupCandidates } from "@/server/actions/client-groups"
import type { GroupMemberRow } from "@/lib/data/client-groups"
import { EMPTY } from "@/lib/format"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { runWithToasts } from "@/components/clients/client-ui"

/** The members of a group (§7.4), each with its next deadline, open tasks and (Partner/Manager) outstanding. */
export function GroupMembersTable({
  groupId,
  groupName,
  rows,
  today,
  seesMoney,
}: {
  groupId: string
  groupName: string
  rows: GroupMemberRow[]
  today: string
  seesMoney: boolean
}) {
  const router = useRouter()
  const [removing, setRemoving] = React.useState<string | null>(null)

  const remove = React.useCallback(
    async (r: GroupMemberRow) => {
      setRemoving(r.id)
      const done = await runWithToasts(() => removeGroupMember({ groupId, clientId: r.id }), {
        success: (d) => (d.removed ? `${r.display_name} is no longer in ${groupName}.` : `${r.display_name} had already left the group.`),
      })
      setRemoving(null)
      if (done) router.refresh()
    },
    [groupId, groupName, router],
  )

  const columns = React.useMemo<DataTableColumn<GroupMemberRow>[]>(() => {
    const cols: DataTableColumn<GroupMemberRow>[] = [
      { id: "display_name", header: "Client", hideable: false, mobile: "primary", width: "30%", cell: (r) => <span className="truncate">{r.display_name}</span> },
      { id: "client_code", header: "Code", mobile: "secondary", cell: (r) => <MonoId value={r.client_code} copy label="client code" /> },
      { id: "status", header: "Status", mobile: "trailing", cell: (r) => <StatusChip kind="client_status" value={r.status} /> },
      { id: "owner_name", header: "Owner", hideBelow: "lg", cell: (r) => <span className="text-text-muted">{r.owner_name ?? "Unassigned"}</span> },
      {
        id: "next_due_date",
        header: "Next deadline",
        align: "right",
        mobile: "secondary",
        cell: (r) =>
          r.next_due_date ? (
            <span className="inline-flex flex-col items-end leading-5" title={r.next_due_title ?? undefined}>
              <DateText date={r.next_due_date} withRelative today={today} />
              <span className="max-w-48 truncate text-xs text-text-muted">{r.next_due_title}</span>
            </span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
        mobileCell: (r) => (r.next_due_date ? <DateText date={r.next_due_date} withRelative today={today} /> : "No deadline"),
      },
      {
        id: "open_tasks",
        header: "Open tasks",
        align: "right",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <span>{r.open_tasks}</span>
            {r.overdue_tasks ? <span className="text-xs text-danger-text">{r.overdue_tasks} overdue</span> : null}
          </span>
        ),
      },
    ]
    if (seesMoney) cols.push({ id: "outstanding", header: "Outstanding", align: "right", cell: (r) => <Money value={r.outstanding} /> })
    cols.push({
      id: "actions",
      header: "Actions",
      align: "right",
      hideable: false,
      width: "7rem",
      cell: (r) => (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-row-click-ignore
          disabled={removing === r.id}
          onClick={() => void remove(r)}
          aria-label={`Remove ${r.display_name} from ${groupName}`}
        >
          <XIcon aria-hidden="true" />
          Remove
        </Button>
      ),
    })
    return cols
  }, [seesMoney, today, removing, remove, groupName])

  return (
    <DataTable
      id="client-group-members"
      caption={`Clients in ${groupName}`}
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/clients/${r.id}`}
      total={rows.length}
      page={1}
      pageSize={Math.max(rows.length, 25)}
      isFiltered={false}
      maxHeight="none"
      countLabel={(n, t) => `${n} ${t === 1 ? "client" : "clients"}`}
      empty={<EmptyState icon={<Building2Icon />} message="No clients in this group yet." action={<AddMembersDialog groupId={groupId} groupName={groupName} size="sm" />} />}
    />
  )
}

/** Add members (§7.4): search clients by name, code, PAN or GSTIN; a client already in another group moves here. */
export function AddMembersDialog({ groupId, groupName, size = "default" }: { groupId: string; groupName: string; size?: "default" | "sm" }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [chosen, setChosen] = React.useState<ComboOption[]>([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const id = React.useId()

  const load = React.useCallback(
    async (q: string): Promise<ComboOption[]> => {
      const r = await searchGroupCandidates({ q, groupId })
      return r.ok ? r.data : []
    },
    [groupId],
  )

  const moving = chosen.filter((c) => c.description?.includes(" · in "))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chosen.length) {
      setError({ message: "Choose at least one client." })
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await addGroupMembers({ groupId, clientIds: chosen.map((c) => c.value) })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(r.data.added ? `${r.data.added} ${r.data.added === 1 ? "client" : "clients"} added to ${groupName}.` : "They were already in this group.")
      setOpen(false)
      setChosen([])
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button
        size={size}
        onClick={() => {
          setChosen([])
          setError(null)
          setOpen(true)
        }}
      >
        <UserPlusIcon aria-hidden="true" />
        Add clients
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title={`Add clients to ${groupName}`}
        description="A client is in one group at a time: one already in another group moves here."
        onSubmit={submit}
        pending={pending}
        dirty={chosen.length > 0}
        submitDisabled={chosen.length === 0}
        submitLabel={chosen.length > 1 ? `Add ${chosen.length} clients` : "Add client"}
      >
        <div className="flex flex-col gap-4">
          {error ? <FormAlert error={error} /> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>Client</Label>
            <Combobox
              id={id}
              value={null}
              onChange={(_v, option) => {
                if (option && !chosen.some((c) => c.value === option.value)) setChosen((cs) => [...cs, option])
              }}
              loadOptions={load}
              placeholder={chosen.length ? "Add another client" : "Search by name, code, PAN or GSTIN"}
              searchPlaceholder="Name, code, PAN or GSTIN"
              emptyText="No clients match, or they're already in this group."
              clearable={false}
              disabled={chosen.length >= GROUP_MEMBERS_MAX}
            />
          </div>
          {chosen.length ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label="Clients to add">
              {chosen.map((c) => (
                <li key={c.value} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-text">{c.label}</span>
                    {c.description ? <span className="block truncate text-sm text-text-muted">{c.description}</span> : null}
                  </span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Don't add ${c.label}`} onClick={() => setChosen((cs) => cs.filter((x) => x.value !== c.value))}>
                    <XIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {moving.length ? (
            <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-text">
              {moving.length === 1 ? `${moving[0].label} moves from its current group to ${groupName}.` : `${moving.length} of these clients move from their current group to ${groupName}.`}
            </p>
          ) : null}
        </div>
      </FormDialog>
    </>
  )
}

/** Delete a group (§7.4): its clients stay, without a group. */
export function DeleteGroupButton({ group }: { group: { id: string; name: string; members: number; updatedAt: string } }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Trash2Icon aria-hidden="true" />
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        destructive
        title={`Delete the group ${group.name}?`}
        description={
          group.members
            ? `The group goes; its ${group.members} ${group.members === 1 ? "client stays" : "clients stay"} in the client list without a group. Their tasks, deadlines and invoices don't change.`
            : "The group goes. It has no clients."
        }
        confirmLabel="Delete group"
        onConfirm={async () => {
          const done = await runWithToasts(() => deleteClientGroup({ id: group.id, updatedAt: group.updatedAt }), { success: `Group ${group.name} deleted.` })
          if (!done) return false
          router.push("/clients/groups")
        }}
      />
    </>
  )
}

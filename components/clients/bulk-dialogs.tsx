"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { bulkAddToGroup, bulkAssignOwner } from "@/server/actions/clients"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { Label } from "@/components/ui/label"
import type { BulkResult } from "@/server/actions/clients"

function reportSkipped(skipped: BulkResult["skipped"]) {
  if (!skipped.length) return
  toast.message(
    `${skipped.length} left as they were: ${skipped
      .slice(0, 3)
      .map((s) => `${s.name} (${s.reason})`)
      .join("; ")}${skipped.length > 3 ? " …" : ""}`,
    { duration: 10_000 },
  )
}

/** Bulk "Assign owner" (§7.3.1). */
export function BulkOwnerDialog({
  clientIds,
  staff,
  open,
  onOpenChange,
  onDone,
}: {
  clientIds: string[]
  staff: ComboOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const router = useRouter()
  const [owner, setOwner] = React.useState<string | null>(null)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!owner) {
      setError({ message: "Choose the new owner." })
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await bulkAssignOwner({ clientIds, ownerEmployeeId: owner })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      const name = staff.find((s) => s.value === owner)?.label ?? "the new owner"
      toast.success(r.data.changed ? `${r.data.changed} ${r.data.changed === 1 ? "client" : "clients"} assigned to ${name}.` : "Nothing changed.")
      reportSkipped(r.data.skipped)
      onOpenChange(false)
      onDone?.()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Assign an owner to ${clientIds.length} ${clientIds.length === 1 ? "client" : "clients"}`}
      description="The owner leads the client's work and gets its notifications. Their open tasks stay with whoever has them."
      onSubmit={submit}
      pending={pending}
      dirty={!!owner}
      submitLabel="Assign owner"
    >
      <div className="flex flex-col gap-4">
        {error ? <FormAlert error={error} /> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id}>
            New owner<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
          </Label>
          <Combobox id={id} value={owner} onChange={(v) => setOwner(v)} options={staff} placeholder="Choose a member of the team" searchPlaceholder="Search the team" />
        </div>
      </div>
    </FormDialog>
  )
}

/** Bulk "Add to group" (§7.3.1, §7.4). A client is in one group at a time. */
export function BulkGroupDialog({
  clientIds,
  groups,
  open,
  onOpenChange,
  onDone,
}: {
  clientIds: string[]
  groups: ComboOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const router = useRouter()
  const [group, setGroup] = React.useState<string | null>(null)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()
  const NONE = "__none__"
  const options = React.useMemo(() => [...groups, { value: NONE, label: "No group", description: "Take them out of their group" }], [groups])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!group) {
      setError({ message: "Choose a group." })
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await bulkAddToGroup({ clientIds, groupId: group === NONE ? null : group })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      const name = groups.find((g) => g.value === group)?.label
      toast.success(
        r.data.changed === 0 ? "Nothing changed." : name ? `${r.data.changed} added to ${name}.` : `${r.data.changed} taken out of their group.`,
      )
      reportSkipped(r.data.skipped)
      onOpenChange(false)
      onDone?.()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Add ${clientIds.length} ${clientIds.length === 1 ? "client" : "clients"} to a group`}
      description="A client belongs to one group at a time: one already in another group moves to this one."
      onSubmit={submit}
      pending={pending}
      dirty={!!group}
      submitLabel="Save"
    >
      <div className="flex flex-col gap-4">
        {error ? <FormAlert error={error} /> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id}>
            Group<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
          </Label>
          <Combobox id={id} value={group} onChange={(v) => setGroup(v)} options={options} placeholder="Choose a group" searchPlaceholder="Search groups" emptyText="No groups yet. Create one on Client groups." />
        </div>
      </div>
    </FormDialog>
  )
}

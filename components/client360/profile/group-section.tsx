"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PencilIcon, UsersIcon } from "lucide-react"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { ClientGroupSchema, type ClientGroupInput } from "@/components/client360/logic/profile-schemas"
import { setClientGroup } from "@/server/actions/client-profile"

/** "No group" in the select, until it is sent. */
const NONE = "none"
const NEW = "new"

const GroupFormSchema = ClientGroupSchema.safeExtend({
  groupId: z
    .union([z.uuid({ error: "Choose a group from the list." }), z.literal(NONE), z.literal(NEW), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v && v !== NONE && v !== NEW ? v : null)),
})
type GroupFormInput = z.input<typeof GroupFormSchema>

function send(input: GroupFormInput) {
  const choice = input.groupId
  const payload: ClientGroupInput = {
    ...input,
    groupId: choice && choice !== NONE && choice !== NEW ? choice : null,
    newGroupName: choice === NEW ? input.newGroupName : null,
  }
  return setClientGroup(payload)
}

/**
 * The client's group (§7.4; §7.3.3 Profile & contacts → Group): the group page shows combined work
 * and (for Partners and Managers) outstanding across members. Partners and Managers move the
 * client into an existing group, a new one, or none.
 */
export function GroupSection({
  clientId,
  clientName,
  updatedAt,
  group,
  groups,
  canManage,
}: {
  clientId: string
  clientName: string
  updatedAt: string
  group: { id: string; name: string } | null
  groups: Array<{ id: string; name: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const defaults: GroupFormInput = { clientId, updatedAt, groupId: group?.id ?? NONE, newGroupName: "" }
  const f = useActionForm(GroupFormSchema, send, {
    defaultValues: defaults,
    successMessage: "Group saved.",
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])
  const choice = f.form.watch("groupId")
  const newName = f.form.watch("newGroupName")
  React.useEffect(() => {
    // A name typed for a new group is dropped when an existing group (or none) is chosen instead.
    if (choice !== NEW && newName) f.form.setValue("newGroupName", "")
  }, [choice, newName, f.form])

  return (
    <SectionCard
      id="group"
      title="Group"
      description="Related clients, such as a family or a business group, shown together"
      action={
        canManage ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <PencilIcon aria-hidden="true" />
            {group ? "Change" : "Add to a group"}
          </Button>
        ) : undefined
      }
    >
      {group ? (
        <Link href={`/clients/groups/${group.id}`} className="inline-flex items-center gap-2 rounded-sm text-base font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <UsersIcon aria-hidden="true" className="size-4 text-text-muted" />
          {group.name}
        </Link>
      ) : (
        <EmptyState size="compact" message="Not in a group." />
      )}

      {canManage ? (
        <FormDialog
          open={open}
          onOpenChange={setOpen}
          title="Client group"
          description={`Put ${clientName} in a group with related clients. Invoices stay per client.`}
          onSubmit={f.onSubmit}
          pending={f.pending}
          dirty={f.form.formState.isDirty}
          submitLabel="Save group"
          size="sm"
        >
          <div className="flex flex-col gap-4">
            <FormAlert state={f} />
            <SelectField
              control={f.control}
              name="groupId"
              label="Group"
              options={[{ value: NONE, label: "No group" }, ...groups.map((g) => ({ value: g.id, label: g.name })), { value: NEW, label: "New group…" }]}
            />
            {choice === NEW ? <TextField control={f.control} name="newGroupName" label="New group name" required maxLength={120} placeholder="Sharma family" /> : null}
          </div>
        </FormDialog>
      ) : null}
    </SectionCard>
  )
}

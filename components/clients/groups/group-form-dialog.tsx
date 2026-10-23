"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PencilIcon, PlusIcon } from "lucide-react"
import { CreateClientGroupSchema, UpdateClientGroupSchema } from "@/lib/schemas/client-groups"
import { createClientGroup, updateClientGroup } from "@/server/actions/client-groups"
import { useActionForm } from "@/hooks/use-action-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField, TextareaField } from "@/components/app/form/fields"
import { Button } from "@/components/ui/button"

/** New group (§7.4): name (unique) and notes; members are added on the group's page. */
export function NewGroupDialog({ variant = "default" }: { variant?: "default" | "outline" }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const f = useActionForm(CreateClientGroupSchema, createClientGroup, {
    defaultValues: { name: "", notes: "", clientIds: [] },
    successMessage: (g) => `Group ${g.name} created. Add its clients next.`,
    onSuccess: (g) => {
      setOpen(false)
      f.form.reset({ name: "", notes: "", clientIds: [] })
      router.push(`/clients/groups/${g.id}`)
    },
  })
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        New group
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="New client group"
        description="A family or group of companies whose work you look at together. Each client is in one group at a time; invoicing stays per client."
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Create group"
      >
        <FormAlert state={f} />
        <div className="flex flex-col gap-4">
          <TextField control={f.control} name="name" label="Name" required placeholder="Sharma family" autoComplete="off" />
          <TextareaField control={f.control} name="notes" label="Notes" rows={3} placeholder="Who leads the family's affairs, how they like to be contacted" />
        </div>
      </FormDialog>
    </>
  )
}

/** Edit a group's name and notes, with the row's updated_at for concurrency (§13). */
export function EditGroupDialog({ group }: { group: { id: string; name: string; notes: string | null; updatedAt: string } }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const defaults = { id: group.id, name: group.name, notes: group.notes ?? "", updatedAt: group.updatedAt }
  const f = useActionForm(UpdateClientGroupSchema, updateClientGroup, {
    defaultValues: defaults,
    successMessage: "Group saved.",
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
  })
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          f.form.reset(defaults)
          f.clearFormError()
          setOpen(true)
        }}
      >
        <PencilIcon aria-hidden="true" />
        Edit
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title={`Edit ${group.name}`}
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Save"
      >
        <FormAlert state={f} />
        <div className="flex flex-col gap-4">
          <TextField control={f.control} name="name" label="Name" required autoComplete="off" />
          <TextareaField control={f.control} name="notes" label="Notes" rows={4} />
        </div>
      </FormDialog>
    </>
  )
}

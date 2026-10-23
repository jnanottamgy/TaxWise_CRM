"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { ChangeEmailSchema, ChangeRoleSchema, UpdatePersonSchema, type StaffRole } from "@/lib/schemas/people"
import type { AppRole } from "@/lib/auth/roles"
import { changeEmail, changeRole, updatePerson } from "@/server/actions/people"
import { ContactAndJobFields, RateAndAccessFields, RoleField } from "@/components/people/person-fields"

export interface EditablePerson {
  id: string
  profile_id: string | null
  full_name: string
  email: string
  phone: string | null
  whatsapp: string | null
  department: string | null
  designation: string | null
  date_of_joining: string | null
  role: StaffRole
  login_status: "active" | "disabled" | "no_login"
  vault_access: boolean
  icai_membership_no: string | null
  billing_rate_per_hour: string | number | null
  cost_rate_per_hour: string | number | null
  updated_at: string
}

/** Edit details (§4.5 point 1 fields). Email and role have their own dialogs. */
export function EditPersonDialog({
  person,
  actorRole,
  open,
  onOpenChange,
}: {
  person: EditablePerson
  actorRole: AppRole
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const isPartner = actorRole === "partner"
  const f = useActionForm(UpdatePersonSchema, updatePerson, {
    defaultValues: {
      id: person.id,
      updated_at: person.updated_at,
      full_name: person.full_name,
      phone: person.phone ?? "",
      whatsapp: person.whatsapp ?? "",
      department: person.department ?? "",
      designation: person.designation ?? "",
      date_of_joining: person.date_of_joining ?? "",
      billing_rate_per_hour: person.billing_rate_per_hour === null ? "" : String(person.billing_rate_per_hour),
      cost_rate_per_hour: person.cost_rate_per_hour === null ? "" : String(person.cost_rate_per_hour),
      vault_access: person.vault_access,
      icai_membership_no: person.icai_membership_no ?? "",
    },
    successMessage: "Details saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Edit ${person.full_name}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save details"
    >
      <FormAlert state={f} />
      <div className="flex flex-col gap-6">
        <ContactAndJobFields control={f.control} showEmail={false} />
        <RateAndAccessFields control={f.control} isPartner={isPartner} showMembership={isPartner && person.role === "partner"} />
      </div>
    </FormDialog>
  )
}

/** Change email (§4.5 point 4): the sign-in email moves too; a refusal lands on the field. */
export function ChangeEmailDialog({ person, open, onOpenChange }: { person: EditablePerson; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const f = useActionForm(ChangeEmailSchema, changeEmail, {
    defaultValues: { id: person.id, email: person.email, updated_at: person.updated_at },
    successMessage: "Email changed.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Change email"
      description={
        person.profile_id
          ? `${person.full_name} signs in with the new address from now on. Their password doesn't change.`
          : `${person.full_name} has no login yet; their record's email changes.`
      }
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Change email"
    >
      <FormAlert state={f} />
      <TextField control={f.control} name="email" label="New email" required type="email" autoComplete="off" />
    </FormDialog>
  )
}

/** Change role (§4.5 point 5, Partner only): the role, then the sign-in token, then their sessions end. */
export function ChangeRoleDialog({ person, open, onOpenChange }: { person: EditablePerson; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const f = useActionForm(ChangeRoleSchema, changeRole, {
    defaultValues: { id: person.id, role: person.role, updated_at: person.updated_at },
    successMessage: "Role changed.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Change ${person.full_name}'s role`}
      description={person.profile_id ? "It takes effect at once: they are signed out everywhere and sign in again with the new role." : "They get this role when their login is issued."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Change role"
    >
      <FormAlert state={f} />
      <RoleField control={f.control} name="role" roles={["partner", "manager", "employee"]} />
    </FormDialog>
  )
}

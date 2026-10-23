"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { UserPlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { useActionForm } from "@/hooks/use-action-form"
import { AddPersonSchema, assignableRoles } from "@/lib/schemas/people"
import type { AppRole } from "@/lib/auth/roles"
import { addTeamMember, type LoginHandout } from "@/server/actions/people"
import { ContactAndJobFields, RateAndAccessFields, RoleField } from "@/components/people/person-fields"
import { LoginCreatedDialog } from "@/components/people/login-created-dialog"

/**
 * Add team member (§4.5 points 1–2). The login is issued on save; the "Login created" dialog then
 * shows the temporary password once, with WhatsApp and Gmail hand-offs and the invite email's
 * outcome. Managers add Employees only, and don't see the Partner-only fields.
 */
export function AddPersonDialog({ actorRole }: { actorRole: AppRole }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [login, setLogin] = React.useState<LoginHandout | null>(null)
  const roles = assignableRoles(actorRole)
  const isPartner = actorRole === "partner"

  const f = useActionForm(AddPersonSchema, addTeamMember, {
    defaultValues: {
      full_name: "",
      email: "",
      phone: "",
      whatsapp: "",
      department: "",
      designation: "",
      date_of_joining: "",
      role: roles.length === 1 ? roles[0] : "employee",
      billing_rate_per_hour: "",
      cost_rate_per_hour: "",
      vault_access: false,
      icai_membership_no: "",
    },
    resetOnSuccess: false,
    onSuccess: (data) => {
      setOpen(false)
      f.form.reset()
      setLogin(data)
      router.refresh()
    },
  })
  const role = useWatch({ control: f.control, name: "role" })

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <UserPlusIcon aria-hidden="true" />
        Add team member
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title="Add team member"
        description="Their login is created when you save, with a temporary password they change at first sign-in."
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Add and create login"
      >
        <FormAlert state={f} />
        <div className="flex flex-col gap-6">
          <ContactAndJobFields control={f.control} showEmail />
          <RoleField control={f.control} name="role" roles={roles} />
          <RateAndAccessFields control={f.control} isPartner={isPartner} showMembership={isPartner && role === "partner"} />
        </div>
      </FormDialog>
      {login ? <LoginCreatedDialog logins={[login]} open={!!login} onOpenChange={(o) => !o && setLogin(null)} /> : null}
    </>
  )
}

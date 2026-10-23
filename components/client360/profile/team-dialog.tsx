"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { CheckboxGroupField, ComboboxField, SelectField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { ROLE_LABEL, type AppRole } from "@/lib/auth/roles"
import { z } from "zod"
import { ClientTeamSchema, type ClientTeamInput } from "@/components/client360/logic/profile-schemas"
import type { TeamPick } from "@/components/client360/logic/team"
import { setClientTeam } from "@/server/actions/client-profile"

export interface StaffChoice {
  id: string
  name: string
  role: AppRole
  designation: string | null
}

/** A select can't hold an empty value, so "None" is this token until it is sent. */
const NONE = "none"

const noneOr = (what: string) =>
  z
    .union([z.uuid({ error: `That ${what} isn't valid.` }), z.literal(NONE), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v && v !== NONE ? v : null))

const TeamFormSchema = ClientTeamSchema.extend({ engagementPartner: noneOr("engagement partner"), reviewManager: noneOr("review manager") })
type TeamFormInput = z.input<typeof TeamFormSchema>

function send(input: TeamFormInput) {
  const clean = (v: string | null | undefined) => (v && v !== NONE ? v : null)
  const payload: ClientTeamInput = { ...input, engagementPartner: clean(input.engagementPartner), reviewManager: clean(input.reviewManager) }
  return setClientTeam(payload)
}

/**
 * Edit the client owner and engagement team (§5.3, §7.3.3 Team): engagement partner (a Partner),
 * review manager (a Partner or a Manager), preparers (anyone on the team). One save, one
 * transaction (set_client_team); refused if someone else changed the team meanwhile (§13).
 */
export function TeamEditButton({ clientId, clientName, signature, current, staff }: { clientId: string; clientName: string; signature: string; current: TeamPick; staff: StaffChoice[] }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const defaults: TeamFormInput = {
    clientId,
    signature,
    owner: current.owner ?? "",
    engagementPartner: current.engagementPartner ?? NONE,
    reviewManager: current.reviewManager ?? NONE,
    preparers: current.preparers,
  }
  const f = useActionForm(TeamFormSchema, send, {
    defaultValues: defaults,
    successMessage: (d) => (d.changes === 0 ? "Nothing changed." : "Team saved."),
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens with the team as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature])

  const label = (s: StaffChoice) => `${s.name}${s.designation ? ` · ${s.designation}` : ""}`
  const partners = staff.filter((s) => s.role === "partner")
  const reviewers = staff.filter((s) => s.role === "partner" || s.role === "manager")

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <PencilIcon aria-hidden="true" />
        Edit team
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Edit team"
        description={`Who looks after ${clientName}. Everyone here can open the client; Employees see only the clients they are on.`}
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Save team"
      >
        <div className="flex flex-col gap-4">
          <FormAlert state={f} />
          <ComboboxField
            control={f.control}
            name="owner"
            label="Client owner"
            required
            options={staff.map((s) => ({ value: s.id, label: label(s), description: ROLE_LABEL[s.role] }))}
            placeholder="Choose the owner"
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField
              control={f.control}
              name="engagementPartner"
              label="Engagement partner"
              helper="A Partner."
              options={[{ value: NONE, label: "None" }, ...partners.map((s) => ({ value: s.id, label: label(s) }))]}
            />
            <SelectField
              control={f.control}
              name="reviewManager"
              label="Review manager"
              helper="A Partner or a Manager."
              options={[{ value: NONE, label: "None" }, ...reviewers.map((s) => ({ value: s.id, label: label(s) }))]}
            />
          </div>
          <CheckboxGroupField
            control={f.control}
            name="preparers"
            label="Preparers"
            helper="The people who do the work on this client."
            options={staff.map((s) => ({ value: s.id, label: s.name, description: [ROLE_LABEL[s.role], s.designation].filter(Boolean).join(" · ") }))}
            columns={2}
          />
        </div>
      </FormDialog>
    </>
  )
}

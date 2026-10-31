"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useWatch } from "react-hook-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { todayIST } from "@/lib/domain/fy"
import { WHATSAPP_NUMBER_KIND_LABEL, contactWhatsAppDigits, type ContactLike, type NumberToAdd } from "@/lib/domain/whatsapp"
import { formatWhatsAppNumber } from "@/lib/domain/messaging"
import {
  AddMemberSchema,
  CloseGroupSchema,
  MarkCreatedSchema,
  StartGroupSchema,
  UpdateGroupSchema,
  type AddMemberInput,
  type CloseGroupInput,
  type MarkCreatedInput,
  type StartGroupInput,
  type UpdateGroupInput,
} from "@/lib/schemas/whatsapp"
import {
  addWhatsAppMember,
  closeWhatsAppGroup,
  markWhatsAppGroupCreated,
  saveWhatsAppInviteLink,
  startWhatsAppGroup,
  updateWhatsAppGroup,
} from "@/server/actions/whatsapp-groups"
import { MemberChip } from "@/components/whatsapp/member-chips"
import { z } from "zod"

export interface NumberOption {
  id: string
  label: string
  kind: string
  number: string | null
  is_active: boolean
}

// -------------------------------------------------------------------------------------------------
// Step 7: Mark the group created
// -------------------------------------------------------------------------------------------------

export function MarkCreatedDialog({
  open,
  onOpenChange,
  groupId,
  groupName,
  updatedAt,
  numbers,
  members,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  groupName: string
  updatedAt: string
  numbers: NumberOption[]
  /** The step 3 list: who fills in as members. */
  members: NumberToAdd[]
}) {
  const router = useRouter()
  const active = numbers.filter((n) => n.is_active && n.number)
  const fallback = active.find((n) => n.kind === "managers_office") ?? active[0]
  const f = useActionForm(MarkCreatedSchema, markWhatsAppGroupCreated, {
    defaultValues: { groupId, updatedAt, createdOn: todayIST(), createdByNumberId: fallback?.id ?? "", inviteLink: "" } satisfies MarkCreatedInput,
    onSuccess: (data) => {
      toast.success(`${groupName} is Active with ${data.members} ${data.members === 1 ? "member" : "members"}.`)
      onOpenChange(false)
      router.refresh()
    },
  })
  const creator = useWatch({ control: f.control, name: "createdByNumberId" })
  const shown = members.map((m) => (m.kind === "firm_number" && m.refId === creator ? { ...m, isAdmin: true } : m))
  const creatorMissing = !!creator && !members.some((m) => m.refId === creator)
  const creatorRow = active.find((n) => n.id === creator)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark the group created"
      description="The group becomes Active and its members fill in from the checklist."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Mark created"
      submitDisabled={active.length === 0}
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        {active.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
            None of the firm&apos;s WhatsApp numbers is switched on yet. A Partner adds them in Settings → WhatsApp.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DateField control={f.control} name="createdOn" label="Created on" required max={todayIST()} />
          <SelectField
            control={f.control}
            name="createdByNumberId"
            label="Created from"
            required
            options={active.map((n) => ({ value: n.id, label: `${n.label} (${WHATSAPP_NUMBER_KIND_LABEL[n.kind as keyof typeof WHATSAPP_NUMBER_KIND_LABEL] ?? n.kind})` }))}
            helper="WhatsApp makes the number that created the group an admin."
          />
        </div>
        <TextField
          control={f.control}
          name="inviteLink"
          label="Invite link"
          helper="Optional. WhatsApp → Group info → Invite via link. Only Partners and Managers see it."
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-text">
            Members <span className="num font-normal text-text-muted">({shown.length + (creatorMissing ? 1 : 0)})</span>
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((m) => (
              <li key={m.key}>
                <MemberChip member={{ id: m.key, kind: m.kind, firm_kind: m.firmKind, display_name: m.displayName, display: m.display, is_admin: m.isAdmin }} />
              </li>
            ))}
            {creatorMissing && creatorRow ? (
              <li>
                <MemberChip member={{ id: creatorRow.id, kind: "firm_number", firm_kind: creatorRow.kind, display_name: creatorRow.label, display: creatorRow.number ? formatWhatsAppNumber(creatorRow.number) : null, is_admin: true }} />
              </li>
            ) : null}
          </ul>
          <p className="text-sm text-text-muted">From step 3: the firm&apos;s numbers in every client group and the contacts ticked there.</p>
        </div>
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Close group
// -------------------------------------------------------------------------------------------------

export function CloseGroupDialog({
  open,
  onOpenChange,
  groupId,
  groupName,
  updatedAt,
  isPrimary,
  createdOn,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  groupName: string
  updatedAt: string
  isPrimary: boolean
  createdOn: string | null
}) {
  const router = useRouter()
  const f = useActionForm(CloseGroupSchema, closeWhatsAppGroup, {
    defaultValues: { groupId, updatedAt, closedOn: todayIST(), reason: "" } satisfies CloseGroupInput,
    onSuccess: (data) => {
      toast.success(data.promotedId ? `${groupName} is closed. The client's other open group is now primary.` : `${groupName} is closed.`)
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Close ${groupName}?`}
      description="Post a closing message in the group first (house rule 7). The group and its members stay here for history; a closed group can't be reopened."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Close group"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <DateField control={f.control} name="closedOn" label="Closing date" required min={createdOn ?? undefined} max={todayIST()} />
        <TextareaField control={f.control} name="reason" label="Reason" required rows={3} maxLength={500} helper="For example: Engagement ended after the FY 2025-26 audit." />
        {isPrimary ? <p className="text-sm text-text-muted">This is the client&apos;s primary group. If the client has another open group, it becomes primary.</p> : null}
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Edit name, purpose, notes
// -------------------------------------------------------------------------------------------------

export function EditGroupDialog({
  open,
  onOpenChange,
  groupId,
  updatedAt,
  name,
  purpose,
  notes,
  clientCode,
  status,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  updatedAt: string
  name: string
  purpose: string | null
  notes: string | null
  clientCode: string
  status: string
}) {
  const router = useRouter()
  const f = useActionForm(UpdateGroupSchema, updateWhatsAppGroup, {
    defaultValues: { groupId, updatedAt, name, purpose: purpose ?? "", notes: notes ?? "" } satisfies UpdateGroupInput,
    successMessage: "Group saved",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit group" onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty} submitLabel="Save group">
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <TextField
          control={f.control}
          name="name"
          label="Group name"
          required
          maxLength={100}
          helper={
            status === "to_create"
              ? `Keep the client code ${clientCode}: it makes the group findable in WhatsApp search.`
              : `Rename the group in WhatsApp to exactly this too, so the name Open chat copies finds it. Keep the client code ${clientCode}.`
          }
        />
        <TextField control={f.control} name="purpose" label="Purpose" maxLength={120} helper="For example: All work, or Statutory audit FY 2025-26." />
        <TextareaField control={f.control} name="notes" label="Notes" rows={3} maxLength={2000} />
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Add another group
// -------------------------------------------------------------------------------------------------

export function AddGroupDialog({
  open,
  onOpenChange,
  clientId,
  baseName,
  clientCode,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  /** The name the Settings format gives this client. */
  baseName: string
  clientCode: string
}) {
  const router = useRouter()
  const f = useActionForm(StartGroupSchema, startWhatsAppGroup, {
    defaultValues: { clientId, name: "", purpose: "" } satisfies StartGroupInput,
    onSuccess: (data) => {
      toast.success(`${data.name} added. Follow its setup checklist.`)
      onOpenChange(false)
      router.refresh()
    },
  })
  const purpose = useWatch({ control: f.control, name: "purpose" })
  const name = useWatch({ control: f.control, name: "name" })
  const suggest = () => {
    const p = (purpose ?? "").trim()
    f.form.setValue("name", p ? `${baseName} · ${p}`.slice(0, 100) : baseName, { shouldDirty: true, shouldValidate: false })
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add another group"
      description="For example a separate group for a statutory audit. The client's first open group stays primary."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Add group"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <TextField control={f.control} name="purpose" label="Purpose" required maxLength={120} helper="For example: Statutory audit FY 2025-26. It tells the two groups apart." />
        <TextField
          control={f.control}
          name="name"
          label="Group name"
          maxLength={100}
          helper={`Leave it empty to name it ${baseName} · <purpose>. A name you type must keep the client code ${clientCode}.`}
          labelAction={
            <button type="button" onClick={suggest} className="text-sm font-medium text-primary hover:underline">
              Name it from the purpose
            </button>
          }
        />
        {name && !name.toLowerCase().includes(clientCode.toLowerCase()) ? <p className="text-sm text-warning-text">The name must contain {clientCode}.</p> : null}
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Invite link
// -------------------------------------------------------------------------------------------------

const InviteFormSchema = z.object({
  groupId: z.string(),
  updatedAt: z.string(),
  inviteLink: MarkCreatedSchema.shape.inviteLink,
})

export function InviteLinkDialog({ open, onOpenChange, groupId, updatedAt, hasLink }: { open: boolean; onOpenChange: (open: boolean) => void; groupId: string; updatedAt: string; hasLink: boolean }) {
  const router = useRouter()
  const f = useActionForm(InviteFormSchema, saveWhatsAppInviteLink, {
    defaultValues: { groupId, updatedAt, inviteLink: "" },
    onSuccess: (data) => {
      toast.success(data.saved ? "Invite link saved" : "Invite link removed")
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={hasLink ? "Replace the invite link" : "Add the invite link"}
      description="WhatsApp → Group info → Invite via link. If the link was reset in WhatsApp, paste the new one."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save link"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <TextField
          control={f.control}
          name="inviteLink"
          label="Invite link"
          helper={hasLink ? "Leave it empty and save to remove the saved link." : "Starts https://chat.whatsapp.com/."}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Add a member by hand
// -------------------------------------------------------------------------------------------------

export function AddMemberDialog({
  open,
  onOpenChange,
  groupId,
  numbers,
  contacts,
  countryCode,
  memberNumbers,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  numbers: NumberOption[]
  contacts: ContactLike[]
  countryCode: string
  /** Numbers already in the group (normalised digits). */
  memberNumbers: string[]
}) {
  const router = useRouter()
  const inGroup = new Set(memberNumbers)
  const firmOptions = numbers
    .filter((n) => n.is_active && n.number)
    .map((n) => ({ value: n.id, label: n.label, disabled: inGroup.has(n.number!) }))
  const contactOptions = contacts.map((c) => {
    const digits = contactWhatsAppDigits(c, countryCode)
    return {
      value: c.id,
      label: `${c.name}${c.role ? ` (${c.role})` : ""}${digits ? "" : " · no WhatsApp number"}`,
      disabled: !digits || inGroup.has(digits),
    }
  })
  const f = useActionForm(AddMemberSchema, addWhatsAppMember, {
    defaultValues: { groupId, kind: "client_contact", firmNumberId: "", contactId: "", displayName: "", number: "", isAdmin: false, addedOn: todayIST() } satisfies AddMemberInput,
    successMessage: "Member added",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const kind = useWatch({ control: f.control, name: "kind" })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a member"
      description="Record someone who was added to the group in WhatsApp. No personal staff numbers (house rule 1)."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Add member"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <SelectField
          control={f.control}
          name="kind"
          label="Who"
          required
          options={[
            { value: "client_contact", label: "One of the client's contacts" },
            { value: "firm_number", label: "A firm number" },
            { value: "other_person", label: "Someone else (the client's auditor, a consultant)" },
          ]}
        />
        {kind === "firm_number" ? <SelectField control={f.control} name="firmNumberId" label="Firm number" required options={firmOptions} /> : null}
        {kind === "client_contact" ? (
          <SelectField control={f.control} name="contactId" label="Contact" required options={contactOptions} helper="Contacts without a WhatsApp number, or already in the group, can't be chosen." />
        ) : null}
        {kind === "other_person" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextField control={f.control} name="displayName" label="Name" required maxLength={200} />
            <TextField control={f.control} name="number" label="WhatsApp number" required inputMode="tel" autoComplete="off" helper="Like +91 98765 43210." />
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DateField control={f.control} name="addedOn" label="Added on" required max={todayIST()} />
          <SwitchField control={f.control} name="isAdmin" label="Group admin" description="Made an admin in WhatsApp." />
        </div>
      </div>
    </FormDialog>
  )
}

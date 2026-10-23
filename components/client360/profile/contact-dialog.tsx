"use client"

import * as React from "react"
import type { Control, FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { useRouter } from "next/navigation"
import { Checkbox } from "@/components/ui/checkbox"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { CheckboxGroupField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { CONTACT_ROLES, CreateContactSchema, UpdateContactSchema, emptyContact, type UpdateContactInput } from "@/lib/schemas/contacts"
import { createContact, updateContact } from "@/server/actions/contacts"
import type { ContactRow } from "@/lib/data/client360"

const ROLE_OPTIONS = CONTACT_ROLES.map((r) => ({ value: r, label: r }))
const HANDLE_OPTIONS = SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] }))

/**
 * Add or edit a contact (§7.3.3 Contacts): name*, role, email, phone, WhatsApp (with "same as
 * phone"), the services they handle (so reminders go to the right person, §7.13.2), notes, and, for
 * a new contact, whether they become the primary contact. Edits carry the row's updated_at (§13).
 */
export function ContactDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  contact,
  isFirst,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  clientName: string
  /** null = add a new contact. */
  contact: ContactRow | null
  /** No contacts yet: the new one becomes primary whatever is chosen. */
  isFirst: boolean
}) {
  return contact ? (
    <EditContact open={open} onOpenChange={onOpenChange} clientId={clientId} clientName={clientName} contact={contact} />
  ) : (
    <AddContact open={open} onOpenChange={onOpenChange} clientId={clientId} clientName={clientName} isFirst={isFirst} />
  )
}

/** "Same as phone" for WhatsApp: while ticked, the WhatsApp field follows the phone field. */
function useSameAsPhone<T extends FieldValues>(form: UseFormReturn<T, unknown, unknown>, initial: boolean) {
  const [same, setSame] = React.useState(initial)
  const phone = form.watch("phone" as FieldPath<T>)
  React.useEffect(() => {
    if (same) form.setValue("whatsapp" as FieldPath<T>, (typeof phone === "string" ? phone : "") as never, { shouldDirty: true })
  }, [same, phone, form])
  return [same, setSame] as const
}

function AddContact({ open, onOpenChange, clientId, clientName, isFirst }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; clientName: string; isFirst: boolean }) {
  const router = useRouter()
  const defaults = emptyContact(clientId, { isPrimary: isFirst })
  const f = useActionForm(CreateContactSchema, createContact, {
    defaultValues: defaults,
    successMessage: (d) => (d.isPrimary ? "Contact added as the primary contact." : "Contact added."),
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(emptyContact(clientId, { isPrimary: isFirst }))
    // Reset each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const [same, setSame] = useSameAsPhone(f.form, false)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add contact"
      description={`A person at ${clientName} the firm speaks to.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Add contact"
    >
      <ContactFields control={f.control} same={same} setSame={setSame}>
        <FormAlert state={f} />
      </ContactFields>
      <div className="mt-4">
        {isFirst ? (
          <p className="text-sm text-text-muted">The first contact is the primary contact.</p>
        ) : (
          <SwitchField control={f.control} name="isPrimary" label="Make this the primary contact" description="Reminders and the client's WhatsApp and email buttons use the primary contact unless a service has its own." />
        )}
      </div>
    </FormDialog>
  )
}

function EditContact({ open, onOpenChange, clientId, clientName, contact }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; clientName: string; contact: ContactRow }) {
  const router = useRouter()
  const defaults: UpdateContactInput = {
    id: contact.id,
    clientId,
    updatedAt: contact.updated_at,
    name: contact.name,
    role: (CONTACT_ROLES as readonly string[]).includes(contact.role ?? "") ? (contact.role as (typeof CONTACT_ROLES)[number]) : contact.role ? "Other" : "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    whatsapp: contact.whatsapp ?? "",
    handles: contact.handles,
    notes: contact.notes ?? "",
  }
  const f = useActionForm(UpdateContactSchema, updateContact, {
    defaultValues: defaults,
    successMessage: "Contact saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens with the contact as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact.updated_at])
  const [same, setSame] = useSameAsPhone(f.form, !!contact.phone && contact.phone === contact.whatsapp)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${contact.name}`}
      description={`Contact at ${clientName}.${contact.email_bounced ? " Their email bounced: check the address." : ""}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save contact"
    >
      <ContactFields control={f.control} same={same} setSame={setSame}>
        <FormAlert state={f} />
      </ContactFields>
    </FormDialog>
  )
}

/** The fields add and edit share; both forms use the same names. */
function ContactFields<T extends FieldValues>({ control, same, setSame, children }: { control: Control<T, unknown, unknown>; same: boolean; setSame: (v: boolean) => void; children?: React.ReactNode }) {
  const n = (name: string) => name as FieldPath<T>
  return (
    <div className="flex flex-col gap-4">
      {children}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={control} name={n("name")} label="Name" required maxLength={120} autoComplete="off" />
        <SelectField control={control} name={n("role")} label="Role" options={ROLE_OPTIONS} />
        <TextField control={control} name={n("email")} label="Email" type="email" autoComplete="off" />
        <TextField control={control} name={n("phone")} label="Phone" type="tel" inputMode="tel" helper="Mobile, or a landline with its STD code." />
        <div className="flex flex-col gap-1.5">
          <TextField control={control} name={n("whatsapp")} label="WhatsApp" type="tel" inputMode="tel" disabled={same} />
          <label className="flex items-center gap-2 text-sm text-text">
            <Checkbox checked={same} onCheckedChange={(v) => setSame(v === true)} />
            Same as phone
          </label>
        </div>
      </div>
      <CheckboxGroupField
        control={control}
        name={n("handles")}
        label="Handles"
        helper="The services this person answers for, so reminders go to the right person. Leave all unticked for a general contact."
        options={HANDLE_OPTIONS}
        columns={3}
      />
      <TextareaField control={control} name={n("notes")} label="Notes" rows={3} maxLength={1000} />
    </div>
  )
}

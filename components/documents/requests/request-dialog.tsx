"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, useFieldArray, type Control } from "react-hook-form"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { FieldShell } from "@/components/app/form/field-shell"
import { DateField, TextField, TextareaField } from "@/components/app/form/fields"
import { fieldDomId, useActionForm } from "@/hooks/use-action-form"
import { todayIST } from "@/lib/domain/fy"
import { formatWhatsAppNumber, normalizeWhatsAppNumber } from "@/lib/domain/messaging"
import {
  CreateDocumentRequestSchema,
  UpdateDocumentRequestSchema,
  REQUEST_LIMITS,
  type CreateDocumentRequestInput,
  type UpdateDocumentRequestInput,
} from "@/lib/schemas/document-requests"
import { createDocumentRequest, updateDocumentRequest } from "@/server/actions/document-requests"
import type { RequestContact } from "@/lib/data/document-requests"
import { RequestHandoff, type HandoffMessaging } from "@/components/documents/requests/request-handoff"

/**
 * Request documents from the client: a PBC list (§7.14). Title*, due date, items* (title*, help
 * text, required), notes, reminder every N days (default from Settings → Reminders), and who it
 * goes to. On save the client sees it in the portal at once, and the confirmation offers Send on
 * WhatsApp with the list and the portal link (nothing is emailed).
 */

/** Items the firm asks for most often, to add in one click (they are plain items; edit freely). */
const COMMON_ITEMS = [
  "Bank statements for the period",
  "Sales register",
  "Purchase register",
  "Purchase invoices above ₹50,000",
  "Form 16 / salary certificate",
  "Form 26AS and AIS",
  "Trial balance",
  "Fixed asset register",
  "Loan statements and interest certificates",
  "Rent agreement",
] as const

type Created = { id: string; portalLink: string; title: string; items: Array<{ title: string; is_required: boolean }>; dueDate: string | null; contactId: string | null }

/** " · +91 98450 12345", or " · no WhatsApp number": what the request's WhatsApp message goes to. */
function numberLabel(c: { whatsapp: string | null; phone: string | null }): string {
  const n = normalizeWhatsAppNumber(c.whatsapp) ?? normalizeWhatsAppNumber(c.phone)
  return n ? ` · ${formatWhatsAppNumber(n)}` : " · no WhatsApp number"
}

function ContactField({ control, contacts }: { control: Control<CreateDocumentRequestInput, unknown, unknown> | Control<UpdateDocumentRequestInput, unknown, unknown>; contacts: RequestContact[] }) {
  const { field, fieldState } = useController({ control: control as Control<CreateDocumentRequestInput, unknown, unknown>, name: "contactId" })
  const { ref: fieldRef, value: fieldValue, onChange, onBlur } = field
  const id = fieldDomId(control, "contactId")
  return (
    <FieldShell id={id} label="Send to" helper={contacts.length ? "The WhatsApp message goes to this contact." : "No contacts yet: it goes to the client's own number."} error={fieldState.error?.message ?? null}>
      {(aria) => (
        <NativeSelect {...aria} ref={fieldRef} className="w-full" value={(fieldValue as string | null | undefined) ?? ""} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}>
          <NativeSelectOption value="">{contacts.length ? "The primary contact" : "The client"}</NativeSelectOption>
          {contacts.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
              {c.role ? ` (${c.role})` : ""}
              {numberLabel(c)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </FieldShell>
  )
}

function ItemsEditor({ control, errors }: { control: Control<CreateDocumentRequestInput, unknown, unknown>; errors: Record<string, { title?: { message?: string } } | undefined> | undefined }) {
  const { fields, append, remove, move } = useFieldArray({ control, name: "items" })
  const { field: itemsField } = useController({ control, name: "items" })
  const { value: itemsValue, onChange: setItems } = itemsField
  const current = (itemsValue ?? []) as Array<{ title: string }>
  const used = new Set(current.map((i) => i.title.trim().toLowerCase()))
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-base font-medium text-text">
        Items<span className="text-danger-text"> *</span>
      </legend>
      <ol className="flex flex-col gap-3">
        {fields.map((f, i) => (
          <ItemRow key={f.id} control={control} index={i} count={fields.length} error={errors?.[i]?.title?.message} onRemove={() => remove(i)} onMove={(to) => move(i, to)} />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={fields.length >= REQUEST_LIMITS.items} onClick={() => append({ title: "", helpText: "", isRequired: true })}>
          <PlusIcon aria-hidden="true" />
          Add item
        </Button>
      </div>
      <div>
        <p className="text-sm text-text-muted">Often asked for:</p>
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {COMMON_ITEMS.filter((t) => !used.has(t.toLowerCase())).map((t) => (
            <li key={t}>
              <button
                type="button"
                disabled={fields.length >= REQUEST_LIMITS.items}
                onClick={() => {
                  const empty = current.findIndex((x) => !x.title.trim())
                  if (empty >= 0) setItems(current.map((x, j) => (j === empty ? { ...x, title: t } : x)))
                  else append({ title: t, helpText: "", isRequired: true })
                }}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface px-2.5 text-sm text-text transition-colors duration-150 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-9"
              >
                <PlusIcon aria-hidden="true" className="size-3.5 text-text-muted" />
                {t}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </fieldset>
  )
}

function ItemRow({
  control,
  index,
  count,
  error,
  onRemove,
  onMove,
}: {
  control: Control<CreateDocumentRequestInput, unknown, unknown>
  index: number
  count: number
  error?: string
  onRemove: () => void
  onMove: (to: number) => void
}) {
  const { field: titleField } = useController({ control, name: `items.${index}.title` })
  const { field: helpField } = useController({ control, name: `items.${index}.helpText` })
  const { field: reqField } = useController({ control, name: `items.${index}.isRequired` })
  const { ref: titleRef, value: titleValue, onChange: onTitle, onBlur: onTitleBlur } = titleField
  const { value: helpValue, onChange: onHelp, onBlur: onHelpBlur } = helpField
  const { value: reqValue, onChange: onReq } = reqField
  const titleId = fieldDomId(control, `items.${index}.title`)
  const helpId = fieldDomId(control, `items.${index}.helpText`)
  const reqId = fieldDomId(control, `items.${index}.isRequired`)
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-2">
        <span className="num mt-2 w-5 flex-none text-right text-sm text-text-muted tabular-nums" aria-hidden="true">
          {index + 1}.
        </span>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[1fr_1fr]">
          <div>
            <label htmlFor={titleId} className="sr-only">
              Item {index + 1} title
            </label>
            <Input
              id={titleId}
              ref={titleRef}
              value={(titleValue as string) ?? ""}
              onChange={onTitle}
              onBlur={onTitleBlur}
              placeholder="What you need, e.g. Bank statement Apr–Sep"
              maxLength={REQUEST_LIMITS.itemTitle}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${titleId}-err` : undefined}
            />
            {error ? (
              <p id={`${titleId}-err`} className="mt-1 text-sm text-danger-text">
                {error}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor={helpId} className="sr-only">
              Item {index + 1} help text
            </label>
            <Input
              id={helpId}
              value={(helpValue as string | null | undefined) ?? ""}
              onChange={onHelp}
              onBlur={onHelpBlur}
              placeholder="Help for the client (optional)"
              maxLength={REQUEST_LIMITS.helpText}
            />
          </div>
          <label htmlFor={reqId} className="flex cursor-pointer items-center gap-2 text-sm text-text md:col-span-2">
            <Checkbox id={reqId} checked={reqValue !== false} onCheckedChange={(v) => onReq(v === true)} />
            Required: the request completes only once this is accepted
          </label>
        </div>
        <div className="flex flex-none flex-col gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>
            <ArrowUpIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move item ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
            <ArrowDownIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove item ${index + 1}`} disabled={count === 1} onClick={onRemove}>
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  )
}

export function CreateRequestDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  clientCode,
  client,
  contacts,
  defaultEveryDays,
  messaging,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  clientName: string
  clientCode: string
  client: { phone: string | null; whatsapp: string | null; has_portal: boolean }
  contacts: RequestContact[]
  defaultEveryDays: number
  messaging: HandoffMessaging
}) {
  const router = useRouter()
  const [created, setCreated] = React.useState<Created | null>(null)
  const primary = contacts.find((c) => c.is_primary) ?? null
  const defaults = React.useMemo<CreateDocumentRequestInput>(
    () => ({ clientId, title: "", dueDate: "", items: [{ title: "", helpText: "", isRequired: true }], notes: "", reminderEveryDays: defaultEveryDays, contactId: primary?.id ?? "" }),
    [clientId, defaultEveryDays, primary?.id]
  )
  const f = useActionForm(CreateDocumentRequestSchema, createDocumentRequest, {
    defaultValues: defaults,
    onSuccess: (data, values) => {
      setCreated({
        id: data.id,
        portalLink: data.portalLink,
        title: values.title.trim(),
        items: (values.items ?? []).map((i) => ({ title: i.title.trim(), is_required: i.isRequired !== false })),
        dueDate: values.dueDate || null,
        contactId: values.contactId || primary?.id || null,
      })
      router.refresh()
    },
  })
  // The caller mounts this dialog when it opens, so every request starts fresh.

  if (created) {
    const contact = contacts.find((c) => c.id === created.contactId) ?? null
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="md"
        title="Request created"
        description={`${created.title} · ${created.items.length} ${created.items.length === 1 ? "item" : "items"}`}
        footer={
          <div className="ml-auto">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-base text-text">
            {client.has_portal
              ? `${clientName} can see it in the portal now, under Documents, and upload against each item.`
              : `${clientName} doesn't use the portal yet. The link below opens it once they're invited (Client 360 → Overview → Portal access).`}
          </p>
          <div>
            <p className="text-sm text-text-muted">Send it on WhatsApp now: the message lists what&apos;s needed, with the upload link.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <RequestHandoff
                clientId={clientId}
                clientName={clientName}
                clientCode={clientCode}
                client={client}
                recipient={contact ? { contactId: contact.id, name: contact.name, phone: contact.phone, whatsapp: contact.whatsapp } : null}
                request={{ id: created.id, title: created.title, due_date: created.dueDate }}
                items={created.items.map((i) => ({ ...i, status: "pending" as const }))}
                portalLink={created.portalLink}
                messaging={messaging}
                size="default"
              />
            </div>
          </div>
        </div>
      </FormDialog>
    )
  }

  const itemErrors = f.form.formState.errors.items as unknown as Record<string, { title?: { message?: string } } | undefined> | undefined
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Request documents"
      description={`A list of what you need from ${clientName}. They upload against each item in the portal.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Send request"
    >
      <FormAlert state={f} />
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={f.control} name="title" label="Title" required placeholder="Audit PBC FY 2026-27" className="md:col-span-2" maxLength={REQUEST_LIMITS.title} />
          <DateField control={f.control} name="dueDate" label="Due date" min={todayIST()} helper="Shown to the client; reminders mention it." />
          <TextField control={f.control} name="reminderEveryDays" label="Remind every (days)" type="number" inputMode="numeric" min={1} max={60} helper="Until nothing is pending." />
          <ContactField control={f.control} contacts={contacts} />
          <TextareaField control={f.control} name="notes" label="Notes for the client" rows={2} />
        </div>
        <ItemsEditor control={f.control} errors={itemErrors} />
        <p className="text-sm text-text-muted">After saving, send it on WhatsApp: the message lists the items and links to the portal.</p>
      </div>
    </FormDialog>
  )
}

export function EditRequestDialog({
  open,
  onOpenChange,
  clientId,
  contacts,
  request,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  contacts: RequestContact[]
  request: { id: string; title: string; due_date: string | null; notes: string | null; reminder_every_days: number; contact_id: string | null; updated_at: string }
}) {
  const router = useRouter()
  const defaults = React.useMemo<UpdateDocumentRequestInput>(
    () => ({
      id: request.id,
      clientId,
      updatedAt: request.updated_at,
      title: request.title,
      dueDate: request.due_date ?? "",
      notes: request.notes ?? "",
      reminderEveryDays: request.reminder_every_days,
      contactId: request.contact_id ?? "",
    }),
    [request, clientId]
  )
  const f = useActionForm(UpdateDocumentRequestSchema, updateDocumentRequest, {
    defaultValues: defaults,
    successMessage: "Request saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset to the request as it is now each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request.updated_at])
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit request" description="Items are edited on the request itself." onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty} submitLabel="Save request">
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="title" label="Title" required className="md:col-span-2" maxLength={REQUEST_LIMITS.title} />
        <DateField control={f.control} name="dueDate" label="Due date" />
        <TextField control={f.control} name="reminderEveryDays" label="Remind every (days)" type="number" inputMode="numeric" min={1} max={60} required />
        <ContactField control={f.control} contacts={contacts} />
        <TextareaField control={f.control} name="notes" label="Notes for the client" rows={2} />
      </div>
    </FormDialog>
  )
}

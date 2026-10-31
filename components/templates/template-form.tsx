"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, useWatch } from "react-hook-form"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { FieldShell } from "@/components/app/form/field-shell"
import { SwitchField, TextField } from "@/components/app/form/fields"
import { NativeSelectField } from "@/components/tasks/native-select-field"
import { fieldDomId, useActionForm } from "@/hooks/use-action-form"
import type { AppRole } from "@/lib/auth/roles"
import type { TemplateType } from "@/lib/domain/enums"
import type { TemplateValues, TemplateVariable } from "@/lib/domain/templates"
import {
  MessageTemplateSchema,
  TEMPLATE_BODY_MAX,
  TEMPLATE_CHANNELS,
  TEMPLATE_CHANNEL_LABELS,
  TEMPLATE_TYPE_HINTS,
  TEMPLATE_TYPE_LABELS,
  insertVariable,
  templateTypesFor,
  usedVariables,
  variableGroupsFor,
  type TemplateChannel,
} from "@/lib/schemas/message-templates"
import { saveMessageTemplate } from "@/server/actions/message-templates"
import { TemplatePreview } from "@/components/templates/template-preview"
import { VariablePicker } from "@/components/templates/variable-picker"

/**
 * The message template editor (§7.13.4): Name* · Type* · Channel (WhatsApp or Any; an old Email
 * template keeps its channel and subject) · Body*, with variables inserted from the picker at the
 * cursor, and a live preview with the sample client. The app sends no email.
 * Unknown variables are refused on save, naming the field and the variable (validateTemplate; the
 * database checks again). Edits carry the template's updated_at (§13).
 */

export type TemplateForEdit = {
  id: string
  name: string
  type: TemplateType
  channel: TemplateChannel
  subject: string | null
  body: string
  is_active: boolean
  updated_at: string
}

export type TemplateEditorContext = {
  role: AppRole
  values: TemplateValues
  /** The sender's WhatsApp signature format when they add one; null when they don't. */
  signature: string | null
  senderName: string
}

type Field = "subject" | "body"

export function TemplateDialog({
  open,
  onOpenChange,
  template,
  ctx,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  template?: TemplateForEdit | null
  ctx: TemplateEditorContext
}) {
  const router = useRouter()
  const f = useActionForm(MessageTemplateSchema, saveMessageTemplate, {
    defaultValues: {
      id: template?.id ?? "",
      expected_updated_at: template?.updated_at ?? null,
      name: template?.name ?? "",
      type: template?.type ?? "custom",
      channel: template?.channel ?? "any",
      subject: template?.subject ?? "",
      body: template?.body ?? "",
      is_active: template?.is_active ?? true,
    },
    successMessage: template ? "Template saved." : "Template added.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })

  const channel = (useWatch({ control: f.control, name: "channel" }) ?? "any") as TemplateChannel
  const type = (useWatch({ control: f.control, name: "type" }) ?? "custom") as TemplateType
  const subject = useWatch({ control: f.control, name: "subject" }) ?? ""
  const body = useWatch({ control: f.control, name: "body" }) ?? ""

  const bodyField = useController({ control: f.control, name: "body" })
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null)
  const lastFocus = React.useRef<Field>("body")
  const selection = React.useRef<Record<Field, { start: number; end: number } | null>>({ subject: null, body: null })

  function remember(field: Field, el: HTMLInputElement | HTMLTextAreaElement) {
    lastFocus.current = field
    selection.current[field] = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 }
  }

  const insert = (name: TemplateVariable) => {
    const target: Field = channel === "email" ? lastFocus.current : "body"
    const current = String(f.form.getValues(target) ?? "")
    const sel = selection.current[target]
    const next = insertVariable(current, name, sel?.start ?? current.length, sel?.end ?? current.length)
    f.form.setValue(target, next.text, { shouldDirty: true, shouldValidate: f.form.formState.isSubmitted })
    selection.current[target] = { start: next.cursor, end: next.cursor }
    requestAnimationFrame(() => {
      const el = target === "body" ? bodyRef.current : (document.getElementById(fieldDomId(f.control, "subject")) as HTMLInputElement | null)
      if (!el) return
      el.focus()
      el.setSelectionRange(next.cursor, next.cursor)
    })
  }

  const types = templateTypesFor(ctx.role)
  const used = usedVariables(body, channel === "email" ? subject : null)
  const bodyId = fieldDomId(f.control, "body")

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={template ? "Edit message template" : "New message template"}
      description="Variables are filled in for each client when the message is drafted. Nothing is sent from here."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={template ? "Save template" : "Add template"}
      footerStart={
        <span className="num tabular-nums">
          {body.length.toLocaleString("en-IN")} / {TEMPLATE_BODY_MAX.toLocaleString("en-IN")} characters
          {used.length ? ` · ${used.length} ${used.length === 1 ? "variable" : "variables"}` : ""}
        </span>
      }
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <TextField control={f.control} name="name" label="Name" required maxLength={120} placeholder="GSTR-3B data reminder (WhatsApp)" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NativeSelectField
              control={f.control}
              name="type"
              label="Type"
              required
              options={types.map((t) => ({ value: t, label: TEMPLATE_TYPE_LABELS[t] }))}
              helper={TEMPLATE_TYPE_HINTS[type]}
            />
            <NativeSelectField
              control={f.control}
              name="channel"
              label="Channel"
              options={TEMPLATE_CHANNELS.filter((c) => c !== "email" || template?.channel === "email").map((c) => ({ value: c, label: TEMPLATE_CHANNEL_LABELS[c] }))}
              helper={channel === "whatsapp" ? "Offered for WhatsApp drafts." : channel === "email" ? "The app sends no email: this is only offered for portal messages. Choose WhatsApp or Any." : "Offered for WhatsApp drafts and portal messages."}
            />
          </div>
          {channel === "email" ? (
            <TextField
              control={f.control}
              name="subject"
              label="Subject"
              maxLength={300}
              placeholder="{{firm_name}} | Documents pending for {{period}}"
              helper="Kept from when the app sent email; not used now."
              onFocus={(e) => remember("subject", e.currentTarget)}
              onSelect={(e) => remember("subject", e.currentTarget)}
              onKeyUp={(e) => remember("subject", e.currentTarget)}
              onClick={(e) => remember("subject", e.currentTarget)}
            />
          ) : null}
          <FieldShell
            id={bodyId}
            label="Message"
            required
            error={bodyField.fieldState.error?.message ?? null}
            helper="Write it as you'd say it. Line breaks are kept on WhatsApp and in the portal."
            labelAction={<VariablePicker groups={variableGroupsFor(ctx.role)} onPick={insert} />}
          >
            {(aria) => (
              <Textarea
                {...aria}
                ref={(el) => {
                  bodyRef.current = el
                  bodyField.field.ref(el)
                }}
                name={bodyField.field.name}
                value={(bodyField.field.value as string | undefined) ?? ""}
                onChange={(e) => {
                  bodyField.field.onChange(e)
                  remember("body", e.currentTarget)
                }}
                onBlur={bodyField.field.onBlur}
                onFocus={(e) => remember("body", e.currentTarget)}
                onSelect={(e) => remember("body", e.currentTarget)}
                onKeyUp={(e) => remember("body", e.currentTarget)}
                onClick={(e) => remember("body", e.currentTarget)}
                rows={12}
                maxLength={TEMPLATE_BODY_MAX}
                className="min-h-56 font-normal"
                placeholder="Hi {{contact_name}}, for your {{service_type}} for {{period}} we still need: {{missing_items}}"
              />
            )}
          </FieldShell>
          <SwitchField control={f.control} name="is_active" label="Active" description="Inactive templates stay listed here but aren't offered when drafting." />
        </div>
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <TemplatePreview channel={channel} subject={subject} body={body} values={ctx.values} signature={ctx.signature} senderName={ctx.senderName} />
        </div>
      </div>
    </FormDialog>
  )
}

/** "New template" for the page header. */
export function NewTemplateButton({ ctx }: { ctx: TemplateEditorContext }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        New template
      </Button>
      {open ? <TemplateDialog open={open} onOpenChange={setOpen} ctx={ctx} /> : null}
    </>
  )
}

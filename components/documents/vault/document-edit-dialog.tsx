"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useController, type Control } from "react-hook-form"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { FieldShell } from "@/components/app/form/field-shell"
import { fieldDomId } from "@/hooks/use-action-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, SwitchField, TagField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { CATEGORY_OPTIONS, UpdateDocumentSchema, type UpdateDocumentInput } from "@/lib/schemas/documents"
import { updateDocument } from "@/server/actions/documents"
import type { VaultRow } from "@/lib/data/documents"

/**
 * Edit a document's description (§7.14): title, category, FY, period, description, tags, expiry and
 * renewal dates. Partners and Managers also decide confidentiality, sharing with the client and the
 * retention date (never earlier than the rules give; the server checks, §6.8). Carries the row's
 * updated_at (§13).
 */
export function DocumentEditDialog({
  open,
  onOpenChange,
  clientId,
  doc,
  canManage,
  fyOptions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  doc: VaultRow
  canManage: boolean
  fyOptions: string[]
}) {
  const router = useRouter()
  const defaults = React.useMemo<UpdateDocumentInput>(
    () => ({
      id: doc.id,
      clientId,
      updatedAt: doc.updated_at,
      title: doc.title,
      category: doc.category,
      financialYear: doc.financial_year ?? "",
      period: doc.period ?? "",
      description: doc.description ?? "",
      tags: doc.tags,
      expiryDate: doc.expiry_date ?? "",
      renewalDate: doc.renewal_date ?? "",
      isConfidential: doc.is_confidential,
      shareableWithClient: doc.shareable_with_client,
      retentionUntil: doc.retention_until ?? "",
    }),
    [doc, clientId]
  )
  const f = useActionForm(UpdateDocumentSchema, updateDocument, {
    defaultValues: defaults,
    successMessage: "Document saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset to the document as it is now each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc.updated_at])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit document"
      description={doc.file_name}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save document"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="title" label="Title" required className="md:col-span-2" maxLength={200} />
        <SelectField control={f.control} name="category" label="Category" options={CATEGORY_OPTIONS} required />
        <FyField control={f.control} fyOptions={fyOptions} current={doc.financial_year} />
        <TextField control={f.control} name="period" label="Period" placeholder="Sep 2026, Q2" maxLength={40} />
        <TagField control={f.control} name="tags" label="Tags" />
        <TextareaField control={f.control} name="description" label="Description" className="md:col-span-2" rows={3} />
        <DateField control={f.control} name="expiryDate" label="Expires on" helper="A reminder goes before it expires." />
        <DateField control={f.control} name="renewalDate" label="Renew by" />
      </div>
      {canManage ? (
        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
          <SwitchField
            control={f.control}
            name="isConfidential"
            label="Confidential"
            description="Only Partners, Managers and this client's own team can open it. It can't be shared with the client."
          />
          <SwitchField control={f.control} name="shareableWithClient" label="Share with the client" description="The client sees it under Documents in the portal and can download it." />
          <DateField control={f.control} name="retentionUntil" label="Keep until" required helper="The retention rules set the earliest date. It can't be purged before then." />
        </div>
      ) : (
        <p className="mt-4 text-sm text-text-muted">Confidentiality, sharing with the client and the retention date are set by a Manager or a Partner.</p>
      )}
    </FormDialog>
  )
}

/** The FY as a native select (an empty choice means "not for one FY", which a Radix select can't hold). */
function FyField({ control, fyOptions, current }: { control: Control<UpdateDocumentInput, unknown, unknown>; fyOptions: string[]; current: string | null }) {
  const { field, fieldState } = useController({ control, name: "financialYear" })
  const id = fieldDomId(control, "financialYear")
  const options = current && !fyOptions.includes(current) ? [current, ...fyOptions] : fyOptions
  return (
    <FieldShell id={id} label="Financial year" error={fieldState.error?.message ?? null}>
      {(aria) => (
        <NativeSelect {...aria} ref={field.ref} className="w-full" value={(field.value as string | null | undefined) ?? ""} onChange={(e) => field.onChange(e.target.value)} onBlur={field.onBlur}>
          <NativeSelectOption value="">Not for one FY</NativeSelectOption>
          {options.map((fy) => (
            <NativeSelectOption key={fy} value={fy}>
              FY {fy}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </FieldShell>
  )
}

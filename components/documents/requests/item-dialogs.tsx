"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SwitchField, TextField } from "@/components/app/form/fields"
import { useActionForm, type FormError } from "@/hooks/use-action-form"
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/domain/enums"
import { formatDate } from "@/lib/format"
import { AddRequestItemSchema, REQUEST_LIMITS, UpdateRequestItemSchema, type AddRequestItemInput, type UpdateRequestItemInput } from "@/lib/schemas/document-requests"
import { addRequestItem, reviewRequestItem, updateRequestItem } from "@/server/actions/document-requests"
import type { DocumentOption } from "@/lib/data/documents"
import type { RequestItemRow } from "@/lib/data/document-requests"

/**
 * The dialogs for one request item (§7.14): send it back with a reason (the client is told in the
 * portal; tell them on WhatsApp from the request too), accept it with a document already in the vault,
 * add an item, edit an item.
 */

export function RejectItemDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  requestId,
  item,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  clientName: string
  requestId: string
  item: RequestItemRow
}) {
  const router = useRouter()
  const [reason, setReason] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const id = React.useId()
  // Mounted when it opens (RequestCard), so it always starts empty.

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      setFieldError("Say why it's rejected, so the client knows what to send instead.")
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await reviewRequestItem({ id: item.id, requestId, clientId, decision: "reject", reason: reason.trim(), updatedAt: item.updated_at })
      if (!r.ok) {
        if (r.fieldErrors?.reason?.[0]) setFieldError(r.fieldErrors.reason[0])
        setError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`${item.title} sent back. ${clientName} sees why in the portal; to tell them now, use Remind on WhatsApp on the request.`)
      onOpenChange(false)
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Send back: ${item.title}`}
      description="The client sees the reason in the portal and can upload it again."
      onSubmit={submit}
      pending={pending}
      dirty={reason.trim().length > 0}
      submitLabel="Send back"
    >
      <FormAlert error={error} />
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor={id} className="mb-1.5 block text-base font-medium text-text">
            Reason<span className="text-danger-text"> *</span>
          </label>
          <Textarea
            id={id}
            rows={3}
            value={reason}
            maxLength={REQUEST_LIMITS.reason}
            placeholder="Pages 3 to 5 are missing; please upload the full statement."
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-err` : undefined}
            onChange={(e) => {
              setReason(e.target.value)
              setFieldError(null)
            }}
          />
          {fieldError ? (
            <p id={`${id}-err`} className="mt-1 text-sm text-danger-text">
              {fieldError}
            </p>
          ) : null}
        </div>
        <p className="text-sm text-text-muted">To tell them now as well, use Remind on WhatsApp on the request: the message lists what is still outstanding, with the upload link.</p>
      </div>
    </FormDialog>
  )
}

export function LinkFromVaultDialog({
  open,
  onOpenChange,
  clientId,
  requestId,
  item,
  documents,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  requestId: string
  item: RequestItemRow
  documents: DocumentOption[]
}) {
  const router = useRouter()
  const [documentId, setDocumentId] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<FormError | null>(null)
  const id = React.useId()
  // Mounted when it opens (RequestCard), so it always starts empty.

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!documentId) {
      setError({ message: "Choose the document that answers this item.", client: true })
      return
    }
    setPending(true)
    try {
      const r = await reviewRequestItem({ id: item.id, requestId, clientId, decision: "accept", documentId, updatedAt: item.updated_at })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(r.data.requestStatus === "completed" ? `${item.title} accepted. The request is complete.` : `${item.title} accepted.`)
      onOpenChange(false)
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Accept with a vault document: ${item.title}`}
      description="When the client sent it another way and it is already in the vault."
      onSubmit={submit}
      pending={pending}
      submitDisabled={documents.length === 0}
      submitLabel="Accept item"
    >
      <FormAlert error={error} />
      {documents.length === 0 ? (
        <p className="text-base text-text-muted">This client’s vault has no documents yet. Upload the file for the client instead.</p>
      ) : (
        <div>
          <label htmlFor={id} className="mb-1.5 block text-base font-medium text-text">
            Document<span className="text-danger-text"> *</span>
          </label>
          <NativeSelect id={id} className="w-full" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
            <NativeSelectOption value="">Choose a document</NativeSelectOption>
            {documents.map((d) => (
              <NativeSelectOption key={d.id} value={d.id}>
                {d.title} · {DOCUMENT_CATEGORY_LABELS[d.category]}
                {d.financial_year ? ` · FY ${d.financial_year}` : ""} · {formatDate(d.created_at)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="mt-1 text-sm text-text-muted">The {documents.length === 200 ? "200 most recent" : documents.length} documents of this client, newest first.</p>
        </div>
      )}
    </FormDialog>
  )
}

export function AddItemDialog({ open, onOpenChange, clientId, requestId }: { open: boolean; onOpenChange: (open: boolean) => void; clientId: string; requestId: string }) {
  const router = useRouter()
  const defaults: AddRequestItemInput = { requestId, clientId, title: "", helpText: "", isRequired: true }
  const f = useActionForm(AddRequestItemSchema, addRequestItem, {
    defaultValues: defaults,
    successMessage: "Item added. The client sees it in the portal.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} size="sm" title="Add an item" onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty} submitLabel="Add item">
      <FormAlert state={f} />
      <div className="flex flex-col gap-4">
        <TextField control={f.control} name="title" label="What you need" required maxLength={REQUEST_LIMITS.itemTitle} />
        <TextField control={f.control} name="helpText" label="Help for the client" maxLength={REQUEST_LIMITS.helpText} />
        <SwitchField control={f.control} name="isRequired" label="Required" description="The request completes only once every required item is accepted." />
      </div>
    </FormDialog>
  )
}

export function EditItemDialog({ open, onOpenChange, clientId, requestId, item }: { open: boolean; onOpenChange: (open: boolean) => void; clientId: string; requestId: string; item: RequestItemRow }) {
  const router = useRouter()
  const defaults: UpdateRequestItemInput = { id: item.id, requestId, clientId, updatedAt: item.updated_at, title: item.title, helpText: item.help_text ?? "", isRequired: item.is_required }
  const f = useActionForm(UpdateRequestItemSchema, updateRequestItem, {
    defaultValues: defaults,
    successMessage: "Item saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.updated_at])
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} size="sm" title="Edit item" onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty} submitLabel="Save item">
      <FormAlert state={f} />
      <div className="flex flex-col gap-4">
        <TextField control={f.control} name="title" label="What you need" required maxLength={REQUEST_LIMITS.itemTitle} />
        <TextField control={f.control} name="helpText" label="Help for the client" maxLength={REQUEST_LIMITS.helpText} />
        <SwitchField control={f.control} name="isRequired" label="Required" description="The request completes only once every required item is accepted." />
      </div>
    </FormDialog>
  )
}

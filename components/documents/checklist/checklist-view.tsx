"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FileUpIcon, LinkIcon, ListChecksIcon, PlusIcon, Trash2Icon, Unlink2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/domain/enums"
import { formatDate } from "@/lib/format"
import type { ChecklistRow, DocumentOption } from "@/lib/data/documents"
import { addChecklistItem, linkChecklistDocument, removeChecklistItem, setChecklistCollected } from "@/server/actions/checklist"
import { documentsHref } from "@/components/documents/doc-urls"
import { useVaultActions } from "@/components/documents/vault/vault-actions"

/**
 * Client 360 → Documents → Checklist (§7.3.2 step 4, §7.14): the documents collected at onboarding
 * and since. Anyone on the client ticks an item collected and links it to the file in the vault (or
 * uploads it from here); Partners and Managers add and remove items. "Collected by Anita on 22 Oct"
 * is stamped by the database.
 */

type Result = { ok: boolean; error?: string; ref?: string; warnings?: string[] }

function useRunner() {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<Result>, success?: string): Promise<boolean> => {
    setBusy(key)
    try {
      const r = await fn()
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : (r.error ?? "That didn't work."))
        return false
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      if (success) toast.success(success)
      router.refresh()
      return true
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

function LinkPicker({ item, clientId, documents, disabled, onDone }: { item: ChecklistRow; clientId: string; documents: DocumentOption[]; disabled: boolean; onDone: (ok: boolean) => void }) {
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const id = React.useId()
  const save = async () => {
    if (!value) return
    setPending(true)
    try {
      const r = await linkChecklistDocument({ id: item.id, clientId, documentId: value, updatedAt: item.updated_at })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        onDone(false)
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`${item.label} linked and ticked collected.`)
      setOpen(false)
      onDone(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled || documents.length === 0} title={documents.length === 0 ? "The vault has no documents yet." : undefined}>
          <LinkIcon aria-hidden="true" />
          Link
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,24rem)]">
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text">
          The document in the vault for “{item.label}”
        </label>
        <NativeSelect id={id} className="w-full" value={value} onChange={(e) => setValue(e.target.value)}>
          <NativeSelectOption value="">Choose a document</NativeSelectOption>
          {documents.map((d) => (
            <NativeSelectOption key={d.id} value={d.id}>
              {d.title} · {DOCUMENT_CATEGORY_LABELS[d.category]}
              {d.financial_year ? ` · FY ${d.financial_year}` : ""}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!value || pending} onClick={() => void save()}>
            {pending ? <Spinner /> : null}
            Link document
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AddItemForm({ clientId }: { clientId: string }) {
  const router = useRouter()
  const [label, setLabel] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const id = React.useId()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) {
      setError("Name the document to collect.")
      return
    }
    setPending(true)
    try {
      const r = await addChecklistItem({ clientId, label: label.trim(), isRequired: true })
      if (!r.ok) {
        setError(r.fieldErrors?.label?.[0] ?? (r.ref ? `${r.error} (Ref ${r.ref})` : r.error))
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      setLabel("")
      setError(null)
      router.refresh()
    } finally {
      setPending(false)
    }
  }
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-1 border-t border-border px-4 py-3 md:px-5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        Add an item
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={label}
          maxLength={200}
          placeholder="Partnership deed"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            setLabel(e.target.value)
            setError(null)
          }}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? <Spinner /> : <PlusIcon aria-hidden="true" />}
          Add
        </Button>
      </div>
      {error ? (
        <p id={`${id}-err`} className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function ChecklistView({ clientId, clientName, rows, documents, canManage }: { clientId: string; clientName: string; rows: ChecklistRow[]; documents: DocumentOption[]; canManage: boolean }) {
  const { busy, run } = useRunner()
  const { openUpload } = useVaultActions()
  const [removing, setRemoving] = React.useState<ChecklistRow | null>(null)
  const collected = rows.filter((r) => r.collected).length
  const requiredOpen = rows.filter((r) => r.is_required && !r.collected).length

  const uploadFor = (item: ChecklistRow) =>
    openUpload({
      title: item.label,
      onUploaded: (ids) => {
        if (ids[0]) void run(`link:${item.id}`, () => linkChecklistDocument({ id: item.id, clientId, documentId: ids[0], updatedAt: item.updated_at }), `${item.label} uploaded and ticked collected.`)
      },
    })

  return (
    <section aria-labelledby="checklist-title" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
        <div>
          <h2 id="checklist-title" className="text-md leading-6 font-semibold text-text">
            Document checklist
          </h2>
          <p className="text-sm text-text-muted">
            {rows.length === 0
              ? "What the firm collects from this client."
              : `${collected} of ${rows.length} collected${requiredOpen ? ` · ${requiredOpen} required still to collect` : " · everything required is in"}`}
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState
            size="compact"
            icon={<ListChecksIcon />}
            message={canManage ? `No checklist for ${clientName}. Add the documents you collect from them.` : "No checklist yet. A Manager or Partner adds items."}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {rows.map((item) => {
            const checkboxId = `chk-${item.id}`
            return (
              <li key={item.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between md:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <Checkbox
                    id={checkboxId}
                    checked={item.collected}
                    disabled={busy !== null}
                    className="mt-0.5"
                    onCheckedChange={(v) =>
                      void run(`tick:${item.id}`, () => setChecklistCollected({ id: item.id, clientId, collected: v === true, updatedAt: item.updated_at }))
                    }
                  />
                  <div className="min-w-0">
                    <label htmlFor={checkboxId} className={cn("cursor-pointer text-base", item.collected ? "text-text" : "font-medium text-text")}>
                      {item.label}
                    </label>
                    {item.is_required ? null : <span className="ml-2 text-sm text-text-muted">Optional</span>}
                    <p className="text-sm text-text-muted">
                      {item.collected
                        ? `Collected${item.collected_by_name ? ` by ${item.collected_by_name}` : ""}${item.collected_at ? ` on ${formatDate(item.collected_at)}` : ""}`
                        : item.is_required
                          ? "Not collected yet"
                          : "Not collected"}
                      {item.document_id && item.document_title ? (
                        <>
                          {" · "}
                          <Link href={documentsHref(clientId, { docs: "vault", doc: item.document_id })} className="font-medium text-primary hover:underline" scroll={false}>
                            {item.document_title}
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                </div>
                <div className="flex flex-none flex-wrap items-center gap-1 pl-7 sm:pl-0">
                  {item.document_id ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void run(`unlink:${item.id}`, () => linkChecklistDocument({ id: item.id, clientId, documentId: null, updatedAt: item.updated_at }), "Document unlinked.")}
                    >
                      <Unlink2Icon aria-hidden="true" />
                      Unlink
                    </Button>
                  ) : (
                    <>
                      <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => uploadFor(item)}>
                        <FileUpIcon aria-hidden="true" />
                        Upload
                      </Button>
                      <LinkPicker item={item} clientId={clientId} documents={documents} disabled={busy !== null} onDone={() => undefined} />
                    </>
                  )}
                  {canManage ? (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${item.label}`} disabled={busy !== null} onClick={() => setRemoving(item)}>
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {canManage ? <AddItemForm clientId={clientId} /> : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Remove “${removing.label}” from the checklist?` : "Remove item?"}
        description="It leaves this client's checklist. A linked document stays in the vault."
        confirmLabel="Remove item"
        destructive
        onConfirm={async () => {
          if (!removing) return
          const ok = await run(`remove:${removing.id}`, () => removeChecklistItem({ id: removing.id, clientId }), "Item removed from the checklist.")
          if (!ok) return false
          setRemoving(null)
        }}
      />
    </section>
  )
}

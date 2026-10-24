"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { XIcon } from "lucide-react"
import { toast } from "sonner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { FieldShell } from "@/components/app/form/field-shell"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { UploadDropzone, UploadFileList, useDocumentUpload } from "@/components/documents/uploader"
import type { FormError } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { attachEvidence, searchEvidenceDocs } from "@/server/actions/audits"

/**
 * Working papers for one checklist step (§6.9 "Working papers are uploaded to the vault and tagged
 * to the step"; §7.15.5 evidence uploads). Upload new files into the client's vault (the documents
 * uploader: type, size and duplicate checks, category Audit, the engagement's FY), or tag documents
 * already in the vault. On an archived file whatever is added goes in as an amendment, with a note
 * saying what it is and why it is added now (SA 230).
 */
export function EvidenceDialog({
  onClose,
  engagementId,
  clientId,
  financialYear,
  step,
  amendment,
}: {
  onClose: () => void
  engagementId: string
  clientId: string
  financialYear: string
  step: { key: string; title: string }
  amendment: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = React.useState<"upload" | "vault">("upload")
  const [picked, setPicked] = React.useState<ComboOption[]>([])
  const [note, setNote] = React.useState("")
  const [noteError, setNoteError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [formError, setFormError] = React.useState<FormError | null>(null)
  const up = useDocumentUpload({ clientId, purpose: "new_document", defaults: { category: "audit", financialYear, tags: ["audit file"] } })

  const loadDocs = React.useCallback(async (q: string): Promise<ComboOption[]> => {
    const r = await searchEvidenceDocs({ clientId, q })
    return r.ok ? r.data : []
  }, [clientId])

  const ready = mode === "upload" ? up.canStart || up.counts.done > 0 : picked.length > 0
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (amendment && note.trim().length < 5) {
      setNoteError("Say what this is and why it is added after archive.")
      return
    }
    setNoteError(null)
    setPending(true)
    try {
      let ids: string[]
      if (mode === "upload") {
        const done = await up.start()
        ids = done.map((d) => d.documentId)
        if (!ids.length) {
          setFormError({ message: up.formError?.message ?? "No file was saved. Check the files listed and try again.", ref: up.formError?.ref })
          return
        }
      } else {
        ids = picked.map((p) => p.value)
      }
      const r = await attachEvidence({ id: engagementId, step: step.key, documentIds: ids, note: note.trim() || null })
      if (!r.ok) {
        setFormError({ message: r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(r.data.amendment ? "Added as an amendment to the archived file" : `${r.data.added} working ${r.data.added === 1 ? "paper" : "papers"} added`)
      onClose()
      router.refresh()
    } catch {
      setFormError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const footer = (
    <div className="ml-auto flex items-center gap-2">
      <Button type="button" variant="outline" onClick={onClose} disabled={pending || up.busy}>
        Cancel
      </Button>
      <Button type="submit" disabled={!ready || pending || up.busy} aria-busy={pending}>
        {pending ? <Spinner /> : null}
        {amendment ? "Add as amendment" : mode === "upload" ? "Upload and add" : "Add to the step"}
      </Button>
    </div>
  )

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="lg"
      title={amendment ? "Add an amendment to the archived file" : "Add working papers"}
      description={`For "${step.title}". They go into the client's vault and are tagged to this step.`}
      onSubmit={(e) => void submit(e)}
      pending={pending || up.busy}
      dirty={up.rows.length > 0 || picked.length > 0 || note.trim().length > 0}
      footer={footer}
    >
      <FormAlert error={formError ?? up.formError} />
      <div role="radiogroup" aria-label="Where the working papers come from" className="mb-4 inline-flex rounded-md border border-border bg-surface-2 p-0.5">
        {(
          [
            { id: "upload", label: "Upload files" },
            { id: "vault", label: "From the vault" },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              "h-8 rounded-[5px] px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
              mode === m.id ? "bg-surface font-medium text-text shadow-1" : "text-text-muted hover:text-text"
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "upload" ? (
        <div className="flex flex-col gap-3">
          <UploadDropzone onFiles={up.addFiles} multiple disabled={up.busy || pending} label="Drop working papers here" />
          <UploadFileList upload={up} fields="none" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <FieldShell id="evidence-pick" label="Documents in the client's vault" helper="Audit and KYC documents are listed first.">
            {(aria) => (
              <Combobox
                {...aria}
                id="evidence-pick"
                value={null}
                onChange={(_, option) => {
                  if (option && !picked.some((p) => p.value === option.value)) setPicked((p) => [...p, option])
                }}
                loadOptions={loadDocs}
                placeholder="Search by title or file name"
                searchPlaceholder="Title or file name"
                emptyText="No document matches."
                clearable={false}
              />
            )}
          </FieldShell>
          {picked.length ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label="Chosen documents">
              {picked.map((p) => (
                <li key={p.value} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-base text-text">{p.label}</span>
                    {p.description ? <span className="block truncate text-xs text-text-muted">{p.description}</span> : null}
                  </span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${p.label}`} onClick={() => setPicked((x) => x.filter((y) => y.value !== p.value))}>
                    <XIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <div className="mt-4">
        <FieldShell id="evidence-note" label={amendment ? "What this is and why it is added now" : "Note"} required={amendment} error={noteError}>
          {(aria) => <Textarea {...aria} id="evidence-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />}
        </FieldShell>
      </div>
    </FormDialog>
  )
}

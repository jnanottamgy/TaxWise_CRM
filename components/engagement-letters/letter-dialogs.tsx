"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CircleCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { todayIST, istDateOf } from "@/lib/domain/fy"
import { DeclineLetterSchema, IssueLetterSchema, SignLetterSchema } from "@/lib/schemas/engagement-letters"
import { attachSignedCopy, declineLetter, issueLetter, signLetter } from "@/server/actions/engagement-letters"
import { DocumentUploader } from "@/components/documents/uploader"
import { toastResult } from "@/components/registers/shared"

export type DialogLetter = { id: string; updatedAt: string; clientId: string; clientName: string; financialYear: string; issuedAt: string | null }

/** Issue a draft on a date (not in the future), without sending it (handed over in person, or sent later). */
export function IssueLetterDialog({ open, onOpenChange, letter }: { open: boolean; onOpenChange: (o: boolean) => void; letter: DialogLetter }) {
  const router = useRouter()
  const f = useActionForm(IssueLetterSchema, issueLetter, {
    defaultValues: { id: letter.id, updatedAt: letter.updatedAt, issuedOn: todayIST() },
    successMessage: "Letter issued",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} size="sm" title="Issue the letter" description="Once issued, what the client signs is fixed. To send it for signature on WhatsApp, use Issue and send instead." onSubmit={f.onSubmit} pending={f.pending} submitLabel="Issue letter">
      <FormAlert state={f} />
      <DateField control={f.control} name="issuedOn" label="Issued on" required max={todayIST()} />
    </FormDialog>
  )
}

function SignedCopyUploader({ letter, onUploaded, documentTitle }: { letter: DialogLetter; onUploaded: (id: string | null) => void; documentTitle: string }) {
  return (
    <DocumentUploader
      clientId={letter.clientId}
      purpose="new_document"
      single
      defaults={{ title: documentTitle, category: "engagement", financialYear: letter.financialYear }}
      buttonLabel="Upload signed copy"
      dropzoneLabel="Drop the signed letter here (PDF or a scan)"
      onUploaded={(done) => onUploaded(done[0]?.documentId ?? null)}
    />
  )
}

/** Mark an issued letter signed on a date, with the signed copy uploaded into the client's vault. */
export function SignLetterDialog({ open, onOpenChange, letter }: { open: boolean; onOpenChange: (o: boolean) => void; letter: DialogLetter }) {
  const router = useRouter()
  const [documentId, setDocumentId] = React.useState<string | null>(null)
  const f = useActionForm(SignLetterSchema, signLetter, {
    defaultValues: { id: letter.id, updatedAt: letter.updatedAt, signedOn: todayIST(), documentId: "" },
    successMessage: "Marked signed",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record the client's signature"
      description={`${letter.clientName} · FY ${letter.financialYear}`}
      onSubmit={(e) => {
        f.form.setValue("documentId", documentId ?? "")
        return f.onSubmit(e)
      }}
      pending={f.pending}
      submitLabel="Mark signed"
      footerStart={documentId ? <span className="inline-flex items-center gap-1.5 text-success-text"><CircleCheckIcon aria-hidden="true" className="size-4" />Signed copy uploaded</span> : "The signed copy can also be added later."}
    >
      <FormAlert state={f} />
      <DateField control={f.control} name="signedOn" label="Signed on" required max={todayIST()} min={letter.issuedAt ? istDateOf(letter.issuedAt) : undefined} />
      <div className="mt-4">
        <p className="mb-2 text-sm font-medium text-text">Signed copy</p>
        <SignedCopyUploader letter={letter} onUploaded={setDocumentId} documentTitle={`Signed engagement letter FY ${letter.financialYear}`} />
      </div>
    </FormDialog>
  )
}

/** Upload the signed copy of a letter already marked signed (or issued). */
export function AttachCopyDialog({ open, onOpenChange, letter }: { open: boolean; onOpenChange: (o: boolean) => void; letter: DialogLetter }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Upload the signed copy" description="It is filed in the client's document vault under Engagement and linked to this letter."
      pending={pending}
      footer={
        <div className="ml-auto">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Close
          </Button>
        </div>
      }
    >
      {error ? <FormAlert error={error} /> : null}
      <SignedCopyUploader
        letter={letter}
        documentTitle={`Signed engagement letter FY ${letter.financialYear}`}
        onUploaded={async (id) => {
          if (!id) return
          setPending(true)
          try {
            const r = await attachSignedCopy({ id: letter.id, updatedAt: letter.updatedAt, documentId: id })
            if (!r.ok) return setError({ message: r.error, ref: r.ref })
            toastResult(r, "Signed copy filed with the letter")
            onOpenChange(false)
            router.refresh()
          } catch {
            setError({ message: "We couldn't reach the server. Check your connection and try again." })
          } finally {
            setPending(false)
          }
        }}
      />
    </FormDialog>
  )
}

/** Mark an issued letter declined, with the client's reason. */
export function DeclineLetterDialog({ open, onOpenChange, letter }: { open: boolean; onOpenChange: (o: boolean) => void; letter: DialogLetter }) {
  const router = useRouter()
  const f = useActionForm(DeclineLetterSchema, declineLetter, {
    defaultValues: { id: letter.id, updatedAt: letter.updatedAt, reason: "" },
    successMessage: "Marked declined",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} size="sm" title="The client declined the letter" description="Don't start the work it covers. You can take it back to a draft and issue a revised letter." onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty} submitLabel="Mark declined">
      <FormAlert state={f} />
      <TextareaField control={f.control} name="reason" label="Why they declined" required rows={3} />
    </FormDialog>
  )
}

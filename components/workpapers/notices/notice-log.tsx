"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, TextareaField } from "@/components/app/form/fields"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { useActionForm } from "@/hooks/use-action-form"
import { formatDate, formatDateTime } from "@/lib/format"
import { NoticeNoteSchema } from "@/lib/schemas/notices"
import { addNoticeNote, deleteNoticeNote } from "@/server/actions/notices"
import type { NoticeNote } from "@/lib/data/notices"

const KIND_LABEL: Record<string, string> = {
  logged: "Logged",
  dates: "Dates",
  assigned: "Assigned",
  status: "Status",
  appeal: "Outcome",
  document: "Attachment",
}

/**
 * The running log (§7.8.4 "Running notes log (dated entries)"): dated notes people add (a call with
 * the officer, documents sent, an adjournment) and the lines the app writes itself (logged, dates
 * moved, reassigned, status changes with their notes, attachments), newest first. Notes are
 * append-only; a Partner or Manager can remove a line written by mistake.
 */
export function NoticeLog({ noticeId, notes, today, canDelete, closed }: { noticeId: string; notes: NoticeNote[]; today: string; canDelete: boolean; closed: boolean }) {
  const router = useRouter()
  const [removing, setRemoving] = React.useState<NoticeNote | null>(null)
  const f = useActionForm(NoticeNoteSchema, addNoticeNote, {
    defaultValues: { notice_id: noticeId, noted_on: today, body: "" },
    successMessage: "Note added.",
    onSuccess: () => {
      f.form.reset({ notice_id: noticeId, noted_on: today, body: "" })
      router.refresh()
    },
  })

  return (
    <SectionCard title="Log" description={notes.length ? `${notes.length} ${notes.length === 1 ? "entry" : "entries"}, newest first` : undefined} flush>
      <form onSubmit={f.onSubmit} noValidate className="border-b border-border px-4 pb-4 md:px-5">
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
          <DateField control={f.control} name="noted_on" label="Date" max={today} />
          <TextareaField
            control={f.control}
            name="body"
            label="Note"
            rows={2}
            placeholder={closed ? "For example: appeal filed; acknowledgement attached." : "For example: spoke to the officer; adjournment granted to 12 Nov."}
          />
        </div>
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" variant="outline" disabled={f.pending}>
            {f.pending ? <Spinner /> : null}
            Add note
          </Button>
        </div>
      </form>
      {notes.length === 0 ? (
        <div className="px-4 py-4 md:px-5">
          <EmptyState size="compact" message="Nothing logged yet. Notes, moved dates and status changes appear here." />
        </div>
      ) : (
        <ol className="divide-y divide-border/70">
          {notes.map((n) => (
            <li key={n.id} className="flex gap-3 px-4 py-3 md:px-5">
              <div className="w-24 flex-none">
                <p className="num text-sm text-text">{formatDate(n.noted_on)}</p>
                {n.kind !== "note" ? <p className="text-xs text-text-muted">{KIND_LABEL[n.kind] ?? "App"}</p> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-base whitespace-pre-line text-text">{n.body}</p>
                <p className="mt-0.5 text-xs text-text-muted" title={formatDateTime(n.created_at)}>
                  {n.author_name ?? (n.author_id ? "A colleague" : "TaxWise")} · {formatDateTime(n.created_at)}
                </p>
              </div>
              {canDelete ? (
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove this log line" onClick={() => setRemoving(n)}>
                  <Trash2Icon aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => (!o ? setRemoving(null) : undefined)}
        title="Remove this log line?"
        description="It disappears from the notice's log for everyone. The removal is recorded in the audit log."
        confirmLabel="Remove line"
        destructive
        onConfirm={async () => {
          if (!removing) return false
          const r = await deleteNoticeNote({ id: removing.id })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success("Removed.")
          setRemoving(null)
          router.refresh()
        }}
      />
    </SectionCard>
  )
}

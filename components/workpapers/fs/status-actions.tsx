"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useWatch, type Control } from "react-hook-form"
import { CheckCheckIcon, LockIcon, Undo2Icon, UnlockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { StatementStatusSchema, type FsStatus, type StatementStatusInput } from "@/lib/schemas/financial-statements"
import { setFinancialStatementStatus } from "@/server/actions/financial-statements"

type Move = "review" | "final" | "send_back" | "reopen"

const MOVES: Record<Move, { to: FsStatus; title: string; description: string; submit: string; noteLabel: string; required: boolean; placeholder: string; done: string }> = {
  review: {
    to: "reviewed",
    title: "Mark as reviewed",
    description: "You have checked the ledger mapping, both statements and the notes against the trial balance. A Manager or Partner then marks it final.",
    submit: "Mark reviewed",
    noteLabel: "Review note",
    required: false,
    placeholder: "Checked the mapping of the loans and the ageing schedules",
    done: "Marked as reviewed",
  },
  final: {
    to: "final",
    title: "Mark as final",
    description: "The statement is locked, and next year's statement takes its comparatives from it. A Manager or Partner can reopen it later.",
    submit: "Mark final",
    noteLabel: "Note",
    required: false,
    placeholder: "Approved with the client on the closing meeting",
    done: "Marked as final",
  },
  send_back: {
    to: "draft",
    title: "Send back to Draft",
    description: "The preparer is told, with your note. It comes back for review once they have made the changes.",
    submit: "Send back",
    noteLabel: "What should change",
    required: true,
    placeholder: "Map the director's loan under long-term borrowings, not other current liabilities",
    done: "Sent back to Draft",
  },
  reopen: {
    to: "draft",
    title: "Reopen as a draft",
    description: "The statement is unlocked for changes and needs a fresh review before it is final again.",
    submit: "Reopen",
    noteLabel: "Why it is reopened",
    required: true,
    placeholder: "Audit adjustment to the closing stock",
    done: "Reopened as a draft",
  },
}

function StatusDialog({ id, move, getUpdatedAt, onClose }: { id: string; move: Move; getUpdatedAt: () => string; onClose: () => void }) {
  const router = useRouter()
  const m = MOVES[move]
  const f = useActionForm(StatementStatusSchema, (values: StatementStatusInput) => setFinancialStatementStatus({ ...values, updatedAt: getUpdatedAt() }), {
    defaultValues: { id, updatedAt: getUpdatedAt(), status: m.to, note: "" } satisfies StatementStatusInput,
    successMessage: m.done,
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const control = f.control as unknown as Control<StatementStatusInput>
  const note = useWatch({ control, name: "note" })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={m.title}
      description={m.description}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={Boolean(String(note ?? "").trim())}
      submitLabel={m.submit}
    >
      <FormAlert state={f} />
      <TextareaField control={control} name="note" label={m.noteLabel} required={m.required} rows={3} placeholder={m.placeholder} helper={m.required ? undefined : "Optional. Kept in the statement's history."} />
    </FormDialog>
  )
}

export type StatusActionsProps = {
  id: string
  status: FsStatus
  /** The version the next change is checked against (it moves with every save and autosave). */
  getUpdatedAt: () => string
  viewer: { id: string; role: "partner" | "manager" | "employee" }
  preparedBy: string | null
  /** The saved statement passes every check (the preview isn't what is marked final). */
  checksPass: boolean
  /** Unsaved changes on screen: save them before the status moves. */
  dirty: boolean
}

/**
 * Draft → Reviewed → Final (§7.8.3): the buttons the viewer may use now, each with why it is
 * unavailable when it is. Someone other than the preparer reviews (a Partner may review their own);
 * only a Manager or Partner marks final, when every check passes, and only they reopen a final
 * statement. Sending back or reopening needs a note. The database enforces the same rules (0202).
 */
export function StatusActions({ id, status, getUpdatedAt, viewer, preparedBy, checksPass, dirty }: StatusActionsProps) {
  const [move, setMove] = React.useState<Move | null>(null)
  const senior = viewer.role === "partner" || viewer.role === "manager"
  const ownWork = preparedBy !== null && preparedBy === viewer.id && viewer.role !== "partner"
  const hint = dirty
    ? "Save your changes before changing the status."
    : status === "draft" && ownWork
      ? "You prepared it, so a colleague, a Manager or a Partner reviews it."
      : status === "reviewed" && !senior
        ? "A Manager or Partner marks it final."
        : status === "reviewed" && !checksPass
          ? "Every check must pass before it is final."
          : status === "final" && !senior
            ? "Final and locked. A Manager or Partner can reopen it."
            : null

  const open = (m: Move) => {
    if (dirty) {
      toast.info("Save your changes before changing the status.")
      return
    }
    setMove(m)
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {hint ? <span className="text-sm text-text-muted">{hint}</span> : null}
      {status === "draft" ? (
        <Button type="button" variant="outline" disabled={dirty || ownWork} onClick={() => open("review")}>
          <CheckCheckIcon aria-hidden="true" />
          Mark reviewed
        </Button>
      ) : null}
      {status === "reviewed" ? (
        <>
          <Button type="button" variant="outline" disabled={dirty} onClick={() => open("send_back")}>
            <Undo2Icon aria-hidden="true" />
            Send back
          </Button>
          {senior ? (
            <Button type="button" variant="outline" disabled={dirty || !checksPass} onClick={() => open("final")}>
              <LockIcon aria-hidden="true" />
              Mark final
            </Button>
          ) : null}
        </>
      ) : null}
      {status === "final" && senior ? (
        <Button type="button" variant="outline" onClick={() => open("reopen")}>
          <UnlockIcon aria-hidden="true" />
          Reopen
        </Button>
      ) : null}
      {move ? <StatusDialog id={id} move={move} getUpdatedAt={getUpdatedAt} onClose={() => setMove(null)} /> : null}
    </div>
  )
}

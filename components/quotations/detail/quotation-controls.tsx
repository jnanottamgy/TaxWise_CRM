"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  CopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  EllipsisIcon,
  PencilIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UndoIcon,
  UserPlusIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { useCopy } from "@/hooks/use-copy"
import { formatDateTime } from "@/lib/format"
import { ApprovalDecisionSchema, SUPERSEDED_MESSAGE, type ApprovalDecisionInput } from "@/lib/schemas/quotations"
import { decideQuotationApproval, deleteQuotation, reviseQuotation, submitQuotationForApproval } from "@/server/actions/quotations"
import { SendQuotationDialog } from "@/components/quotations/detail/send-dialog"
import type { ControlsData } from "@/components/quotations/detail/types"

type DialogKind = null | "send" | "submit" | "approve" | "approve_send" | "return" | "revise" | "delete"

type Ctx = {
  data: ControlsData
  updatedAt: string
  setUpdatedAt: (v: string) => void
  open: (d: DialogKind) => void
}

const ControlsContext = React.createContext<Ctx | null>(null)

function useControls(): Ctx {
  const c = React.useContext(ControlsContext)
  if (!c) throw new Error("QuotationControls parts must sit inside <QuotationControls>.")
  return c
}

/** Statuses whose link answers the client with something (the quotation, or why it can't be answered). */
const LINK_LIVE = ["sent", "viewed", "accepted", "rejected", "expired", "superseded"]

/**
 * The quotation page's controls (§7.5.2–§7.5.3), sharing the quotation's updated_at so each step is
 * refused, not overwritten, when someone else moved it on (§13): the header actions, the approval
 * panel, and the dialogs they open (send, submit for approval, approve / approve & send / return with
 * comments, revise, delete). Wrap the page's content in it.
 */
export function QuotationControls({ data, children }: { data: ControlsData; children: React.ReactNode }) {
  const router = useRouter()
  const [seen, setSeen] = React.useState(data.updatedAt)
  const [updatedAt, setUpdatedAt] = React.useState(data.updatedAt)
  const [dialog, setDialog] = React.useState<DialogKind>(null)
  if (data.updatedAt !== seen) {
    setSeen(data.updatedAt)
    setUpdatedAt(data.updatedAt)
  }
  const ctx = React.useMemo<Ctx>(() => ({ data, updatedAt, setUpdatedAt, open: setDialog }), [data, updatedAt])
  const close = (o: boolean) => {
    if (!o) setDialog(null)
  }

  const fail = (r: { error: string; ref?: string }) => {
    toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
    return false
  }

  return (
    <ControlsContext.Provider value={ctx}>
      {children}

      <SendQuotationDialog
        open={dialog === "send"}
        onOpenChange={close}
        data={data}
        updatedAt={updatedAt}
        onSent={(r) => {
          if (r.updatedAt) setUpdatedAt(r.updatedAt)
        }}
      />

      <ApprovalDialog
        mode={dialog === "approve" || dialog === "approve_send" || dialog === "return" ? dialog : null}
        onOpenChange={close}
        data={data}
        updatedAt={updatedAt}
        onDone={(r, mode) => {
          setUpdatedAt(r.updatedAt)
          router.refresh()
          if (mode === "approve_send") setDialog("send")
          else setDialog(null)
        }}
      />

      <ConfirmDialog
        open={dialog === "submit"}
        onOpenChange={close}
        title={`Submit ${data.number} for approval?`}
        description={`It goes to the Partners at Pending approval (${data.totalLabel} incl. GST is over your approval limit), and they are told. It can't be changed while it waits; revise it if something needs to change.`}
        confirmLabel="Submit for approval"
        onConfirm={async () => {
          const r = await submitQuotationForApproval({ id: data.id, updatedAt })
          if (!r.ok) return fail(r)
          setUpdatedAt(r.data.updatedAt)
          toast.success("Sent to the Partners for approval.")
          router.refresh()
        }}
      />

      <ConfirmDialog
        open={dialog === "revise"}
        onOpenChange={close}
        title={`Revise ${data.number}?`}
        description={
          data.status === "pending_approval" || data.status === "approved"
            ? `A new Draft with the same lines and a new number opens for editing. ${data.number} becomes Superseded and no longer needs approval.`
            : `A new Draft with the same lines, a new number and a new link opens for editing. ${data.number} becomes Superseded: its link stops taking responses and says "${SUPERSEDED_MESSAGE}". Its pending follow-ups stop.`
        }
        confirmLabel="Revise quotation"
        onConfirm={async () => {
          const r = await reviseQuotation({ id: data.id, updatedAt })
          if (!r.ok) return fail(r)
          toast.success(`Revision ${r.data.quotationNumber} started.`)
          router.push(`/quotations/${r.data.id}/edit`)
        }}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={`Delete ${data.number}?`}
        description={
          data.status === "draft"
            ? "The draft moves to the recycle bin. Nothing has gone to the client."
            : "It moves to the recycle bin and its link stops working: the client sees that the quotation isn't available. A Partner or Manager can restore it."
        }
        confirmLabel="Delete quotation"
        destructive
        onConfirm={async () => {
          const r = await deleteQuotation({ id: data.id, updatedAt })
          if (!r.ok) return fail(r)
          toast.success(`${data.number} moved to the recycle bin.`)
          router.push("/quotations")
        }}
      />
    </ControlsContext.Provider>
  )
}

/** The header's actions: the next step first (send, submit for approval, create the client), then edit / revise, PDF and the rest. */
export function QuotationHeaderActions() {
  const { data, open } = useControls()
  const { copy } = useCopy()
  const a = data.actions
  const linkLive = LINK_LIVE.includes(data.status)

  const copyLink = async () => {
    const ok = await copy(data.link)
    if (ok) toast.success("Link copied.")
    else toast.error("Couldn't copy the link.")
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {a.edit ? (
        <Button asChild variant="outline">
          <Link href={`/quotations/${data.id}/edit`}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Link>
        </Button>
      ) : null}
      {a.revise && !a.edit ? (
        <Button variant="outline" onClick={() => open("revise")}>
          <CopyPlusIcon aria-hidden="true" />
          Revise
        </Button>
      ) : null}
      <Button asChild variant="outline" className="max-sm:hidden">
        <a href={data.pdfHref} download>
          <DownloadIcon aria-hidden="true" />
          PDF
        </a>
      </Button>
      {a.createClient && data.createClientHref ? (
        <Button asChild>
          <Link href={data.createClientHref}>
            <UserPlusIcon aria-hidden="true" />
            Create client
          </Link>
        </Button>
      ) : a.submitForApproval ? (
        <Button onClick={() => open("submit")}>
          <ShieldCheckIcon aria-hidden="true" />
          Submit for approval
        </Button>
      ) : a.send ? (
        <Button onClick={() => open("send")}>
          <SendIcon aria-hidden="true" />
          Send
        </Button>
      ) : a.resend ? (
        <Button variant="outline" onClick={() => open("send")}>
          <SendIcon aria-hidden="true" />
          Resend
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem asChild className="sm:hidden">
            <a href={data.pdfHref} download>
              <DownloadIcon aria-hidden="true" />
              Download PDF
            </a>
          </DropdownMenuItem>
          {linkLive ? (
            <DropdownMenuItem onSelect={() => void copyLink()}>
              <CopyIcon aria-hidden="true" />
              Copy the client&apos;s link
            </DropdownMenuItem>
          ) : null}
          {linkLive ? (
            <DropdownMenuItem asChild>
              <a href={data.link} target="_blank" rel="noopener noreferrer">
                <SendIcon aria-hidden="true" />
                Open the client&apos;s page
              </a>
            </DropdownMenuItem>
          ) : null}
          {a.revise && a.edit ? (
            <DropdownMenuItem onSelect={() => open("revise")}>
              <CopyPlusIcon aria-hidden="true" />
              Revise
            </DropdownMenuItem>
          ) : null}
          {a.remove ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => open("delete")}>
                <Trash2Icon aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * Pending approval (§7.5.2): who submitted it and when; a Partner approves, approves and sends, or
 * returns it with comments. Everyone else sees that it waits for a Partner.
 */
export function ApprovalPanel() {
  const { data, open } = useControls()
  if (data.status !== "pending_approval" || !data.approval) return null
  const since = data.approval.requestedAt ? ` since ${formatDateTime(data.approval.requestedAt)}` : ""
  const by = data.approval.requestedByName ? `, submitted by ${data.approval.requestedByName}` : ""
  return (
    <section aria-label="Approval" className="mb-4 flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 text-base text-text">
        <p className="font-medium">Waiting for a Partner&apos;s approval{since}{by}.</p>
        <p className="text-sm text-text-muted">
          {data.actions.decideApproval
            ? "Approve it, approve and send it now, or return it with comments for the author to fix."
            : "A Partner approves it or returns it with comments. To change it now, revise it."}
        </p>
      </div>
      {data.actions.decideApproval ? (
        <div className="flex flex-none flex-wrap gap-2">
          <Button variant="outline" onClick={() => open("return")}>
            <UndoIcon aria-hidden="true" />
            Return with comments
          </Button>
          <Button variant="outline" onClick={() => open("approve")}>
            Approve
          </Button>
          <Button onClick={() => open("approve_send")} disabled={!data.email}>
            <SendIcon aria-hidden="true" />
            Approve &amp; send
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function ApprovalDialog({
  mode,
  onOpenChange,
  data,
  updatedAt,
  onDone,
}: {
  mode: "approve" | "approve_send" | "return" | null
  onOpenChange: (open: boolean) => void
  data: ControlsData
  updatedAt: string
  onDone: (r: { updatedAt: string; status: string }, mode: "approve" | "approve_send" | "return") => void
}) {
  const decision = mode === "return" ? "return" : "approve"
  const defaults: ApprovalDecisionInput = { id: data.id, updatedAt, decision, note: "" }
  const modeRef = React.useRef(mode)
  React.useEffect(() => {
    if (mode) modeRef.current = mode
  }, [mode])
  const f = useActionForm(ApprovalDecisionSchema, decideQuotationApproval, {
    defaultValues: defaults,
    successMessage: (r) => (r.status === "draft" ? "Returned to the author with your comments." : "Approved."),
    onSuccess: (r) => onDone(r, modeRef.current ?? "approve"),
  })
  React.useEffect(() => {
    if (mode) {
      f.form.reset({ id: data.id, updatedAt, decision: mode === "return" ? "return" : "approve", note: "" })
      f.clearFormError()
    }
    // Reset each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const title = mode === "return" ? `Return ${data.number} with comments` : mode === "approve_send" ? `Approve and send ${data.number}` : `Approve ${data.number}`
  const description =
    mode === "return"
      ? "It goes back to Draft for the author, with your comments on it. They are told."
      : mode === "approve_send"
        ? `Approves ${data.totalLabel} incl. GST for ${data.who}, then opens Send. The author is told.`
        : `Approves ${data.totalLabel} incl. GST for ${data.who}. The author is told and can send it.`
  return (
    <FormDialog
      open={mode !== null}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      description={description}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={mode === "return" ? "Return with comments" : mode === "approve_send" ? "Approve and continue" : "Approve"}
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <TextareaField
          control={f.control}
          name="note"
          label={mode === "return" ? "What needs to change" : "Note"}
          required={mode === "return"}
          rows={4}
          maxLength={2000}
          helper={mode === "return" ? "The author sees this on the draft." : "Optional; kept on the quotation's history."}
        />
      </div>
    </FormDialog>
  )
}

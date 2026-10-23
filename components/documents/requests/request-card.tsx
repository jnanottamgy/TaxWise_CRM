"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BellRingIcon, CheckIcon, EllipsisIcon, EyeIcon, FileUpIcon, LinkIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { formatDate } from "@/lib/format"
import { EMAIL_NOT_SET_UP_MESSAGE } from "@/lib/handoff"
import { progressLabel } from "@/lib/schemas/document-requests"
import type { RequestRow, RequestItemRow, RequestContact } from "@/lib/data/document-requests"
import type { DocumentOption } from "@/lib/data/documents"
import { cancelDocumentRequest, removeRequestItem, reopenDocumentRequest, reviewRequestItem, sendRequestReminder } from "@/server/actions/document-requests"
import { UploadDialog } from "@/components/documents/uploader"
import { fileHref } from "@/components/documents/doc-urls"
import { RequestHandoff, type HandoffMessaging } from "@/components/documents/requests/request-handoff"
import { EditRequestDialog } from "@/components/documents/requests/request-dialog"
import { AddItemDialog, EditItemDialog, LinkFromVaultDialog, RejectItemDialog } from "@/components/documents/requests/item-dialogs"

/**
 * One document request (§7.14): its items with their state, Accept / Send back for what the client
 * uploaded, upload or link a file on the client's behalf, reminders and hand-offs, edit, cancel and
 * reopen. Items are listed in the order the client sees them.
 */

export interface RequestCardContext {
  clientId: string
  clientName: string
  clientCode: string
  client: { phone: string | null; whatsapp: string | null; email: string | null; has_portal: boolean }
  contacts: RequestContact[]
  documents: DocumentOption[]
  messaging: HandoffMessaging
  portalBase: string
  emailReady: boolean
  /** Partner or Manager: remove items. */
  canManage: boolean
  today: string
}

type ItemDialog = { kind: "reject" | "link" | "edit" | "upload"; item: RequestItemRow } | { kind: "add" } | { kind: "edit-request" } | { kind: "cancel" } | { kind: "remove"; item: RequestItemRow } | null

function ItemStatus({ item }: { item: RequestItemRow }) {
  return <StatusChip kind="request_item_status" value={item.status} />
}

export function RequestCard({ request, ctx, focused }: { request: RequestRow; ctx: RequestCardContext; focused: boolean }) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<ItemDialog>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [cancelReason, setCancelReason] = React.useState("")
  const ref = React.useRef<HTMLElement>(null)
  const open = request.status === "open"
  const closed = request.status !== "open"
  const contact = ctx.contacts.find((c) => c.id === request.contact_id) ?? ctx.contacts.find((c) => c.is_primary) ?? null
  const portalLink = `${ctx.portalBase}/portal/documents?request=${request.id}`

  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [focused])

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; ref?: string; warnings?: string[] } & Record<string, unknown>>, success: string) => {
    setBusy(key)
    try {
      const r = await fn()
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : (r.error ?? "That didn't work."))
        return false
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(success)
      router.refresh()
      return true
    } finally {
      setBusy(null)
    }
  }

  const accept = (item: RequestItemRow) =>
    run(`accept:${item.id}`, () => reviewRequestItem({ id: item.id, requestId: request.id, clientId: ctx.clientId, decision: "accept", updatedAt: item.updated_at }), `${item.title} accepted.`)

  const remind = async () => {
    setBusy("remind")
    try {
      const r = await sendRequestReminder({ id: request.id, clientId: ctx.clientId, updatedAt: request.updated_at })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      const e = r.data.email
      if (e.status === "sent") toast.success(`Reminder emailed to ${e.recipientName ?? ctx.clientName}.`)
      else if (e.status === "not_configured") toast.warning(`${EMAIL_NOT_SET_UP_MESSAGE}`, { duration: 10_000 })
      else if (e.status === "no_recipient") toast.warning("There's no email address for this client. Use WhatsApp instead.", { duration: 10_000 })
      else toast.warning(`The reminder email didn't go${e.error ? `: ${e.error}` : "."} Use WhatsApp or Gmail instead.`, { duration: 12_000 })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const meta: string[] = []
  if (request.contact_name) meta.push(`To ${request.contact_name}`)
  meta.push(progressLabel(request.progress))

  return (
    <article
      ref={ref}
      aria-labelledby={`req-${request.id}`}
      className={cn("scroll-mt-24 rounded-lg border bg-surface", focused ? "border-primary/50 ring-1 ring-primary/30" : "border-border")}
    >
      <header className="flex flex-col gap-2 px-4 pt-4 pb-3 md:flex-row md:items-start md:justify-between md:px-5">
        <div className="min-w-0">
          <h3 id={`req-${request.id}`} className="text-md leading-6 font-semibold text-text">
            {request.title}
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-text-muted">
            {request.due_date ? (
              <span className="inline-flex items-center gap-1">
                Due <DateText date={request.due_date} withRelative={open} today={ctx.today} />
              </span>
            ) : (
              <span>No due date</span>
            )}
            {meta.map((m) => (
              <span key={m}>· {m}</span>
            ))}
          </p>
          <p className="mt-0.5 text-sm text-text-muted">
            {request.status === "completed" && request.completed_at
              ? `Completed ${formatDate(request.completed_at)}.`
              : request.status === "cancelled"
                ? `Cancelled ${formatDate(request.cancelled_at)}${request.cancel_reason ? `: ${request.cancel_reason}` : "."}`
                : `Reminders every ${request.reminder_every_days} ${request.reminder_every_days === 1 ? "day" : "days"}${request.next_reminder_on ? ` · next ${formatDate(request.next_reminder_on)}` : " · none due: nothing is pending"}${request.reminder_count ? ` · ${request.reminder_count} sent` : ""}.`}{" "}
            Requested by {request.created_by_name ?? "the firm"} on {formatDate(request.created_at)}.
          </p>
          {request.notes ? <p className="mt-1.5 text-base whitespace-pre-line text-text">{request.notes}</p> : null}
        </div>
        <div className="flex flex-none items-center gap-2">
          <StatusChip kind="request_status" value={request.status} variant="pill" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${request.title}`}>
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!closed || request.status === "completed" ? (
                <>
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "edit-request" })}>
                    <PencilIcon aria-hidden="true" /> Edit request
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "add" })}>
                    <PlusIcon aria-hidden="true" /> Add an item
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "cancel" })}>
                    <XIcon aria-hidden="true" /> Cancel request
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem
                  onSelect={() => void run("reopen", () => reopenDocumentRequest({ id: request.id, clientId: ctx.clientId, updatedAt: request.updated_at }), "Request reopened.")}
                >
                  <RotateCcwIcon aria-hidden="true" /> Reopen request
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <ol className="divide-y divide-border/70 border-t border-border/70">
        {request.items.map((item, i) => (
          <li key={item.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:justify-between md:px-5">
            <div className="flex min-w-0 gap-3">
              <span className="num mt-0.5 w-5 flex-none text-right text-sm text-text-muted tabular-nums">{i + 1}.</span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-base font-medium text-text">{item.title}</span>
                  {item.is_required ? null : <span className="text-sm text-text-muted">Optional</span>}
                  <ItemStatus item={item} />
                </p>
                {item.help_text ? <p className="text-sm text-text-muted">{item.help_text}</p> : null}
                {item.status === "rejected" && item.rejection_reason ? <p className="mt-0.5 text-sm text-danger-text">Sent back: {item.rejection_reason}</p> : null}
                {item.status === "uploaded" && item.rejection_reason ? <p className="mt-0.5 text-sm text-text-muted">Uploaded again after: {item.rejection_reason}</p> : null}
                {item.document_id ? (
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-text-muted">
                    <a href={fileHref(item.document_id, { mode: "preview" })} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      <EyeIcon aria-hidden="true" className="size-3.5" />
                      {item.document_file_name ?? item.document_title ?? "View file"}
                    </a>
                    {item.uploaded_at ? <span>· uploaded {formatDate(item.uploaded_at)}</span> : null}
                    {item.reviewed_at && item.status === "accepted" ? <span>· accepted by {item.reviewed_by_name ?? "the firm"}</span> : null}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2 pl-8 md:pl-0">
              {item.status === "uploaded" && !closed ? (
                <>
                  <Button type="button" size="sm" disabled={busy !== null} onClick={() => void accept(item)}>
                    <CheckIcon aria-hidden="true" />
                    Accept
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setDialog({ kind: "reject", item })}>
                    Send back
                  </Button>
                </>
              ) : null}
              {(item.status === "pending" || item.status === "rejected") && request.status !== "cancelled" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: "upload", item })}>
                  <FileUpIcon aria-hidden="true" />
                  Upload for client
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${item.title}`}>
                    <EllipsisIcon aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(item.status === "pending" || item.status === "rejected" || item.status === "uploaded") && request.status !== "cancelled" ? (
                    <DropdownMenuItem onSelect={() => setDialog({ kind: "link", item })}>
                      <LinkIcon aria-hidden="true" /> Accept with a vault document
                    </DropdownMenuItem>
                  ) : null}
                  {item.status === "accepted" && request.status !== "cancelled" ? (
                    <DropdownMenuItem onSelect={() => setDialog({ kind: "reject", item })}>
                      <RotateCcwIcon aria-hidden="true" /> Send back
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", item })}>
                    <PencilIcon aria-hidden="true" /> Edit item
                  </DropdownMenuItem>
                  {ctx.canManage ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" disabled={request.items.length === 1} onSelect={() => setDialog({ kind: "remove", item })}>
                        <Trash2Icon aria-hidden="true" /> Remove item
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
      </ol>

      {open ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-3 md:px-5">
          <p className="mr-auto text-sm text-text-muted">{request.progress.outstanding ? `Chase the ${request.progress.outstanding} outstanding ${request.progress.outstanding === 1 ? "item" : "items"}:` : "Nothing is pending from the client."}</p>
          {request.progress.outstanding ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null || !ctx.emailReady} title={ctx.emailReady ? undefined : EMAIL_NOT_SET_UP_MESSAGE} onClick={() => void remind()}>
                <BellRingIcon aria-hidden="true" />
                Email reminder
              </Button>
              <RequestHandoff
                clientId={ctx.clientId}
                clientName={ctx.clientName}
                clientCode={ctx.clientCode}
                client={ctx.client}
                recipient={contact ? { contactId: contact.id, name: contact.name, email: contact.email, phone: contact.phone, whatsapp: contact.whatsapp } : null}
                request={{ id: request.id, title: request.title, due_date: request.due_date }}
                items={request.items}
                portalLink={portalLink}
                messaging={ctx.messaging}
                reminder={request.reminder_count > 0 || request.last_reminded_at !== null}
              />
            </>
          ) : null}
        </footer>
      ) : null}

      {dialog?.kind === "reject" ? (
        <RejectItemDialog open onOpenChange={(o) => !o && setDialog(null)} clientId={ctx.clientId} clientName={ctx.clientName} requestId={request.id} item={dialog.item} emailReady={ctx.emailReady} />
      ) : null}
      {dialog?.kind === "link" ? (
        <LinkFromVaultDialog open onOpenChange={(o) => !o && setDialog(null)} clientId={ctx.clientId} requestId={request.id} item={dialog.item} documents={ctx.documents} />
      ) : null}
      {dialog?.kind === "edit" ? <EditItemDialog open onOpenChange={(o) => !o && setDialog(null)} clientId={ctx.clientId} requestId={request.id} item={dialog.item} /> : null}
      {dialog?.kind === "add" ? <AddItemDialog open onOpenChange={(o) => !o && setDialog(null)} clientId={ctx.clientId} requestId={request.id} /> : null}
      {dialog?.kind === "edit-request" ? <EditRequestDialog open onOpenChange={(o) => !o && setDialog(null)} clientId={ctx.clientId} contacts={ctx.contacts} request={request} /> : null}
      {dialog?.kind === "upload" ? (
        <UploadDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          clientId={ctx.clientId}
          clientName={ctx.clientName}
          purpose="request_item"
          requestItemId={dialog.item.id}
          acceptItem
          single
          allowConfidential={false}
          title={`Upload for the client: ${dialog.item.title}`}
          description="The file goes into the vault and the item is accepted. Use this when the client sent it by email, WhatsApp or in person."
          defaults={{ title: dialog.item.title }}
          onUploaded={() => {
            toast.success(`${dialog.item.title} uploaded and accepted.`)
            setDialog(null)
            router.refresh()
          }}
        />
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === "remove"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog?.kind === "remove" ? `Remove “${dialog.item.title}”?` : "Remove item?"}
        description="It disappears from the request and the client's portal. A file already uploaded for it stays in the vault."
        confirmLabel="Remove item"
        destructive
        onConfirm={async () => {
          if (dialog?.kind !== "remove") return
          const ok = await run("remove", () => removeRequestItem({ id: dialog.item.id, requestId: request.id, clientId: ctx.clientId }), "Item removed.")
          if (!ok) return false
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === "cancel"}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null)
            setCancelReason("")
          }
        }}
        title={`Cancel “${request.title}”?`}
        description="The client can no longer upload against it and reminders stop. Files already uploaded stay in the vault. You can reopen it later."
        details={
          <div className="mt-2">
            <label htmlFor={`cancel-${request.id}`} className="mb-1 block text-sm font-medium text-text">
              Reason (optional)
            </label>
            <Textarea id={`cancel-${request.id}`} rows={2} maxLength={500} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="The client brought the papers to the office." />
          </div>
        }
        confirmLabel="Cancel request"
        destructive
        onConfirm={async () => {
          const ok = await run("cancel", () => cancelDocumentRequest({ id: request.id, clientId: ctx.clientId, updatedAt: request.updated_at, reason: cancelReason.trim() || null }), "Request cancelled.")
          if (!ok) return false
          setCancelReason("")
        }}
      />
    </article>
  )
}

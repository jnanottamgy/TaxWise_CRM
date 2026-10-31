"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  BanIcon,
  CheckIcon,
  FileDownIcon,
  FileMinusIcon,
  FilePlusIcon,
  FileSignatureIcon,
  HandCoinsIcon,
  MessageSquareWarningIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { formatINR } from "@/lib/domain/money"
import { CancelReissueSchema, DebitNoteSchema, DisputeSchema, ReturnInvoiceSchema, WaiveSchema, type InvoiceActions } from "@/lib/schemas/invoices"
import { approveInvoice, cancelAndReissue, createDebitNote, deleteInvoiceDraft, markDisputed, resolveDispute, returnInvoice, waiveInvoice } from "@/server/actions/invoices"
import { ReasonDialog } from "@/components/invoices/detail/reason-dialog"
import { SendInvoiceDialog, useInvoiceWhatsApp } from "@/components/invoices/detail/send-dialog"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { ReceiptDialog } from "@/components/invoices/detail/receipt-dialog"
import { CreditNoteDialog } from "@/components/invoices/detail/credit-note-dialog"
import { EInvoiceDialog } from "@/components/invoices/detail/e-invoice-dialog"
import { toastResult } from "@/components/invoices/detail/toast-result"
import type { CreditContext, DetailInvoice, ReceiptContext, SendContext } from "@/components/invoices/detail/types"

type DialogName = "issue" | "send" | "receipt" | "credit" | "einvoice" | "dispute" | "resolve" | "waive" | "cancel" | "debit" | "return" | "approve" | "delete"

/**
 * The invoice's actions (§7.9.3), by its state and the viewer's role (invoiceActions): one primary
 * button for the next step (Approve · Issue and send · Edit draft · Record receipt · Send), the PDF,
 * WhatsApp for an issued invoice (straight to the preview, to the primary contact; Send again under
 * More picks another), and the rest under More. The database refuses anything not allowed; this
 * only offers what is.
 */
export function InvoiceActionsBar({
  invoice,
  actions,
  send,
  receipt,
  credit,
  eInvoicing,
  today,
}: {
  invoice: DetailInvoice
  actions: InvoiceActions
  send: SendContext
  receipt: ReceiptContext
  /** Partners only. */
  credit: CreditContext | null
  eInvoicing: boolean
  today: string
}) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<DialogName | null>(null)
  const close = () => setDialog(null)
  const ref = { invoiceId: invoice.id, updatedAt: invoice.updatedAt }
  const label = invoice.number ?? (invoice.kind === "debit_note" ? "this draft debit note" : "this draft")
  const unissued = invoice.status === "draft" || invoice.status === "awaiting_approval"
  const issuedOpen = !unissued && !invoice.cancelled

  const primary: DialogName | "edit" | null = actions.approve ? "approve" : actions.issue ? "issue" : actions.edit ? "edit" : actions.recordReceipt ? "receipt" : actions.sendAgain ? "send" : null
  const primaryContact = send.recipients.find((r) => r.primary) ?? send.recipients[0] ?? null
  const wa = useInvoiceWhatsApp(invoice, send, primaryContact, invoice.number)

  const pdfLabel = unissued ? "Preview PDF" : "PDF"
  const more: Array<{ key: string; label: string; icon: React.ReactNode; onSelect: () => void; danger?: boolean; hint?: string; disabled?: boolean }> = []
  if (actions.recordReceipt && primary !== "receipt") more.push({ key: "receipt", label: "Record receipt", icon: <HandCoinsIcon aria-hidden="true" />, onSelect: () => setDialog("receipt") })
  if (actions.sendAgain && primary !== "send") more.push({ key: "send", label: "Send again", icon: <SendIcon aria-hidden="true" />, onSelect: () => setDialog("send") })
  if (actions.edit && primary !== "edit") more.push({ key: "edit", label: "Edit draft", icon: <PencilIcon aria-hidden="true" />, onSelect: () => router.push(`/invoices/${invoice.id}/edit`) })
  if (actions.returnToRaiser) more.push({ key: "return", label: "Return to the raiser", icon: <Undo2Icon aria-hidden="true" />, onSelect: () => setDialog("return") })
  if (actions.creditNote && credit) more.push({ key: "credit", label: "Issue credit note", icon: <FileMinusIcon aria-hidden="true" />, onSelect: () => setDialog("credit") })
  if (actions.debitNote) more.push({ key: "debit", label: "Raise debit note", icon: <FilePlusIcon aria-hidden="true" />, onSelect: () => setDialog("debit") })
  if (actions.cancelReissue) more.push({ key: "cancel", label: "Cancel and reissue", icon: <RotateCcwIcon aria-hidden="true" />, onSelect: () => setDialog("cancel") })
  else if (issuedOpen && actions.cancelReissueBlocked) more.push({ key: "cancel", label: "Cancel and reissue", icon: <RotateCcwIcon aria-hidden="true" />, onSelect: () => undefined, disabled: true, hint: actions.cancelReissueBlocked })
  if (actions.dispute) more.push({ key: "dispute", label: "Mark disputed", icon: <MessageSquareWarningIcon aria-hidden="true" />, onSelect: () => setDialog("dispute") })
  if (actions.resolveDispute) more.push({ key: "resolve", label: "Resolve dispute", icon: <CheckIcon aria-hidden="true" />, onSelect: () => setDialog("resolve") })
  if (eInvoicing && issuedOpen && invoice.kind === "tax_invoice") more.push({ key: "einvoice", label: invoice.eInvoice.irn ? "Edit e-invoice details" : "Add e-invoice details", icon: <FileSignatureIcon aria-hidden="true" />, onSelect: () => setDialog("einvoice") })
  if (actions.waive) more.push({ key: "waive", label: "Waive", icon: <BanIcon aria-hidden="true" />, onSelect: () => setDialog("waive"), danger: true })
  if (actions.deleteDraft) more.push({ key: "delete", label: "Delete draft", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog("delete"), danger: true })

  const refresh = () => router.refresh()

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline">
          <a href={`/api/pdf/invoice/${invoice.id}`} target="_blank" rel="noopener">
            <FileDownIcon aria-hidden="true" />
            {pdfLabel}
          </a>
        </Button>
        {actions.sendAgain && primary !== "send" && invoice.number ? (
          <WhatsAppButton
            recipientName={wa.recipientName}
            number={wa.number}
            draft={wa.draft}
            templates={wa.templates}
            attachment={wa.attachment}
            label="WhatsApp"
            variant="outline"
            size="default"
            onHandedOff={wa.onHandedOff}
          />
        ) : null}
        {more.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label="More actions">
                <MoreHorizontalIcon aria-hidden="true" />
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {more.map((m, i) => (
                <React.Fragment key={m.key}>
                  {m.danger && i > 0 && !more[i - 1]?.danger ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem onSelect={m.onSelect} disabled={m.disabled} className={m.danger ? "text-danger-text focus:text-danger-text" : undefined}>
                    {m.icon}
                    <span className="flex min-w-0 flex-col">
                      <span>{m.label}</span>
                      {m.hint ? <span className="text-xs whitespace-normal text-text-muted">{m.hint}</span> : null}
                    </span>
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {primary === "approve" ? (
          <Button onClick={() => setDialog("approve")}>
            <CheckIcon aria-hidden="true" />
            Approve
          </Button>
        ) : primary === "issue" ? (
          <Button onClick={() => setDialog("issue")}>
            <SendIcon aria-hidden="true" />
            Issue and send
          </Button>
        ) : primary === "edit" ? (
          <Button asChild>
            <Link href={`/invoices/${invoice.id}/edit`}>
              <PencilIcon aria-hidden="true" />
              Edit draft
            </Link>
          </Button>
        ) : primary === "receipt" ? (
          <Button onClick={() => setDialog("receipt")}>
            <HandCoinsIcon aria-hidden="true" />
            Record receipt
          </Button>
        ) : primary === "send" ? (
          <Button onClick={() => setDialog("send")}>
            <SendIcon aria-hidden="true" />
            Send
          </Button>
        ) : null}
      </div>

      {dialog === "issue" || dialog === "send" ? <SendInvoiceDialog mode={dialog} invoice={invoice} send={send} onClose={close} /> : null}
      {dialog === "receipt" ? <ReceiptDialog invoice={invoice} ctx={receipt} onClose={close} /> : null}
      {dialog === "credit" && credit ? <CreditNoteDialog invoice={invoice} ctx={credit} onClose={close} /> : null}
      {dialog === "einvoice" ? <EInvoiceDialog invoice={invoice} today={today} onClose={close} /> : null}

      {dialog === "return" ? (
        <ReasonDialog
          onClose={close}
          title="Return to the raiser"
          description="It goes back as a draft, with your note, to the person who raised it. They can change it and submit it again."
          label="Note"
          field="note"
          placeholder="Bill the September and October returns separately"
          submitLabel="Return"
          schema={ReturnInvoiceSchema}
          action={returnInvoice}
          values={ref}
          successMessage="Returned with your note."
          onDone={refresh}
        />
      ) : null}
      {dialog === "dispute" ? (
        <ReasonDialog
          onClose={close}
          title={`Mark ${label} disputed`}
          description="Reminders stop while it is disputed. Resolve the dispute to start them again; a credit note or a reissue may follow."
          label="What the client disputes"
          placeholder="Client says the July return was billed twice"
          submitLabel="Mark disputed"
          schema={DisputeSchema}
          action={markDisputed}
          values={ref}
          successMessage="Marked disputed. Reminders are paused."
          onDone={refresh}
        />
      ) : null}
      {dialog === "waive" ? (
        <ReasonDialog
          onClose={close}
          title={`Waive ${formatINR(invoice.outstandingPaise)}?`}
          description={`The outstanding amount on ${label} is written off. Reports show it as a write-off, not as reduced revenue. This can't be undone.`}
          label="Reason"
          placeholder="Long-standing client; fee waived as agreed with the partner"
          submitLabel="Waive"
          schema={WaiveSchema}
          action={waiveInvoice}
          values={ref}
          successMessage="Waived. The outstanding amount is written off."
          onDone={refresh}
        />
      ) : null}
      {dialog === "cancel" ? (
        <ReasonDialog
          onClose={close}
          title={`Cancel and reissue ${label}?`}
          description="The invoice keeps its number and is marked cancelled with your reason; it is never payable again. A new draft copy opens for you to correct and issue. Time billed on it becomes unbilled again."
          label="Reason"
          placeholder="Wrong GSTIN on the invoice"
          submitLabel="Cancel and reissue"
          schema={CancelReissueSchema}
          action={cancelAndReissue}
          values={ref}
          onDone={(d) => {
            const data = d as { newId: string; cancelledNumber: string }
            toast.success(`${data.cancelledNumber} cancelled. Correct the new draft and issue it.`)
            router.push(`/invoices/${data.newId}/edit`)
          }}
        />
      ) : null}
      {dialog === "debit" ? (
        <ReasonDialog
          onClose={close}
          title="Raise a debit note"
          description={`A draft debit note (supplementary invoice) against ${label} opens. Add what is being charged extra, then issue it; it gets its own number.`}
          label="What it is for"
          placeholder="Additional work on the GST annual return"
          submitLabel="Start debit note"
          schema={DebitNoteSchema}
          action={createDebitNote}
          values={{ invoiceId: invoice.id }}
          onDone={(d) => router.push(`/invoices/${(d as { id: string }).id}/edit`)}
        />
      ) : null}

      <ConfirmDialog
        open={dialog === "approve"}
        onOpenChange={(o) => (!o ? close() : undefined)}
        title={`Approve ${formatINR(invoice.totalPaise)} for ${invoice.clientName}?`}
        description="The person who raised it is told and can issue and send it. Your approval is for this amount; a change to the lines asks for approval again."
        confirmLabel="Approve"
        onConfirm={async () => {
          const r = await approveInvoice(ref)
          if (!toastResult(r, "Approved. It can be issued and sent now.")) return false
          refresh()
        }}
      />
      <ConfirmDialog
        open={dialog === "resolve"}
        onOpenChange={(o) => (!o ? close() : undefined)}
        title="Resolve the dispute?"
        description="The invoice shows as Sent (or Partially paid) again, and payment reminders start again."
        confirmLabel="Resolve dispute"
        onConfirm={async () => {
          const r = await resolveDispute(ref)
          if (!toastResult(r, "Dispute resolved. Reminders resume.")) return false
          refresh()
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => (!o ? close() : undefined)}
        title={`Delete ${label}?`}
        description="The draft moves to the recycle bin. It never had a number, so no number is lost. Time and tasks on it stay unbilled."
        confirmLabel="Delete draft"
        destructive
        onConfirm={async () => {
          const r = await deleteInvoiceDraft(ref)
          if (!toastResult(r, "Draft deleted.")) return false
          router.push("/invoices")
        }}
      />
    </>
  )
}

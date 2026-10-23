"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FileDownIcon, ImageIcon, MailIcon, MoreHorizontalIcon, Undo2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField } from "@/components/app/form/fields"
import { DateText } from "@/components/app/date-text"
import { EmailSetupBanner } from "@/components/settings/email/email-setup-banner"
import { useActionForm } from "@/hooks/use-action-form"
import { emailOutcomeNotice } from "@/lib/handoff"
import { EmailReceiptSchema, RejectPaymentClaimSchema, ReverseReceiptSchema } from "@/lib/schemas/receipts"
import { emailReceipt, rejectPaymentClaim, reverseReceipt } from "@/server/actions/receipts"
import { ReasonDialog } from "@/components/invoices/detail/reason-dialog"
import { ReceiptDialog } from "@/components/invoices/detail/receipt-dialog"
import { newNonce } from "@/components/invoices/invoice-ui"
import type { DetailInvoice, PendingClaim, ReceiptContext } from "@/components/invoices/detail/types"

/**
 * A receipt's actions (§7.9.4): its PDF, email it to the client (§10.9), and reverse it with a
 * reason (a bounced cheque, a wrong entry). Receipts are never deleted; a reversal puts the amount
 * back on the invoice and the status follows.
 */
export function ReceiptActions({
  receipt,
  defaultEmail,
  emailReady,
  canSetUpEmail,
}: {
  receipt: { id: string; number: string; reversed: boolean }
  defaultEmail: string | null
  emailReady: boolean
  canSetUpEmail: boolean
}) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<"email" | "reverse" | null>(null)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for receipt ${receipt.number}`}>
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={`/api/pdf/receipt/${receipt.id}`} target="_blank" rel="noopener">
              <FileDownIcon aria-hidden="true" />
              Receipt PDF
            </a>
          </DropdownMenuItem>
          {!receipt.reversed ? (
            <>
              <DropdownMenuItem onSelect={() => setDialog("email")}>
                <MailIcon aria-hidden="true" />
                Email receipt
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("reverse")} className="text-danger-text focus:text-danger-text">
                <Undo2Icon aria-hidden="true" />
                Reverse receipt
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "email" ? <EmailReceiptDialog receipt={receipt} defaultEmail={defaultEmail} emailReady={emailReady} canSetUpEmail={canSetUpEmail} onClose={() => setDialog(null)} /> : null}
      {dialog === "reverse" ? (
        <ReasonDialog
          onClose={() => setDialog(null)}
          title={`Reverse receipt ${receipt.number}?`}
          description="The amount goes back on the invoice and its status follows. The receipt stays on record, marked reversed; it is never deleted."
          label="Reason"
          placeholder="Cheque bounced"
          submitLabel="Reverse receipt"
          schema={ReverseReceiptSchema}
          action={reverseReceipt}
          values={{ receiptId: receipt.id }}
          successMessage={`Receipt ${receipt.number} reversed.`}
          onDone={() => router.refresh()}
        />
      ) : null}
    </>
  )
}

function EmailReceiptDialog({
  receipt,
  defaultEmail,
  emailReady,
  canSetUpEmail,
  onClose,
}: {
  receipt: { id: string; number: string }
  defaultEmail: string | null
  emailReady: boolean
  canSetUpEmail: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [nonce] = React.useState(newNonce)
  const f = useActionForm(EmailReceiptSchema, emailReceipt, {
    defaultValues: { receiptId: receipt.id, to: defaultEmail ?? "", nonce },
    onSuccess: (data, values) => {
      const n = emailOutcomeNotice(data.email, values.to)
      if (n.tone === "success") toast.success(n.message)
      else toast.warning(n.detail ? `${n.message} ${n.detail}` : n.message, { duration: 12_000 })
      onClose()
      router.refresh()
    },
  })
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} size="sm" title={`Email receipt ${receipt.number}`} description="The receipt PDF, from the firm's mailbox." onSubmit={f.onSubmit} pending={f.pending} submitLabel="Send receipt">
      <FormAlert state={f} />
      {!emailReady ? <EmailSetupBanner canSetUp={canSetUpEmail} className="mb-4" /> : null}
      <TextField control={f.control} name="to" label="Email to" required inputMode="email" autoComplete="off" />
    </FormDialog>
  )
}

/**
 * The client's "I've paid" claims from the portal (§7.22, §18.3 Client 4): the invoice is never
 * marked paid by a claim; a Partner or Manager checks the bank (the client's screenshot opens
 * through the usual signed download) and either records the receipt, which closes the claim, or
 * marks it not received with a reason that stays with the firm.
 */
export function PaymentClaims({ invoice, claims, ctx, canRecord }: { invoice: DetailInvoice; claims: PendingClaim[]; ctx: ReceiptContext; canRecord: boolean }) {
  const router = useRouter()
  const [claim, setClaim] = React.useState<PendingClaim | null>(null)
  const [rejecting, setRejecting] = React.useState<PendingClaim | null>(null)
  if (claims.length === 0) return null
  return (
    <>
      <ul className="flex flex-col">
        {claims.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 border-b border-border/70 px-4 py-3 last:border-b-0 md:px-5">
            <div className="min-w-0">
              <p className="text-base text-text">
                Paid{c.paidOn ? (
                  <>
                    {" "}
                    on <DateText date={c.paidOn} today={ctx.today} />
                  </>
                ) : null}
                {c.reference ? <span className="text-text-muted"> · ref {c.reference}</span> : null}
              </p>
              <p className="text-sm text-text-muted">
                Told us <DateText date={c.createdAt.slice(0, 10)} today={ctx.today} />
                {c.note ? ` · ${c.note}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {c.screenshotDocumentId ? (
                <Button asChild size="sm" variant="ghost">
                  <a href={`/api/files/documents/${c.screenshotDocumentId}`} target="_blank" rel="noopener">
                    <ImageIcon aria-hidden="true" />
                    Screenshot
                  </a>
                </Button>
              ) : null}
              {canRecord ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => setClaim(c)}>
                    Record receipt
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(c)}>
                    Not received
                  </Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {claim ? <ReceiptDialog invoice={invoice} ctx={ctx} claim={claim} onClose={() => setClaim(null)} /> : null}
      {rejecting ? (
        <ReasonDialog
          onClose={() => setRejecting(null)}
          title="Payment not received"
          description={`The client's report${rejecting.reference ? ` (ref ${rejecting.reference})` : ""} is closed and the invoice stays as it is. The client can report the payment again from the portal.`}
          details={<p className="text-sm text-text-muted">The reason stays with the firm; the client doesn&apos;t see it. Message them if you need the payment details again.</p>}
          label="What you checked"
          placeholder="No credit for this UTR in the bank statement up to today"
          submitLabel="Mark not received"
          schema={RejectPaymentClaimSchema}
          action={rejectPaymentClaim}
          values={{ claimId: rejecting.id, updatedAt: rejecting.updatedAt }}
          successMessage="Payment report closed as not received."
          onDone={() => router.refresh()}
        />
      ) : null}
    </>
  )
}

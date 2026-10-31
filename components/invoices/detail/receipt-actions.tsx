"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileDownIcon, ImageIcon, MoreHorizontalIcon, Undo2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DateText } from "@/components/app/date-text"
import { SendDocumentButton, type DocumentShare } from "@/components/comms/send-document"
import { RejectPaymentClaimSchema, ReverseReceiptSchema } from "@/lib/schemas/receipts"
import { rejectPaymentClaim, reverseReceipt } from "@/server/actions/receipts"
import { ReasonDialog } from "@/components/invoices/detail/reason-dialog"
import { ReceiptDialog } from "@/components/invoices/detail/receipt-dialog"
import type { DetailInvoice, PendingClaim, ReceiptContext } from "@/components/invoices/detail/types"

/**
 * A receipt's actions (§7.9.4): Send on WhatsApp (the message with the receipt PDF, downloaded in
 * the same click to attach), its PDF, and reverse it with a reason (a bounced cheque, a wrong
 * entry). Receipts are never deleted; a reversal puts the amount back on the invoice and the
 * status follows.
 */
export function ReceiptActions({ receipt, share }: { receipt: { id: string; number: string; reversed: boolean }; share: DocumentShare | null }) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<"reverse" | null>(null)
  return (
    <span className="inline-flex items-center">
      {share && !receipt.reversed ? <SendDocumentButton share={share} iconOnly label={`Send receipt ${receipt.number} on WhatsApp to`} /> : null}
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
            <DropdownMenuItem onSelect={() => setDialog("reverse")} className="text-danger-text focus:text-danger-text">
              <Undo2Icon aria-hidden="true" />
              Reverse receipt
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
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
    </span>
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

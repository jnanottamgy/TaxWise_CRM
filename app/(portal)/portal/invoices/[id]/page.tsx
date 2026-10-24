import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { DownloadIcon } from "lucide-react"
import { requireClient } from "@/lib/auth/guards"
import { todayIST } from "@/lib/domain/fy"
import { amountInWords, toPaise } from "@/lib/domain/money"
import { claimStatus, invoiceStatus } from "@/lib/domain/portal-copy"
import { stateName } from "@/lib/domain/india-validators"
import { formatDate } from "@/lib/format"
import { getFirmContact, getPortalClient, getPortalInvoiceDetail, payDetailsOf, upiForInvoice, type PortalInvoiceDetail } from "@/lib/data/portal"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { attempt } from "@/components/portal/load"
import { NotLinked, PortalBlockError } from "@/components/portal/portal-ui"
import { PayButton } from "@/components/portal/pay-dialog"

export const metadata: Metadata = { title: "Invoice" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const METHOD_LABEL: Record<string, string> = {
  bank_transfer: "Bank transfer",
  upi: "UPI",
  cheque: "Cheque",
  cash: "Cash",
  card: "Card",
  other: "Other",
}

const CRUMBS = [{ label: "Invoices & payments", href: "/portal/invoices" }]

/**
 * One invoice in the client portal (§7.22 "Invoices: list, PDF download, receipts" and the Pay
 * dialog): "What is this bill for, and how do I pay it?". The link in the invoice email, payment
 * reminders and WhatsApp / Gmail hand-offs lands here ("View & pay"). It shows the invoice as
 * billed (lines with SAC and GST rate, the tax split, the total in words), what has been received,
 * TDS deducted and credit notes, what is still due, the receipts, and Pay (UPI QR, deep link, bank
 * details and "I've paid") while something is due. A reported payment never marks the invoice
 * paid: only a receipt the firm records does. Read through portal_invoices, portal_invoice_items,
 * portal_payment_receipts and portal_credit_notes under the client's own session; another client's
 * invoice, a draft or one held for approval doesn't exist here (404).
 */
export default async function PortalInvoicePage(props: { params: Promise<{ id: string }> }) {
  const { user, supabase } = await requireClient()
  const { id } = await props.params
  if (!UUID.test(id)) notFound()
  const today = todayIST()

  const [client, detail, firm] = await Promise.all([
    attempt("invoice:client", user.id, () => getPortalClient(supabase)),
    attempt("invoice:detail", user.id, () => getPortalInvoiceDetail(supabase, id)),
    attempt("invoice:firm", user.id, () => getFirmContact(supabase)),
  ])

  if (client.ok && !client.data) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={CRUMBS} title="Invoice" />
        <NotLinked />
      </div>
    )
  }
  if (!detail.ok) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={CRUMBS} title="Invoice" />
        <PortalBlockError title="Invoice" message="Couldn't load this invoice." errorRef={detail.ref} />
      </div>
    )
  }
  if (!detail.data) notFound()

  const d = detail.data
  const inv = d.invoice
  const details = firm.ok ? payDetailsOf(firm.data) : null
  const upi = details ? await upiForInvoice(details, inv) : null
  const clientId = client.ok && client.data ? client.data.id : null
  const status = invoiceStatus(inv.displayStatus)
  const kindWord = inv.kind === "debit_note" ? "Debit note" : "Invoice"
  const crumbs = [...CRUMBS, { label: inv.invoiceNumber }]

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <>
            {kindWord} <span className="num tabular-nums">{inv.invoiceNumber}</span>
          </>
        }
        meta={<StatusChip label={status.label} tone={status.tone} meaning={status.meaning} />}
        description={
          <>
            Issued {formatDate(inv.issueDate)}
            {inv.cancelledAt ? null : (
              <>
                {" · "}due <DateText date={inv.dueDate} withRelative={inv.payable} today={today} />
              </>
            )}
            {inv.periodLabel ? ` · ${inv.periodLabel}` : ""}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/portal/invoices/${inv.id}/pdf?download=1`} aria-label={`Download ${kindWord.toLowerCase()} ${inv.invoiceNumber} as a PDF`}>
                <DownloadIcon aria-hidden="true" />
                PDF
              </a>
            </Button>
            {inv.payable && details && clientId ? (
              <PayButton
                invoice={{ id: inv.id, invoiceNumber: inv.invoiceNumber, outstanding: inv.outstanding, dueDate: inv.dueDate, isOverdue: inv.isOverdue, pendingClaim: inv.pendingClaim }}
                details={details}
                upi={upi}
                clientId={clientId}
                today={today}
                size="default"
              />
            ) : null}
          </>
        }
      />

      {inv.payable && !details ? (
        <p className="mb-4 text-sm text-text-muted">Pay isn&apos;t available right now: the firm&apos;s payment details didn&apos;t load. Reload the page, or send us a message.</p>
      ) : null}
      {inv.pendingClaim ? (
        <p className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text" title={claimStatus("pending").meaning}>
          You told us on {formatDate(inv.pendingClaim.reportedAt)} that you paid
          {inv.pendingClaim.paidOn ? ` on ${formatDate(inv.pendingClaim.paidOn)}` : ""}
          {inv.pendingClaim.reference ? ` (reference ${inv.pendingClaim.reference})` : ""}. We&apos;ll confirm once it shows in our bank account.
        </p>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SectionCard title="What it's for" flush>
          <InvoiceBody d={d} />
        </SectionCard>

        <aside className="flex min-w-0 flex-col gap-4" aria-label="Payment">
          <SectionCard title="Payment">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm [&>dd]:pl-6">
              <dt className="text-text-muted">Total</dt>
              <dd className="text-right">
                <Money value={inv.totalAmount} />
              </dd>
              <dt className="text-text-muted">Received</dt>
              <dd className="text-right">
                <Money value={inv.received} />
              </dd>
              {inv.tdsCredited > 0 ? (
                <>
                  <dt className="text-text-muted">TDS you deducted</dt>
                  <dd className="text-right">
                    <Money value={inv.tdsCredited} />
                  </dd>
                </>
              ) : null}
              {inv.creditNoted > 0 ? (
                <>
                  <dt className="text-text-muted">Credit notes</dt>
                  <dd className="text-right">
                    <Money value={inv.creditNoted} />
                  </dd>
                </>
              ) : null}
              <dt className="border-t border-border pt-2 text-base font-semibold text-text">Due now</dt>
              <dd className={inv.isOverdue ? "border-t border-border pt-2 text-right text-base font-semibold text-danger-text" : "border-t border-border pt-2 text-right text-base font-semibold"}>
                {inv.cancelledAt ? <span className="text-text-muted">Nothing</span> : <Money value={inv.outstanding} />}
              </dd>
            </dl>
            {inv.cancelledAt ? <p className="mt-2 text-sm text-text-muted">This invoice was cancelled, so nothing is due on it.</p> : null}
            {!inv.cancelledAt && inv.outstanding <= 0 ? <p className="mt-2 text-sm text-success-text">Paid in full. Thank you.</p> : null}
          </SectionCard>

          <SectionCard title="Receipts" flush>
            {d.receipts.length === 0 ? (
              <EmptyState size="compact" message="No payment recorded yet. When we receive your payment, its receipt appears here." />
            ) : (
              <ul className="divide-y divide-border/70 px-4 pb-2 md:px-5">
                {d.receipts.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="num text-base font-medium text-text tabular-nums">{r.receiptNumber}</p>
                      <p className="text-sm text-text-muted">
                        {formatDate(r.paymentDate)} · {METHOD_LABEL[r.method] ?? r.method}
                        {r.tdsAmount > 0 ? (
                          <>
                            {" · TDS "}
                            <Money value={r.tdsAmount} />
                          </>
                        ) : null}
                      </p>
                      {r.reversed ? <p className="text-xs text-text-muted">Reversed by the firm; it no longer counts towards the invoice.</p> : null}
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1">
                      <Money value={r.amountReceived} className={r.reversed ? "text-text-muted line-through" : "text-text"} />
                      {r.reversed ? null : (
                        <a href={`/api/pdf/receipt/${r.id}?download=1`} className="text-sm text-primary hover:underline" aria-label={`Download receipt ${r.receiptNumber} as a PDF`}>
                          PDF
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {d.creditNotes.length ? (
            <SectionCard title="Credit notes" flush>
              <ul className="divide-y divide-border/70 px-4 pb-2 md:px-5">
                {d.creditNotes.map((c) => (
                  <li key={c.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="num text-base font-medium text-text tabular-nums">{c.number}</p>
                      <p className="text-sm text-text-muted">
                        {formatDate(c.issueDate)}
                        {c.reason ? ` · ${c.reason}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1">
                      <Money value={c.total} className="text-text" />
                      <a href={`/api/pdf/credit-note/${c.id}?download=1`} className="text-sm text-primary hover:underline" aria-label={`Download credit note ${c.number} as a PDF`}>
                        PDF
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <p className="text-sm text-text-muted">
            A question about this invoice?{" "}
            <Link href="/portal/messages" className="text-primary hover:underline">
              Send us a message
            </Link>
            .
          </p>
        </aside>
      </div>
    </div>
  )
}

/** The invoice as billed: to whom, the lines, the tax split and the total in words. */
function InvoiceBody({ d }: { d: PortalInvoiceDetail }) {
  const state = d.placeOfSupplyCode ? stateName(d.placeOfSupplyCode) : null
  const services = d.lines.filter((l) => !l.isReimbursement)
  const reimbursements = d.lines.filter((l) => l.isReimbursement)
  const intra = d.igst === 0 && (d.cgst > 0 || d.sgst > 0)
  return (
    <div className="flex flex-col">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-b border-border px-4 pb-4 text-sm sm:grid-cols-2 md:px-5">
        <div className="min-w-0">
          <dt className="text-text-muted">Billed to</dt>
          <dd className="text-base text-text">{d.billedTo.name ?? "—"}</dd>
          {d.billedTo.address ? <dd className="text-text-muted">{d.billedTo.address}</dd> : null}
          {d.billedTo.gstin ? <dd className="num text-text-muted tabular-nums">GSTIN {d.billedTo.gstin}</dd> : null}
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted">Place of supply</dt>
          <dd className="text-base text-text">{state ? `${state} (${d.placeOfSupplyCode})` : (d.placeOfSupplyCode ?? "—")}</dd>
          {d.firmGstin ? <dd className="num text-text-muted tabular-nums">Our GSTIN {d.firmGstin}</dd> : null}
          {d.reverseCharge ? <dd className="text-text-muted">Tax payable on reverse charge</dd> : null}
        </div>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full text-sm sm:min-w-[32rem]">
          <caption className="sr-only">Invoice lines</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              <th scope="col" className="px-4 py-2 font-medium md:pl-5">Service</th>
              <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">SAC</th>
              <th scope="col" className="hidden px-2 py-2 text-right font-medium sm:table-cell">GST</th>
              <th scope="col" className="px-4 py-2 text-right font-medium md:pr-5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {[...services, ...reimbursements].map((l) => (
              <tr key={l.id} className="border-b border-border/70 align-top last:border-b-0">
                <td className="px-4 py-2.5 text-text md:pl-5">
                  {l.description}
                  {l.quantity !== 1 ? (
                    <span className="block text-xs text-text-muted">
                      <span className="num tabular-nums">{l.quantity}</span> × <Money value={l.rate} />
                    </span>
                  ) : null}
                  <span className="num block text-xs text-text-muted tabular-nums sm:hidden">
                    SAC {l.sacCode ?? "—"} · GST {l.isReimbursement ? "—" : `${l.taxRate}%`}
                  </span>
                </td>
                <td className="num hidden px-2 py-2.5 text-text-muted tabular-nums sm:table-cell">{l.sacCode ?? "—"}</td>
                <td className="num hidden px-2 py-2.5 text-right text-text-muted tabular-nums sm:table-cell">{l.isReimbursement ? "—" : `${l.taxRate}%`}</td>
                <td className="px-4 py-2.5 text-right md:pr-5">
                  <Money value={l.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-y-1.5 border-t border-border px-4 py-3 text-sm md:px-5 [&>dd]:pl-6">
        <dt className="text-text-muted">Taxable value</dt>
        <dd className="text-right">
          <Money value={d.taxable} />
        </dd>
        {intra ? (
          <>
            <dt className="text-text-muted">CGST</dt>
            <dd className="text-right">
              <Money value={d.cgst} />
            </dd>
            <dt className="text-text-muted">SGST</dt>
            <dd className="text-right">
              <Money value={d.sgst} />
            </dd>
          </>
        ) : (
          <>
            <dt className="text-text-muted">IGST</dt>
            <dd className="text-right">
              <Money value={d.igst} />
            </dd>
          </>
        )}
        {d.reimbursement > 0 ? (
          <>
            <dt className="text-text-muted">Reimbursements</dt>
            <dd className="text-right">
              <Money value={d.reimbursement} />
            </dd>
          </>
        ) : null}
        {d.roundOff !== 0 ? (
          <>
            <dt className="text-text-muted">Round off</dt>
            <dd className="text-right">
              <Money value={d.roundOff} />
            </dd>
          </>
        ) : null}
        <dt className="border-t border-border pt-2 text-base font-semibold text-text">Total</dt>
        <dd className="border-t border-border pt-2 text-right text-base font-semibold">
          <Money value={d.invoice.totalAmount} />
        </dd>
        <dd className="col-span-2 !pl-0 text-xs text-text-muted">{amountInWords(toPaise(d.invoice.totalAmount))}</dd>
      </dl>

      {d.notes || d.terms || d.irn ? (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-sm text-text-muted md:px-5">
          {d.notes ? <p className="whitespace-pre-line">{d.notes}</p> : null}
          {d.terms ? <p className="whitespace-pre-line">{d.terms}</p> : null}
          {d.irn ? <p className="font-mono text-xs break-all">IRN {d.irn}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

import { headers } from "next/headers"
import { notFound, unstable_rethrow } from "next/navigation"
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, ClockIcon, DownloadIcon, EyeIcon, ReplaceIcon } from "lucide-react"
import { logUnexpected } from "@/lib/log"
import { formatDate, formatDateTime } from "@/lib/format"
import { formatINR } from "@/lib/domain/money"
import { EXPIRED_MESSAGE, SUPERSEDED_MESSAGE, quotationTotals } from "@/lib/schemas/quotations"
import { toDocumentFirm } from "@/lib/data/quotations"
import { clientIp, loadPublicQuotation, recordPublicView, type PublicQuotation } from "@/server/quotations-public"
import { Button } from "@/components/ui/button"
import { QuotationDocumentView } from "@/components/quotations/quotation-document"
import { RespondPanel } from "@/components/quotations/public/respond-panel"
import { PublicNotice } from "@/components/quotations/public/public-notice"
import { respondToQuotation } from "./actions"

type Params = { params: Promise<{ token: string }> }

/**
 * The client's quotation (§7.23): no login, read-only, the same layout as the PDF, with Download PDF.
 * Accept (full name + optional note) or Decline (reason) while it is Sent or Viewed and within its
 * date; otherwise the right message instead of the buttons: accepted, declined, expired ("This
 * quotation has expired. Contact TaxWise for an updated one.") or replaced by a revision ("This
 * quotation has been replaced by a newer version"). Every view is recorded (rate-limited). Reads
 * only through server/quotations-public.ts. Someone signed in to the firm's app sees a preview: not
 * counted, and no buttons.
 */
export default async function PublicQuotationPage({ params }: Params) {
  const { token } = await params

  let data: PublicQuotation | null
  try {
    data = await loadPublicQuotation(token)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/q/[token]" })
    return (
      <PublicNotice tone="danger" icon={<CircleAlertIcon className="text-danger-text" />} title="This quotation didn't load">
        Something went wrong on our side. Please try again in a few minutes. If it keeps happening, contact TaxWise and quote Ref <span className="font-mono text-[13px]">{ref}</span>.
      </PublicNotice>
    )
  }
  if (!data) notFound()

  const h = await headers()
  await recordPublicView(token, clientIp(h))

  const firm = toDocumentFirm(data.firm)
  const { doc, state } = data
  const totals = quotationTotals(
    doc.lines.map((l) => ({ quantity: l.quantity, unit_price: l.unitPrice, tax_rate: l.taxRate })),
    doc.recipient.placeOfSupplyCode,
    firm.stateCode,
  )
  const total = formatINR(totals.totalPaise)
  const contact = [data.firm.phone, data.firm.email].filter(Boolean).join(" or ")
  const pdfHref = `/q/${token}/pdf`

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      {data.staffPreview ? (
        <PublicNotice tone="info" icon={<EyeIcon className="text-info-text" />} title="Preview: you're signed in to TaxWise">
          This is what the client sees. Your visit isn&apos;t counted as a view, and only the client can accept or decline.
        </PublicNotice>
      ) : null}

      {state.kind === "accepted" ? (
        <PublicNotice tone="success" icon={<CircleCheckIcon className="text-success-text" />} title="Accepted">
          This quotation was accepted electronically{state.acceptedByName ? ` by ${state.acceptedByName}` : ""}
          {state.respondedAt ? ` on ${formatDateTime(state.respondedAt)}` : ""}. Thank you; we&apos;ll be in touch to get started.
        </PublicNotice>
      ) : state.kind === "declined" ? (
        <PublicNotice tone="muted" icon={<CircleXIcon className="text-text-muted" />} title="Declined">
          This quotation was declined{state.respondedAt ? ` on ${formatDateTime(state.respondedAt)}` : ""}. If something has changed, contact us{contact ? ` on ${contact}` : ""} for an updated one.
        </PublicNotice>
      ) : state.kind === "expired" ? (
        <PublicNotice tone="muted" icon={<ClockIcon className="text-text-muted" />} title="Expired">
          {EXPIRED_MESSAGE}
          {contact ? ` You can reach us on ${contact}.` : ""}
        </PublicNotice>
      ) : state.kind === "superseded" ? (
        <PublicNotice tone="muted" icon={<ReplaceIcon className="text-text-muted" />} title="Replaced">
          {SUPERSEDED_MESSAGE}. Please use the link in our latest email{contact ? `, or contact us on ${contact}` : ""}.
        </PublicNotice>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl leading-8 font-semibold text-text">Quotation {doc.number}</h1>
          <p className="text-base text-text-muted">
            For {doc.recipient.company || doc.recipient.name} · {total} including GST · valid until {formatDate(doc.validUntil)}
          </p>
        </div>
        <Button asChild variant="outline" size="lg" className="flex-none">
          <a href={`${pdfHref}?download=1`} download>
            <DownloadIcon aria-hidden="true" />
            Download PDF
          </a>
        </Button>
      </div>

      {state.kind === "open" && !data.staffPreview ? (
        <RespondPanel token={token} number={doc.number} total={total} validUntil={formatDate(doc.validUntil)} respond={respondToQuotation} />
      ) : null}

      <QuotationDocumentView doc={doc} firm={firm} />

      {state.kind === "open" && !data.staffPreview ? (
        <p className="text-sm text-text-muted">
          Questions about the scope or the fees? {contact ? `Contact us on ${contact}.` : "Reply to our email."} Accept or decline above when you&apos;re ready.
        </p>
      ) : null}
    </div>
  )
}

import { cn } from "@/lib/utils"
import { formatDate, formatDateTime, formatNumber } from "@/lib/format"
import { formatINR, toPaise } from "@/lib/domain/money"
import { lineMeta, placeOfSupplyLabel, quotationTotals, recipientHeading, totalRows, type DocumentFirm, type QuotationDocument } from "@/lib/schemas/quotations"

/**
 * The quotation as a page, in the same layout as its PDF (§7.5.3; §7.23 "TaxWise-branded, read-only
 * quotation (same layout as the PDF)"): the letterhead, QUOTATION with number, issue date,
 * valid-until and prepared-by, Prepared for, the lines, totals with the CGST/SGST or IGST split, the
 * total in words, notes, terms and the acceptance block. Used on the quotation page and on the
 * client's link. Server-safe; the table scrolls inside itself on a phone.
 */
export function QuotationDocumentView({ doc, firm, className }: { doc: QuotationDocument; firm: DocumentFirm; className?: string }) {
  const totals = quotationTotals(
    doc.lines.map((l) => ({ quantity: l.quantity, unit_price: l.unitPrice, tax_rate: l.taxRate })),
    doc.recipient.placeOfSupplyCode,
    firm.stateCode,
  )
  const who = recipientHeading(doc.recipient)
  const contact = [firm.phone, firm.email, firm.website?.replace(/^https?:\/\//i, "").replace(/\/+$/, "")].filter(Boolean).join("  ·  ")
  const meta: Array<[string, string]> = [
    ["Quotation no.", doc.number],
    ["Issue date", formatDate(doc.issueDate)],
    ["Valid until", formatDate(doc.validUntil)],
    ...(doc.preparedBy ? ([["Prepared by", doc.preparedBy]] as Array<[string, string]>) : []),
    ...(doc.revisionNumber > 0 ? ([["Revision", doc.revisesNumber ? `${doc.revisionNumber}, replaces ${doc.revisesNumber}` : String(doc.revisionNumber)]] as Array<[string, string]>) : []),
  ]

  return (
    <article aria-label={`Quotation ${doc.number}`} className={cn("rounded-lg border border-border bg-surface px-4 py-5 md:px-8 md:py-7", className)}>
      <header className="flex flex-col gap-4 border-b-2 border-brand-navy pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {firm.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the firm's logo from the public branding bucket
            <img src={firm.logoUrl} alt="" className="h-10 max-w-28 flex-none object-contain" />
          ) : null}
          <div className="min-w-0">
            <p className="text-lg leading-6 font-semibold text-brand-navy dark:text-text">{firm.legalName ?? firm.firmName}</p>
            {firm.tagline ? <p className="text-sm text-text-muted">{firm.tagline}</p> : null}
            {firm.addressLine ? <p className="mt-1 text-sm text-text">{firm.addressLine}</p> : null}
            {contact ? <p className="text-sm text-text-muted">{contact}</p> : null}
            {firm.gstin ? <p className="text-sm text-text">GSTIN {firm.gstin}</p> : null}
          </div>
        </div>
        <div className="flex-none sm:text-right">
          <p className="text-lg leading-6 font-bold tracking-wide text-brand-navy dark:text-text">QUOTATION</p>
          <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-sm sm:justify-end">
            {meta.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-text-muted">{k}</dt>
                <dd className={cn("text-text", k === "Quotation no." ? "font-mono text-[13px]" : "num tabular-nums")}>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <section aria-labelledby={`${doc.id}-for`} className="mt-5">
        <h2 id={`${doc.id}-for`} className="text-sm font-semibold text-text-muted">
          Prepared for
        </h2>
        <p className="mt-1 text-md font-semibold text-text">{who.primary}</p>
        {who.secondary ? <p className="text-base text-text">{who.secondary}</p> : null}
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {[
            ["Email", doc.recipient.email],
            ["Phone", doc.recipient.phone],
            ["GSTIN", doc.recipient.gstin],
            ["Place of supply", placeOfSupplyLabel(doc.recipient.placeOfSupplyCode)],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-text-muted">{k}</dt>
              <dd className={cn("break-words", v ? "text-text" : "text-text-muted", k === "GSTIN" && v ? "font-mono text-[13px]" : undefined)}>{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* On a phone each line stacks: description, then quantity × price and GST, with the amount beside it. */}
      <ul aria-label="Services quoted" className="mt-5 border-y border-border sm:hidden">
        {doc.lines.map((l, i) => {
          const m = lineMeta(l.serviceType, l.frequency)
          return (
            <li key={i} className="flex items-start justify-between gap-3 border-b border-border/70 py-2.5 last:border-b-0">
              <div className="min-w-0">
                <p className="text-base text-text">{l.description}</p>
                {m ? <p className="text-sm text-text-muted">{m}</p> : null}
                <p className="num text-sm text-text-muted tabular-nums">
                  {formatNumber(l.quantity, { maxDecimals: 2 })} × {formatINR(toPaise(l.unitPrice))} · GST {formatNumber(l.taxRate, { maxDecimals: 2 })}%
                </p>
              </div>
              <p className="num flex-none text-base text-text tabular-nums">{formatINR(totals.lines[i]?.amountPaise ?? 0)}</p>
            </li>
          )
        })}
      </ul>

      <div className="relative mt-5 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[34rem] text-base">
          <caption className="sr-only">Services quoted</caption>
          <thead>
            <tr className="border-y border-border bg-surface-2 text-left text-sm text-text-muted">
              <th scope="col" className="w-8 px-2 py-2 font-normal">#</th>
              <th scope="col" className="px-2 py-2 font-normal">Description</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Qty</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Unit price</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">GST</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => {
              const m = lineMeta(l.serviceType, l.frequency)
              return (
                <tr key={i} className="border-b border-border/70 align-top">
                  <td className="num px-2 py-2 text-text-muted tabular-nums">{i + 1}</td>
                  <td className="px-2 py-2">
                    <span className="block text-text">{l.description}</span>
                    {m ? <span className="block text-sm text-text-muted">{m}</span> : null}
                  </td>
                  <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(l.quantity, { maxDecimals: 2 })}</td>
                  <td className="num px-2 py-2 text-right tabular-nums">{formatINR(toPaise(l.unitPrice))}</td>
                  <td className="num px-2 py-2 text-right tabular-nums">{formatNumber(l.taxRate, { maxDecimals: 2 })}%</td>
                  <td className="num px-2 py-2 text-right tabular-nums">{formatINR(totals.lines[i]?.amountPaise ?? 0)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-col-reverse gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 md:max-w-[52%]">
          <p className="text-sm text-text-muted">Amount in words</p>
          <p className="text-base font-medium text-text">{totals.words}</p>
          <p className="mt-1 text-sm text-text-muted">
            {totals.intraState
              ? `Supply within ${placeOfSupplyLabel(doc.recipient.placeOfSupplyCode)}: CGST and SGST apply.`
              : `Supply to ${placeOfSupplyLabel(doc.recipient.placeOfSupplyCode)}: IGST applies.`}
          </p>
        </div>
        <dl className="w-full md:w-[40%]">
          {totalRows(totals).map((r) => (
            <div key={r.label} className={cn("flex items-baseline justify-between gap-4 border-b border-border/70 py-1.5 last:border-b-0", r.emphasis && "border-t border-text pt-2")}>
              <dt className={cn("text-sm", r.emphasis ? "font-semibold text-text" : "text-text-muted")}>{r.label}</dt>
              <dd className={cn("num text-right tabular-nums", r.emphasis ? "text-md font-semibold text-text" : "text-base text-text")}>{formatINR(r.paise)}</dd>
            </div>
          ))}
        </dl>
      </div>

      {doc.notes ? (
        <section className="mt-5">
          <h2 className="text-sm font-semibold text-text-muted">Notes</h2>
          <p className="mt-1 text-sm whitespace-pre-line text-text">{doc.notes}</p>
        </section>
      ) : null}
      {doc.terms ? (
        <section className="mt-5">
          <h2 className="text-sm font-semibold text-text-muted">Terms</h2>
          <p className="mt-1 text-sm whitespace-pre-line text-text">{doc.terms}</p>
        </section>
      ) : null}

      <footer className="mt-6 grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold text-text-muted">Acceptance</h2>
          {doc.acceptance ? (
            <p className="mt-1 text-base text-text">
              Accepted electronically by <span className="font-semibold">{doc.acceptance.name}</span>
              {doc.acceptance.at ? ` on ${formatDateTime(doc.acceptance.at)}` : ""}.
            </p>
          ) : (
            <p className="mt-1 text-sm text-text-muted">Not accepted yet.</p>
          )}
        </div>
        <div className="sm:text-right">
          <p className="text-base font-semibold text-text">For {firm.legalName ?? firm.firmName}</p>
          {doc.preparedBy ? <p className="mt-4 text-base text-text">{doc.preparedBy}</p> : null}
          <p className="text-sm text-text-muted">Authorised Signatory</p>
        </div>
      </footer>
      <p className="mt-5 text-xs text-text-muted">{firm.firmName} · Powered by J-TACS</p>
    </article>
  )
}

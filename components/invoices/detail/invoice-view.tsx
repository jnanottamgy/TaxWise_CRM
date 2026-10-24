import Link from "next/link"
import { cn } from "@/lib/utils"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { DefinitionList } from "@/components/app/definition-list"
import { amountInWords, fromPaise, toPaise } from "@/lib/domain/money"
import { SERVICE_TYPE_LABELS, isEnumValue } from "@/lib/domain/enums"
import type { InvoiceItemRow, InvoiceRow } from "@/lib/data/invoices"
import { stateLabel } from "@/components/invoices/invoice-ui"

/**
 * The invoice as the client will read it (§6.4 Rule 46, §7.9.3), on screen: who it is to, the
 * invoice facts, each line with its SAC and GST rate, the totals split CGST + SGST (intra-state) or
 * IGST (inter-state), reimbursements outside the taxable value, round-off, and the total in words.
 * Issued invoices show their frozen snapshots; drafts show the client as it is now. Server-safe.
 */
export function InvoiceView({
  invoice,
  items,
  recipient,
  firmStateCode,
  today,
}: {
  invoice: InvoiceRow
  items: InvoiceItemRow[]
  recipient: { name: string; address: string | null; gstin: string | null; stateCode: string | null; registered: boolean }
  firmStateCode: string
  today: string
}) {
  const intra = invoice.place_of_supply_code === firmStateCode
  const taxedRates = [...new Set(items.filter((i) => !i.is_reimbursement && Number(i.tax_rate) > 0).map((i) => Number(i.tax_rate)))]
  const oneRate = taxedRates.length === 1 ? taxedRates[0] : null
  const half = (r: number) => `${Number((r / 2).toFixed(2))}%`
  const totalPaise = toPaise(invoice.total_amount)
  const roundOff = Number(invoice.round_off)
  const unissued = invoice.status === "draft" || invoice.status === "awaiting_approval"

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 border-b border-border px-4 py-4 md:grid-cols-2 md:px-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-muted">Bill to</p>
          <p className="mt-1 text-base font-medium text-text">{recipient.name || <span className="text-text-muted">No name</span>}</p>
          {recipient.address ? <p className="mt-0.5 text-sm whitespace-pre-line text-text-muted">{recipient.address}</p> : <p className="mt-0.5 text-sm text-warning-text">No address on file</p>}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm">
            {recipient.gstin ? (
              <>
                <span className="text-text-muted">GSTIN</span>
                <MonoId value={recipient.gstin} copy label="GSTIN" />
              </>
            ) : recipient.registered ? (
              <span className="text-danger-text">GSTIN missing</span>
            ) : (
              <span className="text-text-muted">Unregistered (B2C)</span>
            )}
          </p>
          {unissued ? <p className="mt-1.5 text-xs text-text-muted">From the client record now; frozen when the invoice is issued.</p> : null}
        </div>
        <DefinitionList
          items={[
            { term: "Invoice date", value: <DateText date={invoice.issue_date} today={today} /> },
            { term: "Due date", value: <DateText date={invoice.due_date} today={today} /> },
            { term: "Billing period", value: invoice.billing_period_label },
            {
              term: "Place of supply",
              value: (
                <span>
                  {stateLabel(invoice.place_of_supply_code)}
                  {invoice.place_of_supply_reason ? <span className="block text-xs text-text-muted">Changed: {invoice.place_of_supply_reason}</span> : null}
                </span>
              ),
            },
            { term: "Reverse charge", value: invoice.reverse_charge ? "Yes" : "No" },
            ...(invoice.signatory_name ? [{ term: "Signed by", value: invoice.signatory_name }] : []),
          ]}
        />
      </div>

      {/* Phones: one row per line, the amount on the right (a seven-column table can't fit 390px). */}
      <ul aria-label="Invoice lines" className="border-b border-border md:hidden">
        {items.map((i, n) => (
          <li key={i.id} className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3 last:border-b-0">
            <div className="min-w-0 text-sm">
              <p className="text-text">
                <span className="num text-text-muted">{n + 1}. </span>
                <span className="whitespace-pre-line">{i.description}</span>
              </p>
              {i.service_type && isEnumValue("service_type", i.service_type) ? <p className="text-xs text-text-muted">{SERVICE_TYPE_LABELS[i.service_type]}</p> : null}
              <p className="num mt-0.5 text-xs text-text-muted">
                SAC {i.sac_code} · {Number(i.quantity)} × <Money value={i.rate} /> · {i.is_reimbursement ? "Reimbursement, no GST" : `GST ${Number(i.tax_rate)}%`}
              </p>
              {i.tax_rate_reason ? <p className="text-xs text-text-muted">GST rate: {i.tax_rate_reason}</p> : null}
              {i.time_entry_ids.length ? <p className="text-xs text-text-muted">{i.time_entry_ids.length} time {i.time_entry_ids.length === 1 ? "entry" : "entries"}</p> : null}
            </div>
            <Money value={i.amount} className="flex-none text-sm text-text" />
          </li>
        ))}
      </ul>

      {/* `relative` keeps the sr-only caption inside the scroller, so it can't widen the page. */}
      <div className="relative hidden overflow-x-auto md:block">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Invoice lines</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium text-text-muted">
              <th scope="col" className="w-10 px-4 py-2 font-medium md:pl-5">
                #
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Description
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                SAC
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Rate
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                GST
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium md:pr-5">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => (
              <tr key={i.id} className="border-b border-border/70 align-top">
                <td className="num px-4 py-2.5 text-text-muted tabular-nums md:pl-5">{n + 1}</td>
                <td className="px-2 py-2.5 text-text">
                  <span className="whitespace-pre-line">{i.description}</span>
                  {i.service_type && isEnumValue("service_type", i.service_type) ? <span className="block text-xs text-text-muted">{SERVICE_TYPE_LABELS[i.service_type]}</span> : null}
                  {i.tax_rate_reason ? <span className="block text-xs text-text-muted">GST rate: {i.tax_rate_reason}</span> : null}
                  {i.time_entry_ids.length ? <span className="block text-xs text-text-muted">{i.time_entry_ids.length} time {i.time_entry_ids.length === 1 ? "entry" : "entries"}</span> : null}
                </td>
                <td className="num px-2 py-2.5 text-text tabular-nums">{i.sac_code}</td>
                <td className="num px-2 py-2.5 text-right text-text tabular-nums">{Number(i.quantity)}</td>
                <td className="px-2 py-2.5 text-right">
                  <Money value={i.rate} />
                </td>
                <td className="num px-2 py-2.5 text-right text-text tabular-nums">{i.is_reimbursement ? <span className="text-text-muted">Reimb.</span> : `${Number(i.tax_rate)}%`}</td>
                <td className="px-4 py-2.5 text-right md:pr-5">
                  <Money value={i.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-6 px-4 py-4 md:grid-cols-[minmax(0,1fr)_20rem] md:px-5">
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <p className="text-text">
            <span className="text-text-muted">In words: </span>
            {amountInWords(totalPaise)}
          </p>
          {invoice.notes ? (
            <div>
              <p className="text-xs font-medium text-text-muted">Notes</p>
              <p className="whitespace-pre-line text-text">{invoice.notes}</p>
            </div>
          ) : null}
          {invoice.terms ? (
            <div>
              <p className="text-xs font-medium text-text-muted">Terms</p>
              <p className="whitespace-pre-line text-text">{invoice.terms}</p>
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 self-start text-sm">
          <dt className="text-text-muted">Taxable value</dt>
          <dd className="text-right">
            <Money value={invoice.taxable_amount} />
          </dd>
          {intra ? (
            <>
              <dt className="text-text-muted">CGST{oneRate !== null ? ` ${half(oneRate)}` : ""}</dt>
              <dd className="text-right">
                <Money value={invoice.cgst_amount} />
              </dd>
              <dt className="text-text-muted">SGST{oneRate !== null ? ` ${half(oneRate)}` : ""}</dt>
              <dd className="text-right">
                <Money value={invoice.sgst_amount} />
              </dd>
            </>
          ) : (
            <>
              <dt className="text-text-muted">IGST{oneRate !== null ? ` ${oneRate}%` : ""}</dt>
              <dd className="text-right">
                <Money value={invoice.igst_amount} />
              </dd>
            </>
          )}
          {Number(invoice.reimbursement_amount) > 0 ? (
            <>
              <dt className="text-text-muted">Reimbursements (no GST)</dt>
              <dd className="text-right">
                <Money value={invoice.reimbursement_amount} />
              </dd>
            </>
          ) : null}
          {roundOff !== 0 ? (
            <>
              <dt className="text-text-muted">Round off</dt>
              <dd className="text-right">
                <Money value={roundOff} />
              </dd>
            </>
          ) : null}
          <dt className="border-t border-border pt-2 text-base font-semibold text-text">Total</dt>
          <dd className="border-t border-border pt-2 text-right text-base font-semibold">
            <Money value={fromPaise(totalPaise)} />
          </dd>
        </dl>
      </div>
    </div>
  )
}

/** "Reissue of TW/26-27/0041", "Debit note against …": links between related invoices. */
export function RelatedLink({ id, number, kind, cancelled }: { id: string; number: string | null; kind?: string; cancelled?: boolean }) {
  return (
    <Link href={`/invoices/${id}`} className={cn("inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline", cancelled && "line-through decoration-text-muted")}>
      {number ?? (kind === "debit_note" ? "draft debit note" : "draft invoice")}
    </Link>
  )
}

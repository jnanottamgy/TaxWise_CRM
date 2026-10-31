import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FileTextIcon, PlusIcon } from "lucide-react"
import type { ClientTabProps } from "@/components/client360/types"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { getSelectedFy } from "@/lib/fy-context"
import { fyEnd, fyStart, todayIST } from "@/lib/domain/fy"
import { fromPaise, toPaise } from "@/lib/domain/money"
import { formatDate, pdfFileName } from "@/lib/format"
import { CREDIT_NOTE_REASON_LABELS, PAYMENT_METHOD_LABELS, isEnumValue } from "@/lib/domain/enums"
import { TDS_STATUS_LABEL } from "@/lib/schemas/receipts"
import { listInvoices, type InvoiceListFilter, type InvoiceListRow } from "@/lib/data/invoices"
import type { InvoiceListSort } from "@/lib/schemas/invoices"
import { getClientTdsSummary, listClientReceipts, type ClientReceiptRow, type TdsCreditSummaryRow } from "@/lib/data/receipts"
import { documentShare, getShareContextOrNull } from "@/lib/data/document-share"
import { listClientCreditNotes, type ClientCreditNoteRow } from "@/lib/data/credit-notes"
import type { TableParams } from "@/components/app/data-table/params"
import { KpiStrip } from "@/components/app/kpi-strip"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { Button } from "@/components/ui/button"
import { InvoiceStatusCell } from "@/components/invoices/invoices-table"
import { SendDocumentButton } from "@/components/comms/send-document"

/**
 * Client 360 → Billing (§7.3.3, §7.9): what the client owes and is overdue (all years), what was
 * invoiced and received in the selected FY, the latest invoices, receipts and credit notes, the TDS
 * the client deducted by quarter (§7.9.9), and the statement of account (opened, or sent to the
 * client on WhatsApp with the PDF to attach, §7.13.2). New invoice starts one for this client.
 * Partners and Managers only (§4.1): an Employee never gets a figure from here, and RLS returns
 * nothing to them anyway. Never throws: each block shows its own Ref.
 */

const ISSUED = ["sent", "partially_paid", "paid", "disputed", "waived"]
const OPEN = ["sent", "partially_paid", "disputed"]

function tableParams(filters: Partial<Record<InvoiceListFilter, string[]>> = {}): TableParams<InvoiceListSort, InvoiceListFilter> {
  return { page: 1, pageSize: 25, sort: "issue_date", dir: "desc", q: "", filters, from: 0, to: 9 }
}

type Load<T> = { ok: true; data: T } | { ok: false; ref: string }

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<Load<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `tab:client-billing:${source}`, userId }) }
  }
}

export default async function ClientBillingTab({ clientId, user, supabase }: ClientTabProps) {
  if (!can.seeMoney(user.role)) {
    return <EmptyState message="Billing is for Partners and Managers." />
  }
  const today = todayIST()
  const fy = await getSelectedFy()
  const listUrl = (q: string) => `/invoices?client=${clientId}&${q}`

  const [recent, open, overdue, issuedFy, receipts, credits, tds, shareCtx] = await Promise.all([
    attempt("invoices", user.id, () => listInvoices(supabase, tableParams(), { fy: null, clientId, limit: 10, offset: 0, today })),
    attempt("open", user.id, () => listInvoices(supabase, tableParams({ status: OPEN }), { fy: null, clientId, limit: 1, offset: 0, today })),
    attempt("overdue", user.id, () => listInvoices(supabase, tableParams({ status: ["overdue"] }), { fy: null, clientId, limit: 1, offset: 0, today })),
    attempt("fy", user.id, () => listInvoices(supabase, tableParams({ status: ISSUED }), { fy, clientId, limit: 1, offset: 0, today })),
    attempt("receipts", user.id, () => listClientReceipts(supabase, clientId, { limit: 10 })),
    attempt("credit-notes", user.id, () => listClientCreditNotes(supabase, clientId, { limit: 10 })),
    attempt("tds", user.id, () => getClientTdsSummary(supabase, clientId)),
    getShareContextOrNull(supabase, user, clientId, { source: "tab:client-billing:share" }),
  ])

  const statementTo = fyEnd(fy) < today ? fyEnd(fy) : today
  const statementHref = `/api/pdf/statement/client/${clientId}?from=${fyStart(fy)}&to=${statementTo}`
  // A statement is about fees, so the hand-off is money-side ("fee_…", money_side_kind 0043): Employees never see it.
  const statementShare = shareCtx
    ? documentShare(shareCtx, {
        draft: (first) =>
          [
            `${first ? `Hi ${first}` : "Hello"}, please find your statement of account with ${shareCtx.messaging.firmName} from ${formatDate(fyStart(fy))} to ${formatDate(statementTo)}: every invoice, payment and credit note in the period.`,
            "Please check it against your books and tell us if anything doesn't match. If you deducted TDS, please send us the TDS certificates (Form 16A).",
          ].join("\n\n"),
        values: { period: `FY ${fy}` },
        templateTypes: ["custom"],
        attachment: { href: `${statementHref}&download=1`, filename: pdfFileName(`${shareCtx.client.code ?? ""} ${fyStart(fy)} to ${statementTo}`, "Statement") },
        related: { type: "fee_statement", id: clientId },
      })
    : null
  const kpiRef = [open, overdue, issuedFy].find((r) => !r.ok) as { ok: false; ref: string } | undefined

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">Outstanding and overdue across all years; invoiced and received for FY {fy}.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <a href={statementHref} target="_blank" rel="noopener">
              <FileTextIcon aria-hidden="true" />
              Statement of account
            </a>
          </Button>
          {statementShare ? <SendDocumentButton share={statementShare} label="Send statement on WhatsApp" size="default" /> : null}
          <Button asChild>
            <Link href={`/invoices/new?client=${clientId}`}>
              <PlusIcon aria-hidden="true" />
              New invoice
            </Link>
          </Button>
        </div>
      </div>

      {kpiRef ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the billing figures." errorRef={kpiRef.ref} />
        </div>
      ) : open.ok && overdue.ok && issuedFy.ok ? (
        <KpiStrip
          lead
          aria-label="Billing figures"
          items={[
            {
              label: "Outstanding",
              value: <Money value={fromPaise(toPaise(open.data.totals.outstanding))} />,
              sub: open.data.total ? `${open.data.total} open ${open.data.total === 1 ? "invoice" : "invoices"}` : "Nothing due",
              href: listUrl("status=sent,partially_paid,disputed&fy=all"),
            },
            {
              label: "Overdue",
              value: <Money value={fromPaise(toPaise(overdue.data.totals.outstanding))} />,
              sub: overdue.data.total ? `${overdue.data.total} past the due date` : "None overdue",
              href: listUrl("status=overdue&fy=all"),
            },
            {
              label: `Invoiced in ${fy}`,
              value: <Money value={fromPaise(toPaise(issuedFy.data.totals.total))} />,
              sub: `${issuedFy.data.total} issued`,
              href: listUrl(`fy=${fy}`),
            },
            {
              label: `Received in ${fy}`,
              value: <Money value={fromPaise(toPaise(issuedFy.data.totals.received))} />,
              sub: Number(issuedFy.data.totals.tds) > 0 ? (
                <>
                  + <Money value={fromPaise(toPaise(issuedFy.data.totals.tds))} /> TDS
                </>
              ) : (
                "On this year's invoices"
              ),
            },
          ]}
        />
      ) : null}

      <SectionCard title="Invoices" description="The latest ten, all years." viewAll={{ href: listUrl("fy=all"), label: "View all" }} flush>
        {!recent.ok ? (
          <ErrorBlock message="Couldn't load the invoices." errorRef={recent.ref} />
        ) : recent.data.rows.length === 0 ? (
          <EmptyState size="compact" message="No invoices for this client yet." />
        ) : (
          <InvoiceRows rows={recent.data.rows} today={today} />
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Receipts" description="The latest ten." flush>
          {!receipts.ok ? (
            <ErrorBlock message="Couldn't load the receipts." errorRef={receipts.ref} />
          ) : receipts.data.length === 0 ? (
            <EmptyState size="compact" message="No payments recorded for this client yet." />
          ) : (
            <ReceiptRows rows={receipts.data} today={today} />
          )}
        </SectionCard>

        <SectionCard title="TDS credits" description="TDS the client deducted, by quarter. Check it against 26AS / AIS." flush>
          {!tds.ok ? (
            <ErrorBlock message="Couldn't load the TDS credits." errorRef={tds.ref} />
          ) : tds.data.rows.length === 0 ? (
            <EmptyState size="compact" message="The client hasn't deducted TDS on any payment." />
          ) : (
            <TdsRows rows={tds.data.rows} totalPaise={tds.data.totalPaise} />
          )}
        </SectionCard>
      </div>

      <SectionCard title="Credit notes" flush>
        {!credits.ok ? (
          <ErrorBlock message="Couldn't load the credit notes." errorRef={credits.ref} />
        ) : credits.data.length === 0 ? (
          <EmptyState size="compact" message="No credit notes for this client." />
        ) : (
          <CreditRows rows={credits.data} today={today} />
        )}
      </SectionCard>
    </div>
  )
}

function InvoiceRows({ rows, today }: { rows: InvoiceListRow[]; today: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">The client&apos;s latest invoices</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th scope="col" className="px-4 py-2 font-medium md:pl-5">Invoice</th>
            <th scope="col" className="px-2 py-2 font-medium">Date</th>
            <th scope="col" className="px-2 py-2 font-medium">Status</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Total</th>
            <th scope="col" className="px-4 py-2 text-right font-medium md:pr-5">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = !r.cancelled_at && (r.status === "sent" || r.status === "partially_paid" || r.status === "disputed")
            return (
              <tr key={r.id} className="border-b border-border/70 align-top last:border-b-0 hover:bg-surface-2/60">
                <td className="px-4 py-2.5 md:pl-5">
                  <Link href={`/invoices/${r.id}`} className="font-medium text-text underline-offset-4 hover:underline">
                    {r.invoice_number ? <MonoId value={r.invoice_number} /> : <span className="text-text-muted">{r.invoice_kind === "debit_note" ? "Draft debit note" : "Draft"}</span>}
                  </Link>
                  {r.billing_period_label ? <span className="block text-xs text-text-muted">{r.billing_period_label}</span> : null}
                </td>
                <td className="px-2 py-2.5 text-text">
                  <DateText date={r.issue_date} today={today} />
                  <span className="block text-xs text-text-muted">
                    Due <DateText date={r.due_date} today={today} />
                  </span>
                </td>
                <td className="px-2 py-2.5">
                  <InvoiceStatusCell row={r} />
                </td>
                <td className="px-2 py-2.5 text-right">
                  <Money value={r.total_amount} />
                </td>
                <td className="px-4 py-2.5 text-right md:pr-5">
                  {/* A paid invoice owes a real zero; a draft or cancelled one owes nothing yet (em dash, §3.4). */}
                  {open ? <Money value={r.outstanding_amount} /> : r.status === "paid" && !r.cancelled_at ? <Money value={0} className="text-text-muted" /> : <span className="text-text-muted" aria-label="Not applicable">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ReceiptRows({ rows, today }: { rows: ClientReceiptRow[]; today: string }) {
  return (
    <ul className="flex flex-col">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-2.5 last:border-b-0 md:px-5">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 text-base text-text">
              <a href={`/api/pdf/receipt/${r.id}`} target="_blank" rel="noopener" className="underline-offset-4 hover:underline" aria-label={`Receipt ${r.receipt_number} PDF`}>
                <MonoId value={r.receipt_number} />
              </a>
              <span className="text-sm text-text-muted">
                <DateText date={r.payment_date} today={today} />
              </span>
            </p>
            <p className="text-sm text-text-muted">
              {isEnumValue("payment_method", r.method) ? PAYMENT_METHOD_LABELS[r.method] : r.method}
              {r.invoice_number ? (
                <>
                  {" · "}
                  <Link href={`/invoices/${r.invoice_id}`} className="underline-offset-4 hover:text-text hover:underline">
                    {r.invoice_number}
                  </Link>
                </>
              ) : null}
              {r.reversed_at ? <span className="text-danger-text"> · Reversed</span> : null}
            </p>
          </div>
          <div className={r.reversed_at ? "text-right text-text-muted line-through" : "text-right"}>
            <Money value={r.amount_received} />
            {Number(r.tds_amount) > 0 ? (
              <span className="block text-xs text-text-muted">
                + <Money value={r.tds_amount} /> TDS
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

function TdsRows({ rows, totalPaise }: { rows: TdsCreditSummaryRow[]; totalPaise: number }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">TDS deducted by the client, by quarter and status</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-text-muted">
          <th scope="col" className="px-4 py-2 font-medium md:pl-5">Quarter</th>
          <th scope="col" className="px-2 py-2 font-medium">Status</th>
          <th scope="col" className="px-2 py-2 text-right font-medium">Receipts</th>
          <th scope="col" className="px-4 py-2 text-right font-medium md:pr-5">TDS</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.quarter}-${r.status}`} className="border-b border-border/70">
            <td className="px-4 py-2 text-text md:pl-5">{r.quarter}</td>
            <td className="px-2 py-2 text-text">{TDS_STATUS_LABEL[r.status] ?? r.status}</td>
            <td className="num px-2 py-2 text-right text-text tabular-nums">{r.count}</td>
            <td className="px-4 py-2 text-right md:pr-5">
              <Money value={fromPaise(r.amountPaise)} />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={3} className="px-4 py-2 text-left font-semibold text-text md:pl-5">
            Total
          </th>
          <td className="px-4 py-2 text-right font-semibold md:pr-5">
            <Money value={fromPaise(totalPaise)} />
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

function CreditRows({ rows, today }: { rows: ClientCreditNoteRow[]; today: string }) {
  return (
    <ul className="flex flex-col">
      {rows.map((c) => (
        <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-2.5 last:border-b-0 md:px-5">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 text-base text-text">
              <a href={`/api/pdf/credit-note/${c.id}`} target="_blank" rel="noopener" className="underline-offset-4 hover:underline" aria-label={`Credit note ${c.credit_note_number} PDF`}>
                <MonoId value={c.credit_note_number} />
              </a>
              <span className="text-sm text-text-muted">
                <DateText date={c.issue_date} today={today} />
              </span>
            </p>
            <p className="text-sm text-text-muted">
              {isEnumValue("credit_note_reason", c.reason_code) ? CREDIT_NOTE_REASON_LABELS[c.reason_code] : c.reason_code}
              {c.reduces_gst ? "" : " · commercial credit"}
              {c.invoice_number ? (
                <>
                  {" · against "}
                  <Link href={`/invoices/${c.invoice_id}`} className="underline-offset-4 hover:text-text hover:underline">
                    {c.invoice_number}
                  </Link>
                </>
              ) : null}
            </p>
          </div>
          <Money value={c.total_amount} />
        </li>
      ))}
    </ul>
  )
}

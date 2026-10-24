import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { FileDownIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { fromPaise, toPaise } from "@/lib/domain/money"
import { CREDIT_NOTE_REASON_LABELS, PAYMENT_METHOD_LABELS, isEnumValue } from "@/lib/domain/enums"
import type { StatutoryParameterRow } from "@/lib/domain/gst"
import { MESSAGE_CHANNEL_LABEL, messageStatusInfo } from "@/lib/handoff"
import { invoiceActions, isReportedInGstr1, sentViaLabel } from "@/lib/schemas/invoices"
import { TDS_STATUS_LABEL } from "@/lib/schemas/receipts"
import { getAnnualReturn, getBillingSettings, getGstParams, getInvoiceDetail, invoiceFy, tdsAlreadyRecorded, type InvoiceDetail } from "@/lib/data/invoices"
import { getTdsParameterRows } from "@/lib/data/receipts"
import { getMessagingContext, type MessagingContext } from "@/lib/data/clients"
import { getEmailReadiness } from "@/server/email/readiness"
import { getFirmProfile, type FirmProfile } from "@/server/firm"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { InvoiceStatusCell } from "@/components/invoices/invoices-table"
import { InvoiceActionsBar } from "@/components/invoices/detail/invoice-actions"
import { PaymentClaims, ReceiptActions } from "@/components/invoices/detail/receipt-actions"
import { InvoiceView, RelatedLink } from "@/components/invoices/detail/invoice-view"
import { Notice } from "@/components/invoices/detail/notice"
import { InvoiceFollowUpPanel } from "@/components/collections/follow-up-panel"
import { clientLabel } from "@/components/invoices/invoice-ui"
import type { CreditContext, DetailInvoice, ReceiptContext, SendContext, SendRecipient } from "@/components/invoices/detail/types"

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Invoice" }
    const s = await getSession()
    if (s.status !== "ok" || (s.user.role !== "partner" && s.user.role !== "manager")) return { title: "Invoice" }
    const { data } = await s.supabase.from("invoices").select("invoice_number, invoice_kind").eq("id", id).maybeSingle()
    if (!data) return { title: "Invoice" }
    return { title: data.invoice_number ? `Invoice ${data.invoice_number}` : data.invoice_kind === "debit_note" ? "Draft debit note" : "Draft invoice" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Invoice" }
  }
}

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/invoices/[id]:${source}`, userId }) }
  }
}

/**
 * One invoice (§7.9.3): its number and state, the next step (approve, issue and send, record a
 * receipt, send again) and the corrections the state allows (credit note, debit note, cancel and
 * reissue, dispute, waive); the invoice as the client reads it; what is paid and outstanding; the
 * receipts, the follow-ups and payment reminders (§7.9.5), credit notes, the client's "I've paid"
 * claims, every send, and the history. Partners and
 * Managers only (§4.1); RLS hides it from anyone else, and a missing or deleted invoice is a 404.
 */
export default async function InvoicePage({ params }: Params) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const today = todayIST()
  const role = user.role === "partner" ? "partner" : "manager"

  let detail: InvoiceDetail | null
  let settings: Awaited<ReturnType<typeof getBillingSettings>>
  let gst: Awaited<ReturnType<typeof getGstParams>>
  try {
    ;[detail, settings, gst] = await Promise.all([getInvoiceDetail(supabase, id), getBillingSettings(supabase), getGstParams(supabase, today)])
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/invoices/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={[{ label: "Invoices", href: "/invoices" }, { label: "Invoice" }]} />
        <PageHeader breadcrumbs={[{ label: "Invoices", href: "/invoices" }, { label: "Invoice" }]} title="Invoice" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this invoice." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail) notFound()

  const inv = detail.invoice
  const fy = invoiceFy(inv.issue_date)
  const [readiness, messaging, firm, annual, tdsRows] = await Promise.all([
    attempt("email", user.id, () => getEmailReadiness(supabase)),
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
    attempt("firm", user.id, () => getFirmProfile(supabase)),
    role === "partner" ? attempt("annual-return", user.id, () => getAnnualReturn(supabase, fy)) : Promise.resolve({ ok: true as const, data: null }),
    attempt("tds", user.id, () => getTdsParameterRows(supabase, today)),
  ])

  const client = detail.client
  const unissued = inv.status === "draft" || inv.status === "awaiting_approval"
  const cancelled = Boolean(inv.cancelled_at)
  const outstandingPaise = toPaise(inv.outstanding_amount)
  const totalPaise = toPaise(inv.total_amount)
  const liveReceipts = detail.receipts.filter((r) => !r.reversed_at)
  const actions = invoiceActions(
    {
      status: inv.status,
      cancelled,
      invoiceKind: inv.invoice_kind === "debit_note" ? "debit_note" : "tax_invoice",
      requiresApproval: inv.requires_approval,
      approved: Boolean(inv.approved_at),
      outstandingPaise,
      reported: isReportedInGstr1(inv.issue_date, settings.lastGstr1ReportedMonth),
      hasLiveReceipts: liveReceipts.length > 0,
      hasCreditNotes: detail.creditNotes.length > 0,
      hasDebitNotes: detail.debitNotes.some((d) => !d.cancelled_at && d.status !== "draft" && d.status !== "awaiting_approval"),
    },
    role,
  )
  const name = (pid: string | null) => (pid ? (detail.names[pid] ?? null) : null)
  const number = inv.invoice_number
  const kindWord = inv.invoice_kind === "debit_note" ? "debit note" : "invoice"
  const title = number ? (inv.invoice_kind === "debit_note" ? `Debit note ${number}` : `Invoice ${number}`) : `Draft ${kindWord}`
  const crumbs = [{ label: "Invoices", href: "/invoices" }, { label: number ?? "Draft" }]

  const firmProfile: FirmProfile | null = firm.ok ? firm.data : null
  const m: MessagingContext | null = messaging.ok ? messaging.data : null
  const recipients: SendRecipient[] = client?.contacts.length
    ? client.contacts.map((c) => ({ contactId: c.id, name: c.name, email: c.email, phone: c.phone, whatsapp: c.whatsapp, primary: c.is_primary, bounced: c.email_bounced }))
    : client
      ? [{ contactId: null, name: client.display_name, email: client.email, phone: client.phone, whatsapp: client.whatsapp, primary: true, bounced: false }]
      : []
  const primaryEmail = recipients.find((r) => r.primary && r.email && !r.bounced)?.email ?? recipients.find((r) => r.email && !r.bounced)?.email ?? client?.email ?? null

  const detailInvoice: DetailInvoice = {
    id: inv.id,
    updatedAt: inv.updated_at,
    number,
    kind: inv.invoice_kind === "debit_note" ? "debit_note" : "tax_invoice",
    status: inv.status,
    cancelled,
    clientId: inv.client_id,
    clientName: inv.client_name_snapshot ?? client?.legal_name ?? client?.display_name ?? "the client",
    issueDate: inv.issue_date,
    dueDate: inv.due_date,
    periodLabel: inv.billing_period_label,
    totalPaise,
    outstandingPaise: unissued ? totalPaise : outstandingPaise,
    taxablePaise: toPaise(inv.taxable_amount),
    placeOfSupplyCode: inv.place_of_supply_code,
    eInvoice: { irn: inv.irn, ackNo: inv.irn_ack_no, ackDate: inv.irn_ack_date, signedQr: inv.signed_qr },
  }
  const send: SendContext = {
    emailReady: readiness.ok ? readiness.data.ready : false,
    canSetUpEmail: role === "partner",
    recipients,
    client: { email: client?.email ?? null, phone: client?.phone ?? null, whatsapp: client?.whatsapp ?? null },
    portalUrl: `${env.appUrl().replace(/\/+$/, "")}/portal/invoices/${inv.id}`,
    upi: firmProfile?.upi ? { id: firmProfile.upi.id, payee: firmProfile.upi.payeeName } : null,
    bank: firmProfile?.bank ? { accountName: firmProfile.bank.accountName, accountNumber: firmProfile.bank.accountNumber, ifsc: firmProfile.bank.ifsc, bankName: firmProfile.bank.name } : null,
    firmName: m?.firmName ?? settings.firmName,
    firmPhone: m?.firmPhone ?? null,
    countryCode: m?.countryCode ?? "91",
    signatureFormat: m?.signatureFormat ?? "",
    addSignature: m?.addSignature ?? false,
    senderName: user.fullName,
    templates: (m?.templates ?? []).filter((t) => t.type === "payment_reminder" || t.type === "custom").map((t) => ({ id: t.id, name: t.name, body: t.body, subject: t.subject, channel: t.channel })),
  }
  const bankLabel = settings.bankName ? `${settings.bankName}${settings.bankAccountNumber ? ` ····${settings.bankAccountNumber.slice(-4)}` : ""}` : ""
  const receiptCtx: ReceiptContext = {
    taxablePaise: toPaise(inv.taxable_amount),
    tdsAlreadyPaise: tdsAlreadyRecorded(detail.receipts),
    tdsRows: tdsRows.ok ? (tdsRows.data as StatutoryParameterRow[]) : [],
    clientHasTan: Boolean(client?.tan),
    defaultDepositedTo: bankLabel,
    defaultEmail: primaryEmail,
    today,
  }
  const credit: CreditContext | null =
    role === "partner"
      ? {
          items: detail.items.map((i) => ({ amount: Number(i.amount), tax_rate: Number(i.tax_rate), is_reimbursement: i.is_reimbursement })),
          creditNotes: detail.creditNotes.map((c) => ({ taxable_amount: Number(c.taxable_amount), tax_rate: c.tax_rate === null ? null : Number(c.tax_rate), reduces_gst: c.reduces_gst })),
          firmStateCode: settings.firmStateCode,
          annualReturnFiledOn: annual.ok ? (annual.data?.filed_on ?? null) : null,
          params: { creditNoteDeadline: gst.creditNoteDeadline, creditNoteWarnDays: gst.creditNoteWarnDays },
          fy,
          today,
        }
      : null

  const recipient = unissued
    ? {
        name: client?.legal_name?.trim() || client?.display_name || "",
        address: client ? [client.address, client.city, [client.state_name, client.pincode].filter(Boolean).join(" ")].map((p) => (p ?? "").trim()).filter(Boolean).join(", ") || null : null,
        gstin: client?.gstin ?? null,
        stateCode: client?.state_code ?? null,
        registered: client?.gst_registration === "registered",
      }
    : {
        name: inv.client_name_snapshot ?? "",
        address: inv.client_address_snapshot,
        gstin: inv.client_gstin_snapshot,
        stateCode: inv.client_state_snapshot,
        registered: Boolean(inv.client_gstin_snapshot),
      }

  const receivedPaise = toPaise(inv.amount_received)
  const tdsPaise = toPaise(inv.tds_credited)
  const creditedPaise = toPaise(inv.credit_noted)
  const waivedPaise = inv.waived_amount ? toPaise(inv.waived_amount) : 0
  const sentVia = sentViaLabel(inv.sent_channels ?? [])

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="Invoice">
        <p>Issued invoices are never edited. Before its month is in TaxWise&apos;s filed GSTR-1, cancel and reissue it; after, correct it with a credit note (a Partner, within the s.34 deadline) or a debit note.</p>
        <p className="mt-2">Paid and Partially paid come only from receipts. Overdue is worked out from the due date and the balance; a draft is never overdue.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={crumbs}
        title={title}
        meta={
          <InvoiceStatusCell
            row={{
              status: inv.status,
              is_overdue: detail.isOverdue,
              cancelled_at: inv.cancelled_at,
              display_status: cancelled ? "cancelled" : detail.isOverdue ? "overdue" : inv.status,
              days_overdue: detail.daysOverdue,
              requires_approval: inv.requires_approval,
              approved_at: inv.approved_at,
            }}
          />
        }
        description={
          client ? (
            <>
              <Link href={`/clients/${client.id}?tab=billing`} className="font-medium text-text underline-offset-4 hover:underline">
                {clientLabel(client)}
              </Link>
              {" · "}
              <Money value={fromPaise(totalPaise)} />
              {unissued ? null : (
                <>
                  {" · "}
                  {outstandingPaise > 0 ? (
                    <>
                      <Money value={fromPaise(outstandingPaise)} /> outstanding
                    </>
                  ) : (
                    "nothing outstanding"
                  )}
                </>
              )}
            </>
          ) : undefined
        }
        actions={<InvoiceActionsBar invoice={detailInvoice} actions={actions} send={send} receipt={receiptCtx} credit={credit} eInvoicing={settings.eInvoicingApplies} today={today} />}
      />

      <div className="mb-4 flex flex-col gap-2 empty:hidden">
        {inv.status === "awaiting_approval" ? (
          <Notice tone="warning" title={role === "partner" ? "Waiting for your approval" : "Waiting for a Partner's approval"}>
            {name(inv.created_by) ?? "The raiser"} submitted it{inv.submitted_at ? <> on <DateText date={inv.submitted_at} withTime today={today} /></> : null}. It is over the approval limit
            {settings.invoiceApprovalLimitPaise !== null ? <> of <Money value={fromPaise(settings.invoiceApprovalLimitPaise)} /></> : null} including GST, so it can&apos;t be sent until a Partner approves it.
          </Notice>
        ) : null}
        {inv.status === "draft" && inv.returned_at ? (
          <Notice tone="warning" title={`Returned by ${name(inv.returned_by) ?? "a Partner"}`}>
            {inv.approval_note ?? "Change it and submit it again."}
          </Notice>
        ) : null}
        {inv.status === "draft" && inv.requires_approval && inv.approved_at ? (
          <Notice tone="success" title={`Approved by ${name(inv.approved_by) ?? "a Partner"}`}>
            Approved <DateText date={inv.approved_at} withTime today={today} />. It can be issued and sent.
          </Notice>
        ) : null}
        {inv.status === "draft" && inv.requires_approval && !inv.approved_at && role === "manager" ? (
          <Notice tone="info" title="Needs a Partner's approval">
            It is over the approval limit including GST. Open the draft and choose Submit for approval; Partners are told.
          </Notice>
        ) : null}
        {cancelled ? (
          <Notice tone="muted" title={`Cancelled${name(inv.cancelled_by) ? ` by ${name(inv.cancelled_by)}` : ""}`}>
            {inv.cancelled_at ? <><DateText date={inv.cancelled_at} today={today} />: </> : null}
            {inv.cancel_reason ?? "Cancelled."}
            {detail.reissuedAs ? (
              <>
                {" "}
                Reissued as <RelatedLink id={detail.reissuedAs.id} number={detail.reissuedAs.invoice_number} kind={detail.reissuedAs.invoice_kind} />.
              </>
            ) : null}{" "}
            It keeps its number, is never payable and gets no reminders.
          </Notice>
        ) : null}
        {inv.status === "disputed" ? (
          <Notice tone="danger" title="Disputed">
            {inv.disputed_reason ?? "The client disputes this invoice."} Reminders are paused{inv.disputed_at ? <> since <DateText date={inv.disputed_at} today={today} /></> : null}.
          </Notice>
        ) : null}
        {inv.status === "waived" ? (
          <Notice tone="muted" title={`Waived by ${name(inv.waived_by) ?? "a Partner"}`}>
            <Money value={fromPaise(waivedPaise)} /> written off{inv.waived_reason ? `: ${inv.waived_reason}` : "."}
          </Notice>
        ) : null}
        {detail.revisedFrom ? (
          <Notice tone="info" title="A reissue">
            This replaces <RelatedLink id={detail.revisedFrom.id} number={detail.revisedFrom.invoice_number} kind={detail.revisedFrom.invoice_kind} cancelled={Boolean(detail.revisedFrom.cancelled_at)} />, cancelled to be reissued.
          </Notice>
        ) : null}
        {detail.original ? (
          <Notice tone="info" title="Debit note">
            Supplementary to <RelatedLink id={detail.original.id} number={detail.original.invoice_number} kind={detail.original.invoice_kind} />.
          </Notice>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title={number ? `${inv.invoice_kind === "debit_note" ? "Debit note" : "Tax invoice"} ${number}` : `Draft ${kindWord}`} description={unissued ? "Not issued yet: it gets its number when issued." : undefined} flush>
            <InvoiceView invoice={inv} items={detail.items} recipient={recipient} firmStateCode={settings.firmStateCode} today={today} />
          </SectionCard>

          {!unissued ? (
            <SectionCard
              id="receipts"
              title="Receipts"
              description={liveReceipts.length ? `${liveReceipts.length} recorded` : undefined}
              flush
            >
              {detail.receipts.length === 0 ? (
                <EmptyState size="compact" message={actions.recordReceipt ? "No payment recorded yet. Record a receipt when the money reaches the bank." : "No payment recorded."} />
              ) : (
                <>
                  {/* Phones: one row per receipt with the amount on the right; the table from md up. */}
                  <ul aria-label="Receipts against this invoice" className="md:hidden">
                    {detail.receipts.map((r) => (
                      <li key={r.id} className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3 last:border-b-0">
                        <div className="min-w-0 flex-1 text-sm">
                          <MonoId value={r.receipt_number} />
                          <p className="mt-0.5 text-text">
                            <DateText date={r.payment_date} today={today} />
                            <span className="text-text-muted"> · {isEnumValue("payment_method", r.method) ? PAYMENT_METHOD_LABELS[r.method] : r.method}</span>
                          </p>
                          {r.reference ? <p className="text-xs break-all text-text-muted">{r.reference}</p> : null}
                          {r.deposited_to ? <p className="text-xs text-text-muted">To {r.deposited_to}</p> : null}
                          {Number(r.tds_amount) > 0 ? (
                            <p className="text-xs text-text-muted">
                              TDS {r.tds_section} · {r.tds_quarter} · {TDS_STATUS_LABEL[r.tds_status] ?? r.tds_status}
                            </p>
                          ) : null}
                          {r.reversed_at ? (
                            <p className="mt-0.5 text-xs text-danger-text">Reversed: {r.reversal_reason}</p>
                          ) : r.recorded_by_name ? (
                            <p className="mt-0.5 text-xs text-text-muted">By {r.recorded_by_name}</p>
                          ) : null}
                        </div>
                        <div className="flex flex-none items-start gap-1">
                          <div className={r.reversed_at ? "text-right text-sm text-text-muted line-through" : "text-right text-sm text-text"}>
                            <Money value={r.amount_received} />
                            {Number(r.tds_amount) > 0 ? (
                              <span className="block text-xs text-text-muted">
                                + TDS <Money value={r.tds_amount} />
                              </span>
                            ) : null}
                          </div>
                          <ReceiptActions receipt={{ id: r.id, number: r.receipt_number, reversed: Boolean(r.reversed_at) }} defaultEmail={primaryEmail} emailReady={send.emailReady} canSetUpEmail={send.canSetUpEmail} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  {/* `relative` keeps the sr-only caption and header inside the scroller, so they can't widen the page. */}
                  <div className="relative hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[40rem] text-sm">
                      <caption className="sr-only">Receipts against this invoice</caption>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-text-muted">
                          <th scope="col" className="px-4 py-2 font-medium md:pl-5">Receipt</th>
                          <th scope="col" className="px-2 py-2 font-medium">Date</th>
                          <th scope="col" className="px-2 py-2 font-medium">Method</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Received</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">TDS</th>
                          <th scope="col" className="px-4 py-2 md:pr-5"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.receipts.map((r) => (
                          <tr key={r.id} className="border-b border-border/70 align-top last:border-b-0">
                            <td className="px-4 py-2.5 md:pl-5">
                              <MonoId value={r.receipt_number} />
                              {r.reversed_at ? (
                                <span className="mt-0.5 block text-xs text-danger-text">Reversed: {r.reversal_reason}</span>
                              ) : r.recorded_by_name ? (
                                <span className="mt-0.5 block text-xs text-text-muted">By {r.recorded_by_name}</span>
                              ) : null}
                            </td>
                            <td className="px-2 py-2.5 text-text">
                              <DateText date={r.payment_date} today={today} />
                            </td>
                            <td className="px-2 py-2.5 text-text">
                              {isEnumValue("payment_method", r.method) ? PAYMENT_METHOD_LABELS[r.method] : r.method}
                              {r.reference ? <span className="block text-xs text-text-muted">{r.reference}</span> : null}
                              {r.deposited_to ? <span className="block text-xs text-text-muted">To {r.deposited_to}</span> : null}
                            </td>
                            <td className={r.reversed_at ? "px-2 py-2.5 text-right text-text-muted line-through" : "px-2 py-2.5 text-right"}>
                              <Money value={r.amount_received} />
                            </td>
                            <td className={r.reversed_at ? "px-2 py-2.5 text-right text-text-muted line-through" : "px-2 py-2.5 text-right"}>
                              {Number(r.tds_amount) > 0 ? (
                                <>
                                  <Money value={r.tds_amount} />
                                  <span className="block text-xs text-text-muted">
                                    {r.tds_section} · {r.tds_quarter} · {TDS_STATUS_LABEL[r.tds_status] ?? r.tds_status}
                                  </span>
                                </>
                              ) : (
                                <span className="text-text-muted">None</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-right md:pr-5">
                              <ReceiptActions receipt={{ id: r.id, number: r.receipt_number, reversed: Boolean(r.reversed_at) }} defaultEmail={primaryEmail} emailReady={send.emailReady} canSetUpEmail={send.canSetUpEmail} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </SectionCard>
          ) : null}

          {/* §7.9.5 follow-ups and reminders (#collections, where the reminder notifications land). */}
          {!unissued ? <InvoiceFollowUpPanel invoiceId={inv.id} /> : null}

          {detail.creditNotes.length ? (
            <SectionCard id="credit-notes" title="Credit notes" flush>
              <ul className="flex flex-col">
                {detail.creditNotes.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 md:px-5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 text-base text-text">
                        <MonoId value={c.credit_note_number} />
                        <span className="text-sm text-text-muted">
                          <DateText date={c.issue_date} today={today} /> · {isEnumValue("credit_note_reason", c.reason_code) ? CREDIT_NOTE_REASON_LABELS[c.reason_code] : c.reason_code}
                        </span>
                      </p>
                      <p className="mt-0.5 text-sm text-text-muted">
                        {c.reason}
                        {" · "}
                        {c.reduces_gst ? `GST at ${Number(c.tax_rate)}%` : "Commercial credit, no GST change"}
                        {c.issued_by_name ? ` · ${c.issued_by_name}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Money value={c.total_amount} />
                      <a href={`/api/pdf/credit-note/${c.id}`} target="_blank" rel="noopener" className="inline-flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text" aria-label={`Credit note ${c.credit_note_number} PDF`}>
                        <FileDownIcon aria-hidden="true" className="size-4" />
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <SectionCard id="sending" title="Sending history" flush>
            {detail.messages.length === 0 ? (
              <EmptyState size="compact" message={unissued ? "Nothing sent yet. Issue it to send it." : "No email or hand-off recorded for this invoice."} />
            ) : (
              <ul className="flex flex-col">
                {detail.messages.map((msg) => {
                  const s = messageStatusInfo(msg.channel, msg.status)
                  return (
                    <li key={msg.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 md:px-5">
                      <div className="min-w-0">
                        <p className="text-base text-text">
                          {MESSAGE_CHANNEL_LABEL[msg.channel] ?? msg.channel}
                          {msg.recipient ? <span className="text-text-muted"> to {msg.recipient}</span> : null}
                        </p>
                        <p className="text-sm text-text-muted">
                          <DateText date={msg.sent_at ?? msg.created_at} withTime today={today} />
                          {msg.sent_by_name ? ` · ${msg.sent_by_name}` : ""}
                          {msg.subject ? ` · ${msg.subject}` : ""}
                        </p>
                        {msg.error ? <p className="mt-0.5 text-sm text-danger-text">{msg.error}</p> : null}
                      </div>
                      <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>

          <SectionCard id="history" title="History" flush>
            {detail.activity.length === 0 ? (
              <EmptyState size="compact" message="No history yet." />
            ) : (
              <ol className="flex flex-col">
                {detail.activity.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border/70 px-4 py-2.5 last:border-b-0 md:px-5">
                    <span className="min-w-0 text-base text-text">{a.description}</span>
                    <span className="text-sm text-text-muted">
                      {a.user_name ? `${a.user_name} · ` : ""}
                      <DateText date={a.at} withTime today={today} />
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>

        <aside className="flex min-w-0 flex-col gap-4" aria-label="Settlement and details">
          <SectionCard title="Settlement">
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-text-muted">Total</dt>
              <dd className="text-right">
                <Money value={fromPaise(totalPaise)} />
              </dd>
              <dt className="text-text-muted">Received</dt>
              <dd className="text-right">
                <Money value={fromPaise(receivedPaise)} />
              </dd>
              <dt className="text-text-muted">TDS deducted</dt>
              <dd className="text-right">
                <Money value={fromPaise(tdsPaise)} />
              </dd>
              {creditedPaise > 0 ? (
                <>
                  <dt className="text-text-muted">Credit notes</dt>
                  <dd className="text-right">
                    <Money value={fromPaise(creditedPaise)} />
                  </dd>
                </>
              ) : null}
              {waivedPaise > 0 ? (
                <>
                  <dt className="text-text-muted">Waived</dt>
                  <dd className="text-right">
                    <Money value={fromPaise(waivedPaise)} />
                  </dd>
                </>
              ) : null}
              <dt className="border-t border-border pt-2 text-base font-semibold text-text">Outstanding</dt>
              <dd className={detail.isOverdue ? "border-t border-border pt-2 text-right text-base font-semibold text-danger-text" : "border-t border-border pt-2 text-right text-base font-semibold"}>
                {cancelled ? <span className="text-text-muted">Cancelled</span> : unissued ? <span className="text-text-muted">Not issued yet</span> : <Money value={fromPaise(outstandingPaise)} />}
              </dd>
            </dl>
            {detail.isOverdue ? (
              <p className="mt-2 text-sm text-danger-text">
                {detail.daysOverdue} {detail.daysOverdue === 1 ? "day" : "days"} past the due date.
              </p>
            ) : null}
          </SectionCard>

          {detail.claims.length ? (
            <SectionCard title="Client says they paid" description="From the portal. Check the bank before recording it; a claim never marks the invoice paid." flush>
              <PaymentClaims
                invoice={detailInvoice}
                claims={detail.claims.map((c) => ({ id: c.id, reference: c.reference, paidOn: c.paid_on, note: c.note, createdAt: c.created_at, updatedAt: c.updated_at, screenshotDocumentId: c.screenshot_document_id }))}
                ctx={receiptCtx}
                canRecord={actions.recordReceipt}
              />
            </SectionCard>
          ) : null}

          <SectionCard title="Details">
            <DefinitionList
              items={[
                { term: "Raised by", value: name(inv.created_by) },
                ...(inv.requires_approval ? [{ term: "Approval", value: inv.approved_at ? `Approved by ${name(inv.approved_by) ?? "a Partner"}` : inv.status === "awaiting_approval" ? "Waiting" : "Needed before sending" }] : []),
                ...(inv.issued_at ? [{ term: "Issued", value: <><DateText date={inv.issued_at} withTime today={today} />{name(inv.issued_by) ? <span className="block text-xs text-text-muted">by {name(inv.issued_by)}</span> : null}</> }] : []),
                ...(!unissued ? [{ term: "Sent", value: sentVia ? <>{sentVia}{inv.last_sent_at ? <span className="block text-xs text-text-muted">Last <DateText date={inv.last_sent_at} withTime today={today} /></span> : null}</> : "Issued, not sent yet" }] : []),
                { term: "Financial year", value: fy },
                ...(inv.revision_number > 0 ? [{ term: "Revision", value: String(inv.revision_number) }] : []),
              ]}
            />
            {detail.debitNotes.length ? (
              <div className="mt-3 border-t border-border pt-3 text-sm">
                <p className="text-text-muted">Debit notes against it</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {detail.debitNotes.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3">
                      <RelatedLink id={d.id} number={d.invoice_number} kind={d.invoice_kind} cancelled={Boolean(d.cancelled_at)} />
                      <Money value={d.total_amount} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </SectionCard>

          {settings.eInvoicingApplies && !unissued && inv.invoice_kind === "tax_invoice" ? (
            <SectionCard title="E-invoice" description={inv.irn ? undefined : "Register it on the IRP, then add the IRN from More."}>
              <DefinitionList
                items={[
                  { term: "IRN", value: inv.irn ? <span className="font-mono text-xs break-all">{inv.irn}</span> : null },
                  { term: "Ack no.", value: inv.irn_ack_no },
                  { term: "Ack date", value: inv.irn_ack_date ? <DateText date={inv.irn_ack_date} today={today} /> : null },
                ]}
              />
            </SectionCard>
          ) : null}

          {!messaging.ok || !readiness.ok || !firm.ok || !tdsRows.ok ? (
            <p className="text-sm text-text-muted">
              Some sending details didn&apos;t load (Ref {[messaging, readiness, firm, tdsRows].map((r) => (r.ok ? null : r.ref)).filter(Boolean).join(", ")}). Reload the page before sending.
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { CircleAlertIcon, CircleCheckIcon, ClockIcon, ReplaceIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { env } from "@/lib/env"
import { formatDate, formatDateTime, formatNumber } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import { formatINR, toPaise, toPaiseOrNull } from "@/lib/domain/money"
import { applySignature, firstNameOf, normalizeWhatsAppNumber } from "@/lib/domain/messaging"
import {
  EXPIRED_MESSAGE,
  SUPERSEDED_MESSAGE,
  emailTypeLabel,
  CHANNEL_SEND_LABELS,
  followUpWhatsApp,
  quotationActions,
  quotationDisplayStatus,
  sendStatusInfo,
} from "@/lib/schemas/quotations"
import { getQuotationDetail, getQuotationTemplates, quotationDraft, toDocumentFirm, toQuotationDocument, type QuotationDetail } from "@/lib/data/quotations"
import { getMessagingContext } from "@/lib/data/clients"
import { readParam } from "@/components/app/data-table/params"
import { getFirmProfile } from "@/server/firm"
import { getEmailReadiness } from "@/server/email/readiness"
import { emailFirm, quotationFollowUpEmail } from "@/server/email/templates"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { ErrorBlock } from "@/components/app/error-block"
import { MonoId } from "@/components/app/mono-id"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { GrowthSubnav } from "@/components/leads/growth-subnav"
import { QuotationDocumentView } from "@/components/quotations/quotation-document"
import { ApprovalPanel, QuotationControls, QuotationHeaderActions } from "@/components/quotations/detail/quotation-controls"
import { FollowUpsPanel } from "@/components/quotations/detail/follow-ups-panel"
import type { ControlsData, FollowUpView } from "@/components/quotations/detail/types"

type Params = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Quotation" }
    const s = await getSession()
    if (s.status !== "ok" || (s.user.role !== "partner" && s.user.role !== "manager")) return { title: "Quotation" }
    const { data } = await s.supabase.from("quotations").select("quotation_number").eq("id", id).maybeSingle()
    return { title: data ? `Quotation ${data.quotation_number}` : "Quotation" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Quotation" }
  }
}

function Banner({ tone, icon, children }: { tone: "success" | "warning" | "danger" | "muted" | "info"; icon?: React.ReactNode; children: React.ReactNode }) {
  const cls = {
    success: "border-success/40 bg-success-soft",
    warning: "border-warning/40 bg-warning-soft",
    danger: "border-danger/30 bg-danger-soft",
    muted: "border-border bg-surface-2",
    info: "border-info/40 bg-info-soft",
  }[tone]
  return (
    <div role="note" className={`mb-4 flex gap-2.5 rounded-lg border px-4 py-3 text-base text-text ${cls}`}>
      {icon ? <span className="mt-0.5 flex-none [&_svg]:size-4">{icon}</span> : null}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * One quotation (§7.5.2–§7.5.3): the document as the client sees it (same layout as the PDF), what
 * happens next (edit, submit for approval, approve / approve & send / return, send by email or hand
 * it off, revise, create the client), the tracking (sent, first and last viewed, views, the answer),
 * the day 3 / 7 / 14 follow-ups, every send, and the history. Partners and Managers only (§4.1).
 */
export default async function QuotationPage({ params, searchParams }: Params) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const sp = await searchParams
  const followupParam = Number(readParam(sp, "followup") ?? "")
  const highlightDay = Number.isInteger(followupParam) && followupParam > 0 ? followupParam : null

  let detail: QuotationDetail | null
  try {
    detail = await getQuotationDetail(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/quotations/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={[{ label: "Quotations", href: "/quotations" }, { label: "Quotation" }]} title="Quotation" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this quotation." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail || detail.q.deleted_at) notFound()
  const q = detail.q

  const now = new Date()
  const today = todayIST(now)
  let side: { firm: Awaited<ReturnType<typeof getFirmProfile>>; email: { ready: boolean }; templates: Awaited<ReturnType<typeof getQuotationTemplates>>; messaging: Awaited<ReturnType<typeof getMessagingContext>> | null; limit: number | null; followUpDays: number[] }
  try {
    const [firm, email, templates, messaging, settings] = await Promise.all([
      getFirmProfile(supabase),
      getEmailReadiness(supabase),
      getQuotationTemplates(supabase),
      getMessagingContext(supabase, user).catch(() => null),
      supabase.from("firm_settings").select("quotation_approval_limit, quotation_follow_up_days").eq("id", 1).maybeSingle(),
    ])
    if (settings.error) throw settings.error
    side = {
      firm,
      email,
      templates,
      messaging,
      limit: toPaiseOrNull(settings.data?.quotation_approval_limit ?? null),
      followUpDays: (settings.data?.quotation_follow_up_days ?? [3, 7, 14]).filter((d: number) => Number.isInteger(d) && d > 0),
    }
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/quotations/[id]:context", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={[{ label: "Quotations", href: "/quotations" }, { label: q.quotation_number }]} title={`Quotation ${q.quotation_number}`} />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the firm's settings for this quotation." errorRef={ref} />
        </div>
      </div>
    )
  }

  const firm = toDocumentFirm(side.firm)
  const doc = toQuotationDocument(q, detail.items, { preparedBy: q.created_by_name, revisesNumber: detail.revisedFrom?.quotation_number ?? null, firmStateCode: firm.stateCode })
  const displayStatus = quotationDisplayStatus(q.status, q.valid_until, today)
  const totalPaise = toPaise(Number(q.total))
  const actions = quotationActions(
    {
      status: q.status,
      validUntil: q.valid_until,
      today,
      createdByRole: q.created_by_role,
      totalPaise,
      limitPaise: side.limit,
      lineCount: detail.items.length,
      hasEmail: Boolean(q.client_email),
      convertedClientId: q.converted_client_id,
      clientId: q.client_id,
      deleted: Boolean(q.deleted_at),
    },
    user.role,
  )
  const link = `${env.appUrl().replace(/\/+$/, "")}/q/${q.token}`
  const pdfHref = `/api/pdf/quotation/${q.id}`
  const who = q.client_company?.trim() || q.client_name
  const m = side.messaging
  const countryCode = m?.countryCode ?? "91"
  const rawNumber = detail.lead?.whatsapp ?? detail.lead?.phone ?? detail.client?.whatsapp ?? detail.client?.phone ?? q.client_phone ?? null
  const whatsappNumber = normalizeWhatsAppNumber(rawNumber, { countryCode })
  const sign = (text: string) => (m?.addSignature ? applySignature(text, m.signatureFormat, firstNameOf(user.fullName)) : text)
  const amount = formatINR(totalPaise)
  const drafts = quotationDraft(side.templates, {
    contact_name: firstNameOf(q.client_name) || q.client_name,
    client_name: who,
    client_code: detail.client?.client_code ?? null,
    amount,
    quotation_link: link,
    firm_name: side.firm.firmName,
    firm_phone: side.firm.phone,
    sender_name: user.fullName,
  })
  const open = (q.status === "sent" || q.status === "viewed") && displayStatus !== "expired"
  const mailFirm = emailFirm(side.firm)
  const followUps: FollowUpView[] = detail.followUps.map((f) => {
    const mail = quotationFollowUpEmail(
      {
        day: f.follow_up_day >= 14 ? 14 : f.follow_up_day >= 7 ? 7 : 3,
        recipientName: q.client_name,
        quotationNumber: q.quotation_number,
        totalPaise,
        validUntil: q.valid_until,
        viewUrl: link,
        sentOn: q.sent_at ?? today,
        senderName: user.fullName,
      },
      mailFirm,
    )
    return {
      id: f.id,
      day: f.follow_up_day,
      scheduledAt: f.scheduled_at,
      status: f.status,
      sentAt: f.sent_at,
      channel: f.channel,
      whatsapp: sign(
        followUpWhatsApp({
          day: f.follow_up_day,
          firstName: firstNameOf(q.client_name),
          number: q.quotation_number,
          amount,
          validUntil: formatDate(q.valid_until),
          sentOn: q.sent_at ? formatDate(q.sent_at) : formatDate(today),
          link,
          firmPhone: side.firm.phone,
        }),
      ),
      emailSubject: mail.subject,
      emailBody: mail.text,
    }
  })

  const controls: ControlsData = {
    id: q.id,
    number: q.quotation_number,
    status: q.status,
    displayStatus,
    updatedAt: q.updated_at,
    recipientName: q.client_name,
    who,
    email: String(q.client_email ?? ""),
    link,
    pdfHref,
    actions,
    viewerRole: user.role === "partner" ? "partner" : "manager",
    emailReady: side.email.ready,
    whatsappNumber,
    drafts: { whatsapp: sign(drafts.whatsapp), emailSubject: drafts.emailSubject, emailBody: drafts.emailBody },
    createClientHref: actions.createClient ? `/clients/new?fromQuotation=${q.id}` : null,
    approval: q.status === "pending_approval" ? { requestedAt: q.approval_requested_at, requestedByName: q.approval_requested_by_name } : null,
    totalLabel: amount,
    validUntil: q.valid_until,
  }

  const crumbs = [{ label: "Quotations", href: "/quotations" }, { label: q.quotation_number }]
  const convertedTo = detail.convertedClient ?? (q.status === "accepted" && detail.client ? detail.client : null)
  const lastSendFailed = detail.emails.find((e) => e.channel === "email")?.status === "failed"

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="A quotation">
        <p>The document here is what the client sees on their link and in the PDF. A Draft is edited and then sent; over the approval limit, a Manager submits it and a Partner approves or returns it.</p>
        <p className="mt-2">Send it by email (the PDF is attached), or hand it off by Gmail or WhatsApp, or copy the link. Views are tracked; follow-ups go on day 3, 7 and 14 while it is open. Once it has gone out it is never edited: revise it, and the old link says it has been replaced.</p>
        <p className="mt-2">When the client accepts, the lead moves to Won and Create client opens onboarding filled in from the quotation.</p>
      </PageGuide>
      <GrowthSubnav active="quotations" />
      <QuotationControls data={controls}>
        <PageHeader
          breadcrumbs={crumbs}
          title={`Quotation ${q.quotation_number}`}
          meta={<StatusChip kind="quotation_status" value={displayStatus} variant="pill" />}
          description={
            <>
              For {who}
              {q.client_company ? ` (Attn: ${q.client_name})` : ""} · {amount} incl. GST · valid until {formatDate(q.valid_until)}
              {q.revision_number ? ` · revision ${q.revision_number}` : ""}
            </>
          }
          actions={<QuotationHeaderActions />}
        />

        {q.status === "draft" && q.returned_at && q.approval_note ? (
          <Banner tone="warning" icon={<CircleAlertIcon className="text-warning-text" />}>
            <p className="font-medium">Returned with comments on {formatDateTime(q.returned_at)}</p>
            <p className="mt-0.5 whitespace-pre-line">{q.approval_note}</p>
            <p className="mt-1 text-sm text-text-muted">Edit it, then submit it for approval again.</p>
          </Banner>
        ) : null}
        <ApprovalPanel />
        {q.status === "approved" ? (
          <Banner tone="success" icon={<CircleCheckIcon className="text-success-text" />}>
            Approved by {q.approved_by_name ?? "a Partner"}
            {q.approved_at ? ` on ${formatDateTime(q.approved_at)}` : ""}. {actions.send ? "It's ready to send." : actions.sendBlockedReason ?? ""}
            {q.approval_note ? <span className="mt-0.5 block text-sm text-text-muted">{q.approval_note}</span> : null}
          </Banner>
        ) : null}
        {actions.sendBlockedReason && q.status === "draft" && !actions.submitForApproval ? (
          <Banner tone="info" icon={<ClockIcon className="text-info-text" />}>
            {actions.sendBlockedReason}
          </Banner>
        ) : null}
        {q.status === "superseded" ? (
          <Banner tone="muted" icon={<ReplaceIcon className="text-text-muted" />}>
            {detail.supersededBy ? (
              <>
                Replaced by revision{" "}
                <Link href={`/quotations/${detail.supersededBy.id}`} className="font-medium underline-offset-4 hover:underline">
                  {detail.supersededBy.quotation_number}
                </Link>
                .{" "}
              </>
            ) : (
              "Replaced by a revision. "
            )}
            Its link no longer takes responses and tells the client: &ldquo;{SUPERSEDED_MESSAGE}&rdquo;.
          </Banner>
        ) : null}
        {q.status === "accepted" ? (
          <Banner tone="success" icon={<CircleCheckIcon className="text-success-text" />}>
            <p className="font-medium">
              Accepted electronically by {q.accepted_by_name ?? q.client_name}
              {q.responded_at ? ` on ${formatDateTime(q.responded_at)}` : ""}.
            </p>
            {q.response_note ? <p className="mt-0.5 whitespace-pre-line">&ldquo;{q.response_note}&rdquo;</p> : null}
            <p className="mt-1 text-sm text-text-muted">
              {convertedTo ? (
                <>
                  Client:{" "}
                  <Link href={`/clients/${convertedTo.id}`} className="font-medium text-text underline-offset-4 hover:underline">
                    {convertedTo.client_code} · {convertedTo.display_name}
                  </Link>
                </>
              ) : (
                "Create the client to start onboarding; the wizard is filled in from this quotation."
              )}
            </p>
          </Banner>
        ) : null}
        {q.status === "rejected" ? (
          <Banner tone="danger" icon={<CircleAlertIcon className="text-danger-text" />}>
            <p className="font-medium">Declined{q.responded_at ? ` on ${formatDateTime(q.responded_at)}` : ""}.</p>
            {q.rejection_reason ? <p className="mt-0.5 whitespace-pre-line">&ldquo;{q.rejection_reason}&rdquo;</p> : null}
            <p className="mt-1 text-sm text-text-muted">Revise it to send an updated quotation.</p>
          </Banner>
        ) : null}
        {displayStatus === "expired" ? (
          <Banner tone="muted" icon={<ClockIcon className="text-text-muted" />}>
            Expired after {formatDate(q.valid_until)}. The link tells the client: &ldquo;{EXPIRED_MESSAGE}&rdquo; Revise it to send an updated one.
          </Banner>
        ) : null}
        {lastSendFailed && open ? (
          <Banner tone="danger" icon={<CircleAlertIcon className="text-danger-text" />}>
            The last email didn&apos;t reach {q.client_name}. Resend it, or hand it off by WhatsApp or Gmail.
          </Banner>
        ) : null}

        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
          <QuotationDocumentView doc={doc} firm={firm} />

          <aside className="flex min-w-0 flex-col gap-4 lg:gap-6" aria-label="Tracking and history">
            <SectionCard title="Tracking">
              <DefinitionList
                items={[
                  { term: "Sent", value: q.sent_at ? formatDateTime(q.sent_at) : null },
                  ...(q.last_sent_at && q.sent_at && q.last_sent_at !== q.sent_at ? [{ term: "Last sent", value: formatDateTime(q.last_sent_at) }] : []),
                  { term: "First viewed", value: q.first_viewed_at ? formatDateTime(q.first_viewed_at) : q.sent_at ? "Not yet" : null },
                  { term: "Last viewed", value: q.last_viewed_at ? formatDateTime(q.last_viewed_at) : null },
                  { term: "Views", value: q.sent_at ? formatNumber(q.view_count) : null, align: "right" as const },
                  { term: "Valid until", value: <DateText date={q.valid_until} withRelative={open || q.status === "draft" || q.status === "approved" || q.status === "pending_approval"} today={today} /> },
                  { term: "Answered", value: q.responded_at ? formatDateTime(q.responded_at) : null },
                ]}
              />
            </SectionCard>

            <SectionCard id="follow-ups" title="Follow-ups" description={side.email.ready ? "Emailed at 2:30 pm on each day" : "Email isn't set up: hand each one off"} flush>
              <FollowUpsPanel
                quotationId={q.id}
                rows={followUps}
                open={open}
                emailReady={side.email.ready}
                highlightDay={highlightDay}
                whatsappNumber={whatsappNumber}
                email={String(q.client_email ?? "")}
                who={who}
                recipientName={q.client_name}
                pdfHref={pdfHref}
                plannedDays={side.followUpDays}
                now={now.toISOString()}
              />
            </SectionCard>

            <SectionCard title="Related">
              <DefinitionList
                items={[
                  {
                    term: "Lead",
                    value: detail.lead ? (
                      <span className="flex flex-col gap-0.5">
                        <Link href={`/leads/${detail.lead.id}`} className="font-medium underline-offset-4 hover:underline">
                          {[detail.lead.lead_number, detail.lead.company || detail.lead.name].filter(Boolean).join(" · ")}
                        </Link>
                        <StatusChip kind="lead_status" value={detail.lead.status} />
                      </span>
                    ) : null,
                  },
                  {
                    term: "Client",
                    value: detail.client ? (
                      <Link href={`/clients/${detail.client.id}`} className="font-medium underline-offset-4 hover:underline">
                        {detail.client.client_code} · {detail.client.display_name}
                      </Link>
                    ) : detail.convertedClient ? (
                      <Link href={`/clients/${detail.convertedClient.id}`} className="font-medium underline-offset-4 hover:underline">
                        {detail.convertedClient.client_code} · {detail.convertedClient.display_name}
                      </Link>
                    ) : null,
                  },
                  {
                    term: "Revises",
                    value: detail.revisedFrom ? (
                      <Link href={`/quotations/${detail.revisedFrom.id}`} className="underline-offset-4 hover:underline">
                        <MonoId value={detail.revisedFrom.quotation_number} />
                      </Link>
                    ) : null,
                  },
                  {
                    term: "Replaced by",
                    value: detail.supersededBy ? (
                      <Link href={`/quotations/${detail.supersededBy.id}`} className="underline-offset-4 hover:underline">
                        <MonoId value={detail.supersededBy.quotation_number} />
                      </Link>
                    ) : null,
                  },
                  { term: "Prepared by", value: q.created_by_name },
                  { term: "Approved by", value: q.approved_by_name ? `${q.approved_by_name}${q.approved_at ? `, ${formatDate(q.approved_at)}` : ""}` : null },
                ]}
              />
            </SectionCard>

            <SectionCard title="Sends" description={detail.emails.length ? `${detail.emails.length} ${detail.emails.length === 1 ? "send" : "sends"}` : undefined} flush>
              {detail.emails.length ? (
                <ul aria-label="Sends" className="px-4 pb-3 md:px-5">
                  {detail.emails.map((e) => {
                    const info = sendStatusInfo(e.channel, e.status)
                    return (
                      <li key={e.id} className="flex flex-col gap-0.5 border-t border-border/70 py-2.5 first:border-t-0">
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 truncate text-base text-text">
                            {emailTypeLabel(e.email_type)} · {CHANNEL_SEND_LABELS[e.channel] ?? e.channel}
                          </p>
                          <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
                        </div>
                        <p className="truncate text-sm text-text-muted">
                          {e.channel === "internal_note" ? "" : `${e.to} · `}
                          <span className="num tabular-nums">{formatDateTime(e.sent_at ?? e.created_at)}</span>
                        </p>
                        {e.error ? <p className="text-sm text-danger-text">{e.error}</p> : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="px-4 pb-4 text-sm text-text-muted md:px-5">Not sent yet. Every email and hand-off shows here.</p>
              )}
            </SectionCard>

            <SectionCard title="History" flush>
              {detail.history.length ? (
                <ol aria-label="History" className="px-4 pb-3 md:px-5">
                  {detail.history.map((h) => (
                    <li key={h.id} className="border-t border-border/70 py-2.5 first:border-t-0">
                      <p className="text-base text-text">{h.description}</p>
                      <p className="num text-sm text-text-muted tabular-nums">{formatDateTime(h.at)}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-4 pb-4 text-sm text-text-muted md:px-5">Nothing recorded yet.</p>
              )}
            </SectionCard>
          </aside>
        </div>
      </QuotationControls>
    </div>
  )
}

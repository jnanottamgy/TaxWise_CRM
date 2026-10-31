import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDateTime } from "@/lib/format"
import { istDateOf, todayIST } from "@/lib/domain/fy"
import { formatINR, multiplyPaise, toPaise } from "@/lib/domain/money"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import {
  LETTER_AUDIT_TYPES,
  LETTER_EXPIRY_WINDOW_DAYS,
  OCCURRENCES_PER_YEAR,
  frequencyLabel,
  isAuditLetter,
  isExpiringLetter,
  sa210Sections,
  scheduleAnnualPaise,
  servicesSummary,
  type LetterAuditType,
} from "@/lib/schemas/engagement-letters"
import { getLetter, listLetterRecipients, type LetterRow } from "@/lib/data/engagement-letters"
import { getMessagingContext } from "@/lib/data/clients"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { LetterActions } from "@/components/engagement-letters/letter-actions"

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Engagement letter" }
    const s = await getSession()
    if (s.status !== "ok" || (s.user.role !== "partner" && s.user.role !== "manager")) return { title: "Engagement letter" }
    const { data } = await s.supabase.from("engagement_letters_register").select("client_name, financial_year").eq("id", id).maybeSingle()
    return { title: data ? `Engagement letter FY ${data.financial_year} · ${data.client_name}` : "Engagement letter" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Engagement letter" }
  }
}

function Notice({ tone, children }: { tone: "warning" | "danger" | "info"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "border-danger/30 bg-danger-soft" : tone === "warning" ? "border-warning/40 bg-warning-soft" : "border-border bg-surface-2"
  return (
    <p role="note" className={`mb-4 rounded-md border px-3 py-2.5 text-base text-text ${cls}`}>
      {children}
    </p>
  )
}

function Terms({ l }: { l: LetterRow }) {
  const audit = isAuditLetter(l.service_types)
  const auditType = (LETTER_AUDIT_TYPES as readonly string[]).includes(l.audit_type ?? "") ? (l.audit_type as LetterAuditType) : null
  const sections = audit
    ? sa210Sections({ auditType, fy: l.financial_year, clientName: l.client_name, framework: l.reporting_framework ?? "", reportForm: l.report_form ?? "", scope: l.scope, exclusions: l.exclusions })
    : [
        ...(l.scope ? [{ title: "Scope", paragraphs: [l.scope] }] : []),
        ...(l.exclusions ? [{ title: "Not covered", paragraphs: [l.exclusions] }] : []),
      ]
  return sections.length ? (
    <div className="flex flex-col gap-4">
      {sections.map((s) => (
        <div key={s.title}>
          <h3 className="text-sm font-semibold text-text">{s.title}</h3>
          {s.paragraphs.map((p, i) => (
            <p key={i} className="mt-1 max-w-[80ch] text-base whitespace-pre-line text-text">
              {p}
            </p>
          ))}
        </div>
      ))}
    </div>
  ) : (
    <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">No scope written. The letter prints the services schedule and the standard terms.</p>
  )
}

/**
 * One engagement letter (§7.15.3): its state and next step (issue and send for signature, mark
 * signed with the signed copy, record a decline, withdraw, renew for next FY), the terms as the
 * client reads them (SA 210 contents for an audit; scope and exclusions otherwise), the services
 * schedule with fees (excl. GST) and the year's total, and the facts: client, FY, signing Partner,
 * issued, sent, signed, expiry, the signed copy, the audit engagement and the renewal chain. Partners
 * and Managers only (§4.1); RLS hides it from anyone else, and a missing letter is a 404.
 */
export default async function LetterPage({ params }: Params) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const today = todayIST()
  const crumbs = [{ label: "Engagement letters", href: "/engagement-letters" }, { label: "Letter" }]

  let letter: LetterRow | null = null
  let ref: string | null = null
  try {
    letter = await getLetter(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/engagement-letters/[id]", userId: user.id })
  }
  if (ref) {
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="Engagement letter" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this letter." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!letter) notFound()
  const l = letter

  let recipients: Awaited<ReturnType<typeof listLetterRecipients>> = []
  let messaging: Awaited<ReturnType<typeof getMessagingContext>> | null = null
  try {
    messaging = await getMessagingContext(supabase, user)
    recipients = await listLetterRecipients(supabase, l.client_id, l.service_types, { countryCode: messaging.countryCode })
  } catch (err) {
    unstable_rethrow(err)
    logUnexpected(err, { source: "page:/engagement-letters/[id]:recipients", userId: user.id })
  }

  const named = [{ label: "Engagement letters", href: "/engagement-letters" }, { label: `${l.client_name} · FY ${l.financial_year}` }]
  const audit = isAuditLetter(l.service_types)
  const expiring = isExpiringLetter({ status: l.status, expiresAt: l.expires_at, renewed: Boolean(l.renewal_id) }, today)
  const annual = scheduleAnnualPaise(l.services_schedule)

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={named} />
      <PageGuide title="Engagement letter">
        <p>Issue and send moves a draft to Issued, then sends it on WhatsApp for signature: the message asks them to sign it, and the PDF downloads to attach. Once issued, the terms are fixed: withdraw it to a draft to change them.</p>
        <p className="mt-2">When the client signs, mark it signed and upload the signed copy; it is filed in the client&apos;s vault under Engagement. Expired is worked out from the expiry date; renew it for the next FY with one click.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={named}
        title={`Engagement letter · FY ${l.financial_year}`}
        meta={<StatusChip kind="engagement_status" value={l.display_status} variant="pill" />}
        description={
          <>
            <Link href={`/clients/${l.client_id}?tab=engagement`} className="text-primary hover:underline">
              {l.client_name}
            </Link>{" "}
            · {servicesSummary(l)}
          </>
        }
        actions={
          <LetterActions
            letter={{
              id: l.id,
              updatedAt: l.updated_at,
              clientId: l.client_id,
              clientName: l.client_name,
              financialYear: l.financial_year,
              issuedAt: l.issued_at,
              status: l.status,
              displayStatus: l.display_status,
              hasSignedCopy: Boolean(l.document_id),
              renewed: Boolean(l.renewal_id),
              signatoryName: l.signatory_name,
              clientCode: l.client_code,
            }}
            recipients={recipients}
            messaging={messaging}
            today={today}
            expiring={expiring}
          />
        }
      />

      {l.status === "declined" ? <Notice tone="danger">The client declined this letter{l.declined_reason ? `: ${l.declined_reason}` : "."} Don&apos;t start the work it covers.</Notice> : null}
      {l.display_status === "expired" && !l.renewal_id ? <Notice tone="warning">This letter expired on <DateText date={l.expires_at} />. Renew it for the next FY.</Notice> : null}
      {expiring && l.days_to_expiry !== null ? (
        <Notice tone="warning">
          It expires {l.days_to_expiry === 0 ? "today" : `in ${l.days_to_expiry} ${l.days_to_expiry === 1 ? "day" : "days"}`} (within {LETTER_EXPIRY_WINDOW_DAYS}). Renew it for the next FY.
        </Notice>
      ) : null}
      {l.renewal_id ? (
        <Notice tone="info">
          Renewed for FY {l.renewal_fy}:{" "}
          <Link href={`/engagement-letters/${l.renewal_id}`} className="text-primary hover:underline">
            open the FY {l.renewal_fy} letter
          </Link>
          .
        </Notice>
      ) : null}
      {l.status === "draft" && audit && (!l.reporting_framework || !l.report_form || !l.audit_type) ? <Notice tone="warning">An audit letter needs the kind of audit, the reporting framework and the form of report (SA 210) before it can be issued. Edit the draft.</Notice> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title={audit ? "Terms of the audit (SA 210)" : "Scope"} description={audit ? "As printed: objective and scope, responsibilities, framework and form of report." : "What the engagement covers, and what it doesn't."}>
            <Terms l={l} />
          </SectionCard>
          <SectionCard title="Services and fees" description="Excluding GST." action={annual > 0 ? <span className="text-sm text-text-muted">For the year <span className="num text-text tabular-nums">{formatINR(annual)}</span></span> : undefined} flush>
            {l.services_schedule.length === 0 ? (
              <div className="px-4 pb-4 md:px-5">
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">{l.fee_agreed !== null ? "No schedule: the letter prints the fee agreed." : "No services schedule and no fee on this letter."}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-base">
                  <caption className="sr-only">Services schedule</caption>
                  <thead>
                    <tr className="h-9 bg-surface-2 text-left text-xs text-text-muted">
                      <th scope="col" className="px-4 font-medium md:px-5">Service</th>
                      <th scope="col" className="px-3 font-medium">Frequency</th>
                      <th scope="col" className="px-3 text-right font-medium">Fee</th>
                      <th scope="col" className="px-4 text-right font-medium md:px-5">For the year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.services_schedule.map((r, i) => (
                      <tr key={i} className="h-11 border-t border-border/70">
                        <td className="px-4 md:px-5">
                          <span className="block truncate">{r.description}</span>
                          <span className="text-xs text-text-muted">{SERVICE_TYPE_LABELS[r.service_type]}</span>
                        </td>
                        <td className="px-3 text-text-muted">{frequencyLabel(r.frequency)}</td>
                        <td className="num px-3 text-right tabular-nums">{r.fee ? <Money value={r.fee} /> : <span className="text-text-muted">As agreed</span>}</td>
                        <td className="num px-4 text-right tabular-nums md:px-5">{r.fee ? formatINR(multiplyPaise(toPaise(r.fee), OCCURRENCES_PER_YEAR[r.frequency])) : <span className="text-text-muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="Details">
            <DefinitionList
              items={[
                { term: "Client", value: <Link href={`/clients/${l.client_id}`} className="text-primary hover:underline">{l.client_name}</Link> },
                { term: "FY", value: l.financial_year },
                { term: "Fee agreed (excl. GST)", value: l.fee_agreed !== null ? <Money value={l.fee_agreed} /> : null, align: "right" },
                { term: "Signing Partner", value: l.signatory_name },
                { term: "Issued", value: l.issued_at ? <DateText date={istDateOf(l.issued_at)} /> : null },
                { term: "Sent for signature", value: l.sent_at ? `${formatDateTime(l.sent_at)}${l.sent_to ? ` to ${l.sent_to}` : ""}` : null },
                { term: "Signed", value: l.signed_at ? <DateText date={istDateOf(l.signed_at)} /> : null },
                {
                  term: "Signed copy",
                  value: l.document_id ? (
                    <a href={`/api/files/documents/${l.document_id}?mode=preview`} target="_blank" rel="noopener" className="text-primary hover:underline">
                      {l.signed_copy_title ?? "Open"}
                    </a>
                  ) : null,
                },
                { term: "Expires", value: <DateText date={l.expires_at} withRelative={expiring} today={today} /> },
                ...(l.audit_engagement_id ? [{ term: "Audit engagement", value: <Link href={`/audits/${l.audit_engagement_id}`} className="text-primary hover:underline">Open the audit</Link> }] : []),
                ...(l.renewed_from_id ? [{ term: "Renews", value: <Link href={`/engagement-letters/${l.renewed_from_id}`} className="text-primary hover:underline">FY {l.renewed_from_fy} letter</Link> }] : []),
                { term: "Created by", value: l.created_by_name },
                { term: "Last changed", value: formatDateTime(l.updated_at) },
              ]}
            />
          </SectionCard>
          {l.notes ? (
            <SectionCard title="Internal notes">
              <p className="text-base whitespace-pre-line text-text">{l.notes}</p>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  )
}

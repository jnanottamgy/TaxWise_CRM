import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { CircleCheckIcon, CircleAlertIcon, FileTextIcon, HistoryIcon, SearchCheckIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDate, formatDateTime, formatTimeAgo } from "@/lib/format"
import { LEAD_SOURCE_LABELS, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { firstNameOf } from "@/lib/domain/messaging"
import { renderTemplate } from "@/lib/domain/templates"
import { todayIST } from "@/lib/domain/fy"
import { lostCategoryLabel, servicesPhrase } from "@/lib/schemas/leads"
import { quotationDisplayStatus } from "@/lib/schemas/quotations"
import { getLeadDetail, getLeadTemplates, type LeadDetail } from "@/lib/data/leads"
import { getMessagingContext, listStaffOptions } from "@/lib/data/clients"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { Money } from "@/components/app/money"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { GrowthSubnav } from "@/components/leads/growth-subnav"
import { LeadActions } from "@/components/leads/lead-actions"
import { LeadContactButtons } from "@/components/leads/lead-contact"
import { LogLeadNoteButton } from "@/components/leads/log-note-dialog"
import { FollowUpControl } from "@/components/leads/follow-up-control"
import { LeadTimeline } from "@/components/leads/lead-timeline"

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Lead" }
    const s = await getSession()
    if (s.status !== "ok" || (s.user.role !== "partner" && s.user.role !== "manager")) return { title: "Lead" }
    const { data } = await s.supabase.from("leads").select("name, company").eq("id", id).maybeSingle()
    return { title: data ? data.company || data.name : "Lead" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Lead" }
  }
}

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/leads/[id]:${source}`, userId }) }
  }
}

const OUTCOME_CHIP = {
  pending: { label: "Pending", tone: "warning" as const, meaning: "Pending: checked, no decision yet. Audit work can't be onboarded until it's accepted." },
  accepted: { label: "Accepted", tone: "success" as const, meaning: "Accepted: the firm may take this prospect on. The matches are frozen with the decision." },
  declined: { label: "Declined", tone: "danger" as const, meaning: "Declined: the firm won't take this prospect on." },
}

/**
 * One lead (§7.5.1 lead detail): its timeline (calls, notes, stage changes, quotations), Log a
 * call/note, WhatsApp / email (Gmail) / call with drafts, Create quotation, Run conflict check,
 * Convert to client (the onboarding wizard pre-filled from the lead) and Mark lost (reason*).
 * Partners and Managers only (§4.1); a lead that doesn't exist or is in the recycle bin is a 404.
 */
export default async function LeadPage({ params }: Params) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()

  let detail: LeadDetail | null
  try {
    detail = await getLeadDetail(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/leads/[id]:lead", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={[{ label: "Leads", href: "/leads" }, { label: "Lead" }]} title="Lead" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this lead." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail) notFound()
  const { lead } = detail
  const now = new Date()
  const today = todayIST(now)

  const [staff, messaging, templates] = await Promise.all([
    attempt("staff", user.id, () => listStaffOptions(supabase, user.role)),
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
    attempt("templates", user.id, () => getLeadTemplates(supabase)),
  ])
  const assignable = staff.ok ? staff.data.filter((s) => s.role === "partner" || s.role === "manager").map((s) => ({ value: s.id, label: s.name })) : []
  const m = messaging.ok ? messaging.data : null
  const values = {
    contact_name: firstNameOf(lead.name) || lead.name,
    client_name: lead.company || lead.name,
    service_type: servicesPhrase(lead.services_required),
    firm_name: m?.firmName ?? "TaxWise Consultants",
    firm_phone: m?.firmPhone ?? null,
    sender_name: user.fullName,
  }
  const tpl = templates.ok ? templates.data : { whatsapp: null, email: null }
  const drafts = {
    whatsapp: renderTemplate(
      tpl.whatsapp?.body ??
        "Hi {{contact_name}}, greetings from {{firm_name}}! Following up on our conversation about your {{service_type}} requirements: shall we send you a quotation, or is there anything we can clarify? Happy to help.",
      values,
    ),
    emailSubject: renderTemplate(tpl.email?.subject ?? "{{firm_name}} | Following up on our conversation", values),
    emailBody: renderTemplate(
      tpl.email?.body ??
        "Dear {{contact_name}},\n\nThank you for your interest in {{firm_name}}. I am following up on our recent conversation about your {{service_type}} requirements.\n\nIf you would like a quotation, or have any questions about how we can help, just reply to this email or call us on {{firm_phone}}.\n\nWarm regards,\n{{sender_name}}\n{{firm_name}}",
      values,
    ),
  }
  const latest = detail.acceptances[0] ?? null
  const title = lead.company || lead.name
  const accepted = detail.quotations.find((q) => q.status === "accepted") ?? null
  const createClientHref = accepted ? `/clients/new?fromQuotation=${accepted.id}` : `/clients/new?fromLead=${lead.id}`

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={[{ label: "Leads", href: "/leads" }, { label: title }]} />
      <PageGuide title="A lead">
        <p>Log every call and note here, so the next person picks up where you left off. The WhatsApp and Email buttons open a draft in WhatsApp or Gmail; you press Send there, and the hand-off is noted on the timeline.</p>
        <p className="mt-2">Run the conflict check before taking a prospect on (it is required for audit work). When they agree, Convert to client opens the onboarding wizard filled in from the lead; a quotation the client accepts moves the lead to Won by itself.</p>
      </PageGuide>
      <GrowthSubnav active="leads" />
      <PageHeader
        breadcrumbs={[{ label: "Leads", href: "/leads" }, { label: title }]}
        title={title}
        meta={
          <>
            <StatusChip kind="lead_status" value={lead.status} variant="pill" />
            {lead.lead_number ? <MonoId value={lead.lead_number} copy label="lead number" /> : null}
          </>
        }
        description={[lead.company ? lead.name : null, `${LEAD_SOURCE_LABELS[lead.source]}${lead.source_detail ? ` (${lead.source_detail})` : ""}`, lead.assigned_name ? `with ${lead.assigned_name}` : "not assigned"]
          .filter(Boolean)
          .join(" · ")}
        actions={<LeadActions lead={lead} staff={assignable} latestCheck={latest ? { acceptanceId: latest.id, outcome: latest.outcome, summary: latest.conflict_count ? `${latest.conflict_count} possible conflicts were found.` : "No conflicts were found." } : null} />}
      />

      {lead.status === "won" && lead.converted_client_id ? (
        <Notice tone="success" icon={<CircleCheckIcon aria-hidden="true" className="size-4 text-success-text" />}>
          Won and converted to{" "}
          <Link href={`/clients/${lead.converted_client_id}`} className="font-medium text-primary hover:underline">
            {lead.converted_client_name ?? "the client"}
          </Link>
          . The client&apos;s timeline continues from here.
        </Notice>
      ) : lead.status === "won" ? (
        <Notice
          tone="success"
          icon={<CircleCheckIcon aria-hidden="true" className="size-4 text-success-text" />}
          action={
            <Button asChild size="sm">
              <Link href={createClientHref}>Create client</Link>
            </Button>
          }
        >
          Won. Create the client to start onboarding{accepted ? ` from the accepted quotation ${accepted.quotation_number}` : ""}.
        </Notice>
      ) : lead.status === "lost" ? (
        <Notice tone="danger" icon={<CircleAlertIcon aria-hidden="true" className="size-4 text-danger-text" />}>
          Lost: {lostCategoryLabel(lead.lost_category)}
          {lead.lost_reason ? `. ${lead.lost_reason}` : ""}
        </Notice>
      ) : lead.follow_up_overdue && lead.next_follow_up_at ? (
        <Notice tone="warning" icon={<CircleAlertIcon aria-hidden="true" className="size-4 text-warning-text" />}>
          The follow-up was due {formatDateTime(lead.next_follow_up_at)}. Call or message them, then log it.
        </Notice>
      ) : lead.is_stale ? (
        <Notice tone="warning" icon={<CircleAlertIcon aria-hidden="true" className="size-4 text-warning-text" />}>
          Nobody has called, noted or quoted on this lead since {formatTimeAgo(lead.last_activity_at, now)}.
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <SectionCard
            title="Timeline"
            description="Calls, notes, messages, stage changes and quotations"
            action={<LogLeadNoteButton leadId={lead.id} leadName={title} nextFollowUpAt={lead.next_follow_up_at} />}
          >
            {detail.timeline.length ? (
              <LeadTimeline events={detail.timeline} />
            ) : (
              <EmptyState size="compact" icon={<HistoryIcon />} message="Nothing logged yet. Log the first call or note." />
            )}
          </SectionCard>

          <SectionCard
            title="Quotations"
            flush
            action={
              lead.converted_client_id ? null : (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/quotations/new?lead=${lead.id}`}>
                    <FileTextIcon aria-hidden="true" />
                    New quotation
                  </Link>
                </Button>
              )
            }
          >
            {detail.quotations.length ? (
              <ul className="divide-y divide-border/70 border-t border-border">
                {detail.quotations.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 md:px-5">
                    <Link href={`/quotations/${q.id}`} className="font-mono text-[13px] text-text hover:underline">
                      {q.quotation_number}
                    </Link>
                    <StatusChip kind="quotation_status" value={quotationDisplayStatus(q.status, q.valid_until, today)} />
                    <span className="text-sm text-text-muted">
                      {q.sent_at ? `Sent ${formatDate(q.sent_at)}` : `Issued ${formatDate(q.issue_date)}`}
                      {q.last_viewed_at ? ` · opened ${formatTimeAgo(q.last_viewed_at, now)}` : ""}
                      {q.revision_number ? ` · revision ${q.revision_number}` : ""}
                    </span>
                    <Money value={q.total} className="ml-auto" />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState size="compact" icon={<FileTextIcon />} message="No quotation yet." className="mx-4 mb-4 md:mx-5" />
            )}
          </SectionCard>

          <SectionCard title="Conflict checks" description="Before taking them on: required for audit work (§7.5.4)" flush>
            {detail.acceptances.length ? (
              <ul className="divide-y divide-border/70 border-t border-border">
                {detail.acceptances.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2.5 md:px-5">
                    <StatusChip {...OUTCOME_CHIP[a.outcome]} />
                    <div className="min-w-0 flex-1">
                      <p className="text-base text-text">
                        {a.conflict_count ? `${a.conflict_count} possible ${a.conflict_count === 1 ? "conflict" : "conflicts"}` : "No conflicts found"}
                        {a.decided_by_name ? ` · decided by ${a.decided_by_name}` : ""}
                      </p>
                      {a.rationale ? <p className="mt-0.5 line-clamp-2 text-sm text-text-muted">{a.rationale}</p> : null}
                    </div>
                    <span className="num text-sm text-text-muted tabular-nums">{formatDate(a.decided_at ?? a.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState size="compact" icon={<SearchCheckIcon />} message="Not checked yet. Run the conflict check from the menu above." className="mx-4 mb-4 md:mx-5" />
            )}
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="Contact">
            <div className="flex flex-col gap-3">
              <LeadContactButtons
                lead={lead}
                drafts={drafts}
                countryCode={m?.countryCode ?? "91"}
                signature={{ add: m?.addSignature ?? user.role !== "partner", format: m?.signatureFormat ?? "– {first_name}", senderName: user.fullName }}
              />
              <DefinitionList
                items={[
                  { term: "Name", value: lead.name },
                  { term: "Company", value: lead.company },
                  { term: "Email", value: lead.email },
                  { term: "Phone", value: lead.phone ? <span className="num tabular-nums">{lead.phone}</span> : null },
                  { term: "WhatsApp", value: lead.whatsapp ? <span className="num tabular-nums">{lead.whatsapp}</span> : null },
                ]}
              />
            </div>
          </SectionCard>
          <SectionCard title="Details">
            <DefinitionList
              items={[
                { term: "Services", value: lead.services_required.length ? lead.services_required.map((s) => SERVICE_TYPE_LABELS[s]).join(", ") : null },
                { term: "Requirement", value: lead.requirement_notes ? <span className="whitespace-pre-line">{lead.requirement_notes}</span> : null, wide: true },
                { term: "Estimated value / yr", value: lead.estimated_value === null ? null : <Money value={lead.estimated_value} />, align: "right" },
                { term: "Assigned to", value: lead.assigned_name ?? "Not assigned" },
                {
                  term: "Next follow-up",
                  value: (
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className={lead.follow_up_overdue ? "num text-warning-text tabular-nums" : "num tabular-nums"}>{lead.next_follow_up_at ? formatDateTime(lead.next_follow_up_at) : "Not set"}</span>
                      {lead.status !== "won" && lead.status !== "lost" ? <FollowUpControl leadId={lead.id} updatedAt={lead.updated_at} nextFollowUpAt={lead.next_follow_up_at} /> : null}
                    </span>
                  ),
                },
                { term: "Last activity", value: formatTimeAgo(lead.last_activity_at, now) },
                { term: "Added", value: `${formatDate(lead.created_at)}${lead.created_by_name ? ` by ${lead.created_by_name}` : ""}` },
              ]}
            />
          </SectionCard>
        </div>
      </div>
    </div>
  )
}

function Notice({ tone, icon, action, children }: { tone: "success" | "warning" | "danger"; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  const cls = tone === "success" ? "border-success/25 bg-success-soft" : tone === "warning" ? "border-warning/30 bg-warning-soft" : "border-danger/25 bg-danger-soft"
  return (
    <div role="note" className={`mb-4 flex flex-wrap items-start gap-3 rounded-md border px-3 py-2.5 text-base text-text ${cls}`}>
      <span className="mt-0.5 flex-none">{icon}</span>
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  )
}

import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ArrowDownLeftIcon, ArrowUpRightIcon, ClipboardListIcon, MessagesSquareIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { KpiStrip, type KpiItem } from "@/components/app/kpi-strip"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { DefinitionList } from "@/components/app/definition-list"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { can } from "@/lib/auth/roles"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { ENTITY_TYPE_LABELS, GST_REGISTRATION_LABELS, GST_SCHEME_LABELS } from "@/lib/domain/enums"
import { formatTimeAgo, relativeDue } from "@/lib/format"
import { MONTH_NAMES } from "@/components/client360/logic/master-data"
import { todayIST } from "@/lib/domain/fy"
import { paiseToDecimalString, toPaiseOrNull } from "@/lib/domain/money"
import { gstSchemeDecision, resolveScaleParams } from "@/lib/domain/scale"
import { MESSAGE_CHANNEL_LABEL, messageStatusInfo } from "@/lib/handoff"
import { getOverview, portalEmailOptions, taxAuditParamsDate, type Client360, type OverviewData } from "@/lib/data/client360"
import { TaxAuditCard } from "@/components/client360/overview/tax-audit-card"
import { PortalCard } from "@/components/client360/overview/portal-card"

/**
 * Client 360 → Overview (§7.3.3 tab 1): open tasks, overdue and the next deadline; outstanding ₹
 * (Partner/Manager only, never loaded for Employees); last contact; the open work; key facts and
 * dates; the tax-audit indication and the Partner's decision (§6.6); portal access (invite /
 * resend / revoke / last seen, §7.22); the latest messages; the WhatsApp group's status and when it
 * was last opened (§7.25). Never throws: a failed load renders ErrorBlock with its Ref.
 */
export async function OverviewTab({ data, user, supabase }: { data: Client360; user: CurrentUser; supabase: ServerSupabase }) {
  const { client } = data
  let o: OverviewData
  try {
    o = await getOverview(supabase, user, client)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "client360:overview", userId: user.id, role: user.role, clientId: client.id })
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load this client's overview." errorRef={ref} />
      </div>
    )
  }

  const today = todayIST()
  const base = `/clients/${client.id}`
  const seesMoney = can.seeMoney(user.role)
  const manager = can.createAndAssignTasks(user.role)

  const kpis: KpiItem[] = [
    { label: "Open tasks", value: o.openTasks, sub: o.openTasks === 0 ? "Nothing open" : undefined, href: `${base}?tab=tasks` },
    {
      label: "Overdue",
      value: <span className={o.overdueTasks > 0 ? "text-danger-text" : undefined}>{o.overdueTasks}</span>,
      sub: `${o.overdueTasks === 1 ? "task" : "tasks"} past due${o.overdueDeadlines > 0 ? ` · ${o.overdueDeadlines} deadline${o.overdueDeadlines === 1 ? "" : "s"} overdue` : ""}`,
      href: `${base}?tab=tasks`,
    },
    {
      label: "Next deadline",
      value: o.nextDeadline ? <DateText date={o.nextDeadline.due_date} /> : <span className="text-text-muted">—</span>,
      sub: o.nextDeadline ? <NextDeadlineSub title={o.nextDeadline.title} due={o.nextDeadline.due_date} today={today} /> : "None scheduled",
      href: `${base}?tab=compliance`,
    },
  ]
  if (seesMoney && o.outstanding) {
    kpis.push({
      label: "Outstanding",
      value: <Money value={paiseToDecimalString(o.outstanding.paise)} />,
      sub:
        o.outstanding.invoices === 0
          ? "Nothing unpaid"
          : `${o.outstanding.invoices} invoice${o.outstanding.invoices === 1 ? "" : "s"}${o.outstanding.overdue ? ` · ${o.outstanding.overdue} overdue` : ""}`,
      href: `${base}?tab=billing`,
    })
  }
  kpis.push({
    label: "Last contact",
    value: o.lastContactAt ? formatTimeAgo(o.lastContactAt) : <span className="text-text-muted">—</span>,
    sub: o.messages[0] ? (MESSAGE_CHANNEL_LABEL[o.messages[0].channel] ?? o.messages[0].channel) : "No messages yet",
    href: `${base}?tab=communication`,
  })

  // Scale facts (§6.6): the scheme decision with the limits in force for the turnover's FY.
  const turnoverPaise = toPaiseOrNull(client.annual_turnover)
  const scaleParams = resolveScaleParams(o.taxAudit.parameterRows, taxAuditParamsDate(client.turnover_fy))
  const scheme = client.gst_registration === "registered" ? gstSchemeDecision(turnoverPaise, client.gst_scheme, scaleParams) : null
  const portalEmails = portalEmailOptions(client, data.contacts)

  return (
    <div className="flex flex-col gap-4">
      <KpiStrip items={kpis} aria-label="Where this client stands" />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard
            title="Open work"
            description={o.openTasks > 0 ? `${o.openTasks} open, earliest due first` : undefined}
            flush
            viewAll={o.openTasks > o.tasks.length ? { href: `${base}?tab=tasks`, label: `View all ${o.openTasks}` } : undefined}
            action={
              manager ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/work?new=1&client=${client.id}`}>
                    <PlusIcon aria-hidden="true" />
                    New task
                  </Link>
                </Button>
              ) : undefined
            }
          >
            {o.tasks.length === 0 ? (
              <div className="px-4 pb-4 md:px-5">
                <EmptyState size="compact" icon={<ClipboardListIcon />} message="No open tasks for this client." />
              </div>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {o.tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5 md:px-5">
                    <div className="min-w-0">
                      <Link href={`/work/${t.id}`} className="block truncate rounded-sm text-base font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        {t.title}
                      </Link>
                      <p className="mt-0.5 truncate text-sm text-text-muted">
                        {[t.task_number, t.assignee_name ?? "Unassigned"].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1">
                      <StatusChip kind="task_status" value={t.status} />
                      <DateText date={t.due_date} withRelative className="text-sm" today={today} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Latest messages"
            description="Every channel: email, WhatsApp and Gmail hand-offs, portal, calls and notes"
            flush
            viewAll={{ href: `${base}?tab=communication`, label: "Open communication" }}
          >
            {o.messages.length === 0 ? (
              <div className="px-4 pb-4 md:px-5">
                <EmptyState size="compact" icon={<MessagesSquareIcon />} message="No messages with this client yet." />
              </div>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {o.messages.map((m) => {
                  const info = messageStatusInfo(m.channel, m.status)
                  const Dir = m.direction === "inbound" ? ArrowDownLeftIcon : ArrowUpRightIcon
                  return (
                    <li key={m.id} className="flex items-start justify-between gap-3 px-4 py-2.5 md:px-5">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-sm text-text-muted">
                          <Dir aria-hidden="true" className="size-3.5" />
                          <span className="sr-only">{m.direction === "inbound" ? "From the client" : "To the client"}: </span>
                          {MESSAGE_CHANNEL_LABEL[m.channel] ?? m.channel}
                          {m.by_name ? ` · ${m.by_name}` : ""}
                        </p>
                        <p className="mt-0.5 line-clamp-1 text-base text-text">{m.subject || m.body}</p>
                      </div>
                      <div className="flex flex-none flex-col items-end gap-1">
                        <StatusChip label={info.label} tone={info.tone} meaning={info.meaning || undefined} />
                        <span className="num text-sm text-text-muted tabular-nums">{formatTimeAgo(m.at)}</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="Key facts and dates">
            <DefinitionList
              items={[
                { term: "Entity", value: client.entity_type ? (client.entity_type === "other" ? client.entity_type_other : ENTITY_TYPE_LABELS[client.entity_type]) : null },
                {
                  term: client.entity_type === "individual" || client.entity_type === "proprietorship" ? "Date of birth" : "Incorporated on",
                  value: client.date_of_birth_or_incorporation ? <DateText date={client.date_of_birth_or_incorporation} /> : client.is_incorporated ? null : "Not yet incorporated",
                },
                { term: "Financial year ends", value: MONTH_NAMES[client.fy_end_month - 1] ?? null },
                {
                  term: "Annual turnover",
                  value: turnoverPaise !== null ? (
                    <span>
                      <Money value={client.annual_turnover} />
                      {client.turnover_fy ? <span className="text-text-muted"> · FY {client.turnover_fy}</span> : null}
                    </span>
                  ) : null,
                },
                { term: "GST registration", value: GST_REGISTRATION_LABELS[client.gst_registration] },
                {
                  term: "GST filing scheme",
                  value: scheme ? (
                    <span>
                      {GST_SCHEME_LABELS[scheme.scheme]}
                      <span className="block text-sm text-text-muted">{scheme.explanation}</span>
                      {scheme.warning ? <span className="block text-sm text-warning-text">{scheme.warning}</span> : null}
                    </span>
                  ) : null,
                },
                {
                  term: "Onboarded",
                  value: client.onboarded_at ? (
                    <span>
                      <DateText date={client.onboarded_at} />
                      {o.onboardedByName ? <span className="text-text-muted"> by {o.onboardedByName}</span> : null}
                    </span>
                  ) : client.status === "pending" ? (
                    "Onboarding not finished"
                  ) : null,
                },
                { term: "Client since", value: <DateText date={client.created_at} /> },
                { term: "Reminder lead time", value: client.reminder_days ? `${client.reminder_days} days before each deadline` : "Firm default" },
              ]}
            />
          </SectionCard>

          <TaxAuditCard
            clientId={client.id}
            updatedAt={client.updated_at}
            canDecide={user.role === "partner"}
            turnoverPaise={turnoverPaise}
            turnoverFy={client.turnover_fy}
            entityType={client.entity_type}
            params={scaleParams.taxAudit}
            decision={client.tax_audit_applicable}
            note={client.tax_audit_note}
            decidedBy={o.taxAudit.decidedByName}
            decidedAt={client.tax_audit_decided_at}
          />

          <PortalCard
            clientId={client.id}
            clientName={client.display_name}
            updatedAt={client.updated_at}
            canManage={can.editClients(user.role)}
            linked={!!client.portal_user_id}
            invitedAt={client.portal_invited_at}
            lastSeenAt={client.portal_last_seen_at}
            revokedAt={client.portal_revoked_at}
            revokedBy={o.portal.revokedByName}
            canRestore={!!client.portal_revoked_user_id}
            inviteEmail={portalEmails[0] ?? null}
          />

          <SectionCard
            title="WhatsApp group"
            viewAll={{ href: `${base}?tab=whatsapp`, label: o.whatsapp ? "Open the group" : "Set up the group" }}
          >
            {o.whatsapp ? (
              <DefinitionList
                items={[
                  { term: "Group", value: <MonoId value={o.whatsapp.name} copy label="group name" /> },
                  { term: "Status", value: <StatusChip kind="whatsapp_group_status" value={o.whatsapp.status} /> },
                  ...(o.whatsapp.status === "to_create"
                    ? [{ term: "Setup checklist", value: <span className="num tabular-nums">{`${o.whatsapp.checklist_done} of ${o.whatsapp.checklist_total} steps done`}</span> }]
                    : []),
                  {
                    term: "Last opened",
                    value: o.whatsapp.last_opened_at ? `${formatTimeAgo(o.whatsapp.last_opened_at)}${o.whatsapp.last_opened_by_name ? ` by ${o.whatsapp.last_opened_by_name}` : ""}` : "Not opened from the CRM yet",
                  },
                  ...(o.whatsappGroups > 1 ? [{ term: "Other groups", value: `${o.whatsappGroups - 1} more (${o.whatsappGroups} open in all)` }] : []),
                ]}
              />
            ) : (
              <EmptyState size="compact" message="No WhatsApp group for this client yet." />
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}

function NextDeadlineSub({ title, due, today }: { title: string; due: string; today: string }) {
  const rel = relativeDue(due, today)
  const tone = rel.urgency === "overdue" ? "text-danger-text" : rel.urgency === "soon" ? "text-warning-text" : rel.urgency === "week" ? "text-info-text" : "text-text-muted"
  return (
    <span className="block truncate">
      <span className={tone}>{rel.text}</span> · {title}
    </span>
  )
}


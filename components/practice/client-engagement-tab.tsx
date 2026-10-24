import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import type { ClientTabProps } from "@/components/client360/types"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { Button } from "@/components/ui/button"
import { isManagerOrPartner } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { istDateOf, recentFinancialYears, taxYearLabel, todayIST } from "@/lib/domain/fy"
import { fileAssemblyCountdown } from "@/lib/domain/audit-stages"
import { getSelectedFy } from "@/lib/fy-context"
import { auditYearLabel, defaultAuditFy } from "@/lib/schemas/audits"
import { listAuditTeamOptions, listClientAcceptances, listClientAudits, listClientPreviousAuditorComms } from "@/lib/data/audits"
import { EngagementLettersList } from "@/components/engagement-letters/engagement-letters-list"
import { NewAuditButton } from "@/components/audits/new-audit-button"
import { assemblyWords, auditTypeLabel, stageChip } from "@/components/audits/audit-ui"
import { ClientPreviousAuditors } from "@/components/practice/previous-auditor-list"

const OUTCOME: Record<string, { label: string; tone: "warning" | "success" | "danger" }> = {
  pending: { label: "Pending", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
}

function Heading({ id, title, description, action }: { id: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 id={id} className="text-md leading-6 font-semibold text-text">
          {title}
        </h2>
        <p className="text-sm text-text-muted">{description}</p>
      </div>
      {action}
    </div>
  )
}

/**
 * Client 360 → Engagement (§7.3.3 tab 10, Partner/Manager only): the client's engagement letters per
 * FY (§7.15.3), its audit engagements with their stage and the SA 230 assembly countdown (§6.9), the
 * letters to its previous auditors (Clause 8) and its acceptance and conflict-check records (§7.5.4).
 * An Employee is never shown this tab, and RLS returns them none of it. Each block catches its own
 * failure (ErrorBlock with the Ref), so the tab never throws.
 */
export default async function ClientEngagementTab(props: ClientTabProps) {
  const { clientId, user, supabase } = props
  if (!isManagerOrPartner(user.role)) {
    return <EmptyState message="A client's engagement letters, audits and acceptance records are kept by Partners and Managers." />
  }
  const today = todayIST()
  let ref: string | null = null
  let data: {
    client: { id: string; label: string } | null
    audits: Awaited<ReturnType<typeof listClientAudits>>
    letters: Awaited<ReturnType<typeof listClientPreviousAuditorComms>>
    acceptances: Awaited<ReturnType<typeof listClientAcceptances>>
    team: Awaited<ReturnType<typeof listAuditTeamOptions>>
    fy: string
  } | null = null
  try {
    const [client, audits, letters, acceptances, team, fy] = await Promise.all([
      supabase.from("clients").select("id, display_name, client_code").eq("id", clientId).maybeSingle(),
      listClientAudits(supabase, clientId),
      listClientPreviousAuditorComms(supabase, clientId),
      listClientAcceptances(supabase, clientId),
      listAuditTeamOptions(supabase),
      getSelectedFy(),
    ])
    if (client.error) throw client.error
    data = { client: client.data ? { id: client.data.id, label: `${client.data.display_name} (${client.data.client_code})` } : null, audits, letters, acceptances, team, fy }
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "tab:engagement", userId: user.id, role: user.role, clientId })
  }

  const years = recentFinancialYears(today, 6)
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <EngagementLettersList {...props} />

      {ref || !data || !data.client ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message={ref ? "Couldn't load this client's audits and acceptance records." : "This client isn't available to you."} errorRef={ref} />
        </div>
      ) : (
        <>
          <section aria-labelledby="client-audits-title" className="flex min-w-0 flex-col gap-2">
            <Heading
              id="client-audits-title"
              title="Audit engagements"
              description="Run to the Standards on Auditing, stage by stage, with the engagement partner's approval."
              action={
                <NewAuditButton
                  partners={data.team.partners}
                  reviewers={data.team.reviewers}
                  fyOptions={years}
                  defaultFy={defaultAuditFy(years, data.fy)}
                  defaultPartnerId={user.role === "partner" ? user.employeeId : null}
                  client={data.client}
                  variant="outline"
                  label="New audit"
                />
              }
            />
            {data.audits.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface">
                <EmptyState size="compact" message="No audit engagements for this client." className="m-3" />
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
                {data.audits.map((a) => {
                  const chip = stageChip(a.stage)
                  const c = a.report_date ? fileAssemblyCountdown({ reportDate: a.report_date, archivedOn: a.archived_at ? istDateOf(a.archived_at) : null, today }) : null
                  const w = c ? assemblyWords(c) : null
                  return (
                    <li key={a.id}>
                      <Link href={`/audits/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base text-text">
                            {auditTypeLabel(a.audit_type)} {a.financial_year ? auditYearLabel(a.audit_type ?? "", a.financial_year, taxYearLabel) : ""}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {a.engagement_partner_name ? `Engagement partner ${a.engagement_partner_name}` : "No engagement partner"}
                            {a.stage !== "archived" && (a.stage_steps ?? 0) > 0 ? ` · ${a.stage_steps_done ?? 0} of ${a.stage_steps} steps signed` : ""}
                          </span>
                        </span>
                        <StatusChip label={chip.label} tone={chip.tone} meaning={chip.meaning} />
                        <span className="w-36 text-right text-sm">
                          {w ? <span className={w.tone === "danger" ? "text-danger-text" : w.tone === "warning" ? "text-warning-text" : "text-text-muted"}>{w.label}</span> : <span className="text-text-muted">No report yet</span>}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <ClientPreviousAuditors client={data.client} rows={data.letters} today={today} />

          <section aria-labelledby="client-acceptance-title" className="flex min-w-0 flex-col gap-2">
            <Heading
              id="client-acceptance-title"
              title="Acceptance and conflict checks"
              description="The checks made before taking the client on, with the conflicts found and the decision."
              action={
                <Button asChild variant="outline">
                  <Link href="/acceptance">Acceptance register</Link>
                </Button>
              }
            />
            {data.acceptances.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface">
                <EmptyState size="compact" message="No conflict check is recorded for this client. Attest work can't be accepted without one." className="m-3" />
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
                {data.acceptances.map((r) => {
                  const o = OUTCOME[r.outcome] ?? { label: r.outcome, tone: "warning" as const }
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-text">{r.prospect_name}</span>
                        <span className="block text-xs text-text-muted">
                          {r.conflict_count ? `${r.conflict_count} possible ${r.conflict_count === 1 ? "conflict" : "conflicts"}` : "No conflict found"}
                          {r.independence_threat ? " · independence threat recorded" : ""}
                          {r.rationale ? ` · ${r.rationale}` : ""}
                        </span>
                      </span>
                      <StatusChip label={o.label} tone={o.tone} />
                      <span className="num w-28 text-right text-sm text-text-muted">
                        <DateText date={r.decided_at ?? r.created_at} />
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

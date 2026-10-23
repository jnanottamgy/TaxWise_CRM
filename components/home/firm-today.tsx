import Link from "next/link"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { PendingLeaveList } from "@/components/leave/leave-lists"
import type { AppRole } from "@/lib/auth/roles"
import type { AtRiskClient, SetupItem } from "@/lib/domain/dashboard"
import { fromPaise } from "@/lib/domain/money"
import { formatDate, formatTimeAgo } from "@/lib/format"
import type { ActivityItem, Approvals, Pipeline, PracticeHealth } from "@/lib/data/dashboard"
import type { PersonOption } from "@/lib/data/people"
import { Figure, RowLink } from "@/components/home/home-ui"
import { count } from "@/components/home/logic"

/**
 * Firm today's own blocks (§7.2 Partner): the setup checklist, approvals, practice health, at-risk
 * clients, the pipeline and recent activity. Server-safe; leave decisions are client islands.
 */

/** The setup checklist (§7.2), shown until every item is done: what's left first, as links. */
export function SetupChecklist({ items }: { items: SetupItem[] }) {
  const ordered = [...items.filter((i) => !i.done), ...items.filter((i) => i.done)]
  return (
    <ul className="grid grid-cols-1 gap-x-6 md:grid-cols-2 xl:grid-cols-3">
      {ordered.map((i) => (
        <li key={i.id} className="border-t border-border/70 first:border-t-0 md:[&:nth-child(2)]:border-t-0 xl:[&:nth-child(3)]:border-t-0">
          {i.done ? (
            <p className="flex min-h-11 items-center gap-2.5 py-2 text-base text-text-muted">
              <CheckIcon aria-hidden="true" className="size-4 flex-none text-success-text" />
              <span className="line-through decoration-text-muted/40">{i.label}</span>
              <span className="sr-only">(done)</span>
            </p>
          ) : (
            <Link
              href={i.href}
              className="flex min-h-11 items-center gap-2.5 py-2 text-base text-text transition-colors duration-150 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span aria-hidden="true" className="size-4 flex-none rounded-full border border-text-muted/60" />
              <span className="min-w-0 flex-1">{i.label}</span>
              <ChevronRightIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Approvals (§7.2): held invoices and quotations, leave requests (decided right here), DPDP data requests. */
export function ApprovalsBlock({ a, today, actorRole, staff }: { a: Approvals; today: string; actorRole: AppRole; staff: PersonOption[] }) {
  const lines: Array<{ label: string; n: number; href: string; sub?: React.ReactNode }> = [
    { label: "Invoices awaiting approval", n: a.invoices, href: "/invoices?status=awaiting_approval" },
    { label: "Quotations pending approval", n: a.quotations, href: "/quotations?status=pending_approval" },
    {
      label: "Data requests (DPDP)",
      n: a.dataRequests.total,
      href: "/quality",
      sub: a.dataRequests.nextDue ? (
        <>
          next due <DateText date={a.dataRequests.nextDue} withRelative today={today} />
        </>
      ) : undefined,
    },
  ]
  return (
    <div className="flex flex-col">
      <ul className="divide-y divide-border/70 px-4 md:px-5">
        {lines.map((l) => (
          <li key={l.label}>
            <Link href={l.href} className="flex min-h-11 items-center gap-3 py-2 transition-colors duration-150 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
              <span className="min-w-0 flex-1">
                <span className="block text-base text-text">{l.label}</span>
                {l.sub ? <span className="block text-sm text-text-muted">{l.sub}</span> : null}
              </span>
              <span className={cn("num text-lg font-semibold tabular-nums", l.n > 0 ? "text-text" : "text-text-muted")}>{l.n}</span>
              <ChevronRightIcon aria-hidden="true" className="size-4 text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="border-t border-border">
        <div className="flex items-baseline justify-between gap-3 px-4 pt-3 md:px-5">
          <h3 className="text-sm font-medium text-text">Leave requests</h3>
          <Link href="/leave" className="num text-sm text-text-muted hover:underline">
            {a.leave.total ? `${a.leave.total} waiting` : "None waiting"}
          </Link>
        </div>
        {a.leave.rows.length ? (
          <PendingLeaveList rows={a.leave.rows} actorRole={actorRole} staff={staff} />
        ) : (
          <p className="px-4 pt-1 pb-3 text-sm text-text-muted md:px-5">Nothing waiting for your decision.</p>
        )}
      </div>
    </div>
  )
}

function HealthItem({ title, href, children, alert = false }: { title: string; href: string; children: React.ReactNode; alert?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border/70 py-3 first:border-t-0 md:[&:nth-child(-n+2)]:border-t-0 xl:[&:nth-child(-n+3)]:border-t-0">
      <Link href={href} className="flex items-center gap-1.5 text-sm font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        {alert ? <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" /> : null}
        {title}
      </Link>
      <div className="text-sm text-text-muted">{children}</div>
    </div>
  )
}

const PEER_REVIEW_TEXT: Record<PracticeHealth["peerReview"]["state"], (h: PracticeHealth["peerReview"]) => string> = {
  missing: () => "No peer review certificate recorded.",
  expired: (h) => `Expired on ${formatDate(h.validUntil)}.`,
  expiring: (h) => `Valid until ${formatDate(h.validUntil)}: ${count(h.daysLeft ?? 0, "day")} left.`,
  valid: (h) => `Valid until ${formatDate(h.validUntil)}.`,
}

/**
 * Practice health (§7.2): UDINs due, tax audits against the ceiling, engagement letters, DSCs and
 * registrations, peer review, SA 230 file assembly, and WhatsApp coverage. Each heads to its register.
 */
export function PracticeHealthBlock({ h, today }: { h: PracticeHealth; today: string }) {
  const nearCeiling = h.taxAudits.filter((t) => t.warning)
  return (
    <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
      <HealthItem title="Signed reports without a UDIN" href="/registers?tab=udin" alert={h.udin.rows.some((u) => u.daysLate !== null)}>
        {h.udin.total === 0 ? (
          "Every signed audit report has its UDIN."
        ) : (
          <ul className="flex flex-col gap-0.5">
            {h.udin.rows.map((u) => (
              <li key={u.id} className="flex justify-between gap-3">
                <Link href={`/audits/${u.id}`} className="min-w-0 truncate text-text hover:underline">
                  {u.client_name}
                </Link>
                <span className={cn("num flex-none", u.daysLate !== null ? "text-danger-text" : (u.daysLeft ?? 99) <= 7 ? "text-warning-text" : undefined)}>
                  {u.daysLate !== null ? `${count(u.daysLate, "day")} late` : `${count(u.daysLeft ?? 0, "day")} left`}
                </span>
              </li>
            ))}
            {h.udin.total > h.udin.rows.length ? <li>And {h.udin.total - h.udin.rows.length} more.</li> : null}
          </ul>
        )}
      </HealthItem>

      <HealthItem title="Tax audits against the ceiling" href="/registers?tab=udin" alert={nearCeiling.some((t) => t.warning === "over" || t.warning === "at_ceiling")}>
        {h.taxAudits.length === 0 ? (
          "No active Partners."
        ) : (
          <ul className="flex flex-col gap-0.5">
            {h.taxAudits.map((t) => (
              <li key={t.memberId} className="flex justify-between gap-3">
                <span className="min-w-0 truncate text-text">{t.name}</span>
                <span className={cn("num flex-none", t.warning === "over" || t.warning === "at_ceiling" ? "text-danger-text" : t.warning === "near" ? "text-warning-text" : undefined)}>
                  {t.total} of {t.ceiling}
                </span>
              </li>
            ))}
          </ul>
        )}
      </HealthItem>

      <HealthItem title="Engagement letters" href="/engagement-letters" alert={h.engagementLetters.missing > 0}>
        <span className="num">{h.engagementLetters.missing}</span> active {h.engagementLetters.missing === 1 ? "client has" : "clients have"} no letter for this FY ·{" "}
        <span className="num">{h.engagementLetters.expiring}</span> expiring in 30 days
      </HealthItem>

      <HealthItem title="DSCs and registrations expiring" href="/registers?tab=dsc">
        <span className="num">{count(h.dscExpiring.count, "DSC")}</span>
        {h.dscExpiring.next ? (
          <>
            {" "}
            (first <DateText date={h.dscExpiring.next} withRelative today={today} />)
          </>
        ) : null}{" "}
        · <span className="num">{count(h.registrationsExpiring.count, "registration")}</span> in the next 30 days
      </HealthItem>

      <HealthItem title="Peer review" href="/quality" alert={h.peerReview.state === "expired" || h.peerReview.state === "missing"}>
        <span className={h.peerReview.state === "expiring" ? "text-warning-text" : h.peerReview.state === "valid" ? undefined : "text-danger-text"}>{PEER_REVIEW_TEXT[h.peerReview.state](h.peerReview)}</span>
      </HealthItem>

      <HealthItem title="Audit files to assemble (SA 230)" href="/audits" alert={h.assembly.rows.some((a) => a.due < today)}>
        {h.assembly.total === 0 ? (
          "No audit file's 60-day assembly date is within two weeks."
        ) : (
          <ul className="flex flex-col gap-0.5">
            {h.assembly.rows.map((a) => (
              <li key={a.id} className="flex justify-between gap-3">
                <Link href={`/audits/${a.id}`} className="min-w-0 truncate text-text hover:underline">
                  {a.client_name}
                </Link>
                <DateText date={a.due} withRelative today={today} className="flex-none" />
              </li>
            ))}
            {h.assembly.total > h.assembly.rows.length ? <li>And {h.assembly.total - h.assembly.rows.length} more.</li> : null}
          </ul>
        )}
      </HealthItem>

      <HealthItem title="WhatsApp" href="/clients?whatsapp=none&status=active" alert={h.whatsapp.numbers.some((n) => n.overLimit)}>
        <p>
          <span className="num">{h.whatsapp.withoutGroup}</span> of <span className="num">{h.whatsapp.activeClients}</span> active clients have no WhatsApp group.
        </p>
        {h.whatsapp.numbers.length ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {h.whatsapp.numbers.map((n) => (
              <li key={n.id} className="flex justify-between gap-3">
                <Link href="/settings/whatsapp" className="min-w-0 truncate text-text hover:underline">
                  {n.label}
                </Link>
                <span className={cn("num flex-none", n.overLimit ? "text-danger-text" : n.atLimit ? "text-warning-text" : undefined)}>
                  {n.limit !== null ? `${n.links} of ${n.limit} PCs` : `${count(n.links, "PC")}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">No firm WhatsApp numbers yet.</p>
        )}
      </HealthItem>
    </div>
  )
}

/** At-risk clients (§7.2): 3+ overdue tasks, or receivables over 90 days, worst first. */
export function AtRiskList({ rows }: { rows: AtRiskClient[] }) {
  if (rows.length === 0) return <EmptyState size="compact" message="No client has 3 or more overdue tasks or receivables over 90 days." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((c) => (
        <li key={c.clientId} className="flex min-h-11 items-center justify-between gap-3 py-2">
          <RowLink href={`/clients/${c.clientId}`}>{c.clientName || "Client"}</RowLink>
          <span className="flex flex-none flex-wrap justify-end gap-x-3 text-sm">
            {c.overdueTasks >= 3 ? <span className="num text-danger-text">{count(c.overdueTasks, "overdue task")}</span> : null}
            {c.receivablesOver90Paise > 0 ? (
              <span className="text-danger-text">
                <Money value={fromPaise(c.receivablesOver90Paise)} compact /> over 90 days
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Pipeline (§7.2): open leads, quotations out with clients and their value, conversion this FY. */
export function PipelineBlock({ p }: { p: Pipeline }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Figure label="Open leads" value={p.openLeads} href="/leads" />
      <Figure label="Quotations sent" value={<Money value={fromPaise(p.quotationsSent.valuePaise)} compact />} sub={`${count(p.quotationsSent.count, "quotation")} awaiting a response`} href="/quotations?status=sent,viewed" />
      <Figure
        label="Conversion this FY"
        value={p.conversion.percent === null ? <span className="text-text-muted">—</span> : `${p.conversion.percent}%`}
        sub={p.conversion.decided ? `${p.conversion.accepted} accepted of ${p.conversion.decided} decided` : "No quotation decided yet"}
        href="/quotations"
      />
    </div>
  )
}

/** Recent activity (§7.2): the latest entries of the activity log, who and when. */
export function ActivityList({ rows }: { rows: ActivityItem[] }) {
  if (rows.length === 0) return <EmptyState size="compact" message="Nothing has happened yet. Changes across the firm show here." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((r) => (
        <li key={r.id} className="flex min-h-11 items-start justify-between gap-3 py-2">
          <p className="min-w-0 text-base text-text">
            {r.description}
            {r.user_name ? <span className="text-text-muted"> · {r.user_name}</span> : null}
          </p>
          <span className="num flex-none text-sm whitespace-nowrap text-text-muted">{formatTimeAgo(r.at)}</span>
        </li>
      ))}
    </ul>
  )
}

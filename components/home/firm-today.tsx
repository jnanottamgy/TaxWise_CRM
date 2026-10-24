import Link from "next/link"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { DateText } from "@/components/app/date-text"
import { ThinBar } from "@/components/tasks/task-ui"
import { PendingLeaveList } from "@/components/leave/leave-lists"
import type { AppRole } from "@/lib/auth/roles"
import type { AtRiskClient, HealthLevel, SetupStep } from "@/lib/domain/dashboard"
import { formatINR } from "@/lib/domain/money"
import { formatTimeAgo } from "@/lib/format"
import type { ActivityItem, Counted, FirmApprovals, Pipeline } from "@/lib/data/dashboard"
import type { LeaveRow } from "@/lib/data/leave"
import type { PersonOption } from "@/lib/data/people"
import { Figure, RowLink } from "@/components/home/home-ui"
import { MoneyText, figure } from "@/components/home/kpi-grid"
import { count, moneyHref, practiceHref, workHref } from "@/components/home/logic"

/**
 * Firm today's own blocks (§7.2 Partner): the setup checklist, approvals, practice health, at-risk
 * clients, the pipeline and recent activity. Server-safe; leave decisions and Retry are client
 * islands.
 */

// -------------------------------------------------------------------------------------------------
// Setup checklist
// -------------------------------------------------------------------------------------------------

/**
 * The setup checklist (§7.2, §4.3), shown until every item is done: what is left first, each with
 * what is still missing and a link to the exact place to finish it; done items stay, struck
 * through, so the progress reads at its true size.
 */
export function SetupChecklist({ items, done, percent }: { items: SetupStep[]; done: number; percent: number }) {
  const ordered = [...items.filter((i) => !i.done), ...items.filter((i) => i.done)]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <ThinBar percent={percent} tone="primary" label={`Setup: ${done} of ${items.length} done`} className="max-w-64" />
        <span className="num flex-none text-sm text-text-muted">
          {done} of {items.length} done
        </span>
      </div>
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
                className="group flex min-h-11 items-center gap-2.5 rounded-sm py-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span aria-hidden="true" className="size-4 flex-none rounded-full border border-text-muted/60" />
                <span className="min-w-0 flex-1">
                  <span className="block text-base text-text group-hover:text-primary">{i.label}</span>
                  {i.detail ? <span className="block text-sm text-text-muted">{i.detail}</span> : null}
                </span>
                <ChevronRightIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Approvals
// -------------------------------------------------------------------------------------------------

function ApprovalLine({ label, n, href, sub }: { label: string; n: number; href: string; sub?: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="group flex min-h-12 items-center gap-3 py-2 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="min-w-0 flex-1">
          <span className="block text-base text-text group-hover:text-primary">{label}</span>
          {sub ? <span className="block text-sm text-text-muted">{sub}</span> : null}
        </span>
        <span className={cn("num text-lg leading-7 font-semibold tabular-nums", n > 0 ? "text-text" : "text-text-muted")}>{figure(n)}</span>
        <ChevronRightIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
      </Link>
    </li>
  )
}

/**
 * Approvals (§7.2): invoices held over the approval limit, quotations waiting for approval, leave
 * requests (decided right here, §7.11.3) and DPDP data requests (§6.10). Each count opens its list.
 */
export function ApprovalsBlock({
  a,
  leave,
  today,
  actorRole,
  staff,
}: {
  a: FirmApprovals
  leave: { ok: true; data: Counted<LeaveRow> } | { ok: false; ref: string }
  today: string
  actorRole: AppRole
  staff: PersonOption[]
}) {
  const dpdp = a.dataRequests
  return (
    <div className="flex flex-col">
      <ul className="divide-y divide-border/70 px-4 md:px-5">
        <ApprovalLine label="Invoices awaiting approval" n={a.invoices} href={moneyHref.awaitingApproval()} sub={a.invoices ? `${formatINR(a.invoicesPaise)} held over the limit` : "None held over the limit"} />
        <ApprovalLine label="Quotations pending approval" n={a.quotations} href={moneyHref.quotationsPending()} sub={a.quotations ? `${formatINR(a.quotationsPaise)} to approve` : "None waiting to be sent"} />
        <ApprovalLine
          label="Data requests (DPDP)"
          n={dpdp.open}
          href={dpdp.overdue ? practiceHref.dataRequestsOverdue() : practiceHref.dataRequests()}
          sub={
            dpdp.overdue ? (
              <span className="text-danger-text">{count(dpdp.overdue, "request")} past the reply date</span>
            ) : dpdp.nextDue ? (
              <>
                Next reply due <DateText date={dpdp.nextDue} withRelative today={today} />
              </>
            ) : dpdp.open ? (
              "No reply date set"
            ) : (
              "No open requests"
            )
          }
        />
      </ul>
      <div className="border-t border-border">
        <div className="flex items-baseline justify-between gap-3 px-4 pt-3 md:px-5">
          <h3 className="text-sm font-medium text-text">Leave requests</h3>
          <Link href="/leave" className="num rounded-sm text-sm text-text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {a.leave ? `${figure(a.leave)} waiting` : "None waiting"}
          </Link>
        </div>
        {!leave.ok ? (
          <ErrorBlock message="Couldn't load the leave requests." errorRef={leave.ref} size="compact" className="px-4 md:px-5" />
        ) : leave.data.rows.length ? (
          <>
            <PendingLeaveList rows={leave.data.rows} actorRole={actorRole} staff={staff} />
            {leave.data.total > leave.data.rows.length ? (
              <p className="px-4 pb-3 text-sm text-text-muted md:px-5">
                And {figure(leave.data.total - leave.data.rows.length)} more on{" "}
                <Link href="/leave" className="font-medium text-text underline-offset-2 hover:underline">
                  Leave
                </Link>
                .
              </p>
            ) : null}
          </>
        ) : (
          <p className="px-4 pt-1 pb-3 text-sm text-text-muted md:px-5">Nothing waiting for your decision.</p>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Practice health
// -------------------------------------------------------------------------------------------------

export type HealthItemView = {
  key: string
  title: string
  href: string
  /** null while unknown (the item failed to load). */
  level: HealthLevel | null
  body: React.ReactNode
} & ({ ok: true } | { ok: false; ref: string; message: string })

const LEVEL_DOT: Record<HealthLevel, string | null> = { act: "bg-danger", watch: "bg-warning", fine: null }
const LEVEL_WORD: Record<HealthLevel, string> = { act: "Needs action", watch: "Coming up", fine: "In order" }

/**
 * Practice health (§7.2 Partner; §6.8, §6.9, §6.10, §7.15, §7.25.7, §7.8.4): one cell per register,
 * a red dot where something is overdue or failing, an amber one where it is coming up, and each
 * title opening the register filtered to it. A register that fails to load says so in its own cell.
 */
export function PracticeHealthBlock({ items }: { items: HealthItemView[] }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
      {items.map((i) => (
        <div key={i.key} className="flex min-w-0 flex-col gap-1 border-t border-border/70 py-3 first:border-t-0 md:[&:nth-child(-n+2)]:border-t-0 xl:[&:nth-child(-n+3)]:border-t-0">
          <Link href={i.href} className="flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {i.level && LEVEL_DOT[i.level] ? <span aria-hidden="true" className={cn("size-1.5 flex-none rounded-full", LEVEL_DOT[i.level])} /> : null}
            {i.title}
            {i.level ? <span className="sr-only">({LEVEL_WORD[i.level]})</span> : null}
          </Link>
          {i.ok ? <div className="text-sm text-text-muted">{i.body}</div> : <ErrorBlock message={i.message} errorRef={i.ref} size="compact" className="px-0 py-0 text-sm" />}
        </div>
      ))}
    </div>
  )
}

/** A two-column line inside a health cell: the name (linked) and its figure. */
export function HealthRow({ href, name, value, tone }: { href?: string; name: React.ReactNode; value: React.ReactNode; tone?: "danger" | "warning" }) {
  return (
    <li className="flex justify-between gap-3">
      {href ? (
        <Link href={href} className="min-w-0 truncate rounded-sm text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {name}
        </Link>
      ) : (
        <span className="min-w-0 truncate text-text">{name}</span>
      )}
      <span className={cn("num flex-none", tone === "danger" ? "text-danger-text" : tone === "warning" ? "text-warning-text" : undefined)}>{value}</span>
    </li>
  )
}

// -------------------------------------------------------------------------------------------------
// At-risk clients, pipeline, recent activity
// -------------------------------------------------------------------------------------------------

/** At-risk clients (§7.2): 3+ overdue tasks, or receivables over 90 days, worst first. */
export function AtRiskList({ rows }: { rows: AtRiskClient[] }) {
  if (rows.length === 0) return <EmptyState size="compact" message="No client has 3 or more overdue tasks or receivables over 90 days." />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((c) => (
        <li key={c.clientId} className="flex min-h-11 flex-col justify-center gap-0.5 py-2">
          <RowLink href={`/clients/${c.clientId}`}>{c.clientName || "Client"}</RowLink>
          <p className="flex flex-wrap gap-x-3 text-sm">
            {c.reasons.includes("overdue_tasks") ? (
              <Link href={workHref.overdueForClient(c.clientId)} className="num text-danger-text underline-offset-2 hover:underline">
                {count(c.overdueTasks, "overdue task")}
              </Link>
            ) : null}
            {c.reasons.includes("old_receivables") ? (
              <Link href={`/clients/${c.clientId}?tab=billing`} className="text-danger-text underline-offset-2 hover:underline">
                <MoneyText paise={c.receivablesOver90Paise} /> over 90 days
              </Link>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  )
}

/** Pipeline (§7.2): open leads, quotations out with clients and their value, conversion this FY. */
export function PipelineBlock({ p, fy }: { p: Pipeline; fy: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Figure label="Open leads" value={figure(p.openLeads)} sub="Not yet won or lost" href={moneyHref.openLeads()} />
      <Figure
        label="Quotations sent"
        value={<MoneyText paise={p.quotationsSent.valuePaise} />}
        sub={`${count(p.quotationsSent.count, "quotation")} awaiting a response`}
        href={moneyHref.quotationsAwaiting()}
      />
      <Figure
        label={
          <>
            Conversion, <span className="whitespace-nowrap">FY {fy}</span>
          </>
        }
        value={p.conversion.percent === null ? <span className="text-text-muted">—</span> : `${p.conversion.percent}%`}
        sub={p.conversion.decided ? `${p.conversion.accepted} accepted of ${p.conversion.decided} decided` : "No quotation decided yet"}
        href={moneyHref.quotationsDecided()}
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

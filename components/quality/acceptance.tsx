import Link from "next/link"
import { Button } from "@/components/ui/button"
import { KpiStrip } from "@/components/app/kpi-strip"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { formatCount } from "@/components/app/data-table/params"
import type { AcceptanceSummary } from "@/lib/data/quality"

const OUTCOME: Record<string, { label: string; tone: "warning" | "success" | "danger"; meaning: string }> = {
  pending: { label: "Pending", tone: "warning", meaning: "Checked, waiting for a Partner's or Manager's decision." },
  accepted: { label: "Accepted", tone: "success", meaning: "Accepted, with the conflicts found frozen at the decision." },
  declined: { label: "Declined", tone: "danger", meaning: "Declined, with the rationale recorded." },
}

/**
 * Client acceptance and the conflict check, as the quality module sees it (§7.15.4 "Client
 * acceptance register", §7.5.4): the decisions made, those waiting, and the latest checks with
 * their conflicts and independence threats. The register itself, with the check and the decision,
 * is at /acceptance. Server-safe.
 */
export function AcceptanceSection({ s }: { s: AcceptanceSummary }) {
  return (
    <div className="flex flex-col gap-4">
      <KpiStrip
        items={[
          { label: "Waiting for a decision", value: formatCount(s.counts.pending), href: "/acceptance?outcome=pending" },
          { label: "Accepted", value: formatCount(s.counts.accepted), href: "/acceptance?outcome=accepted" },
          { label: "Declined", value: formatCount(s.counts.declined), href: "/acceptance?outcome=declined" },
        ]}
      />
      <section aria-labelledby="acc-title" className="rounded-lg border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
          <h2 id="acc-title" className="text-md font-semibold text-text">
            Latest conflict checks
          </h2>
          <Button asChild size="sm" variant="outline">
            <Link href="/acceptance">Open the register</Link>
          </Button>
        </div>
        {s.recent.length === 0 ? (
          <div className="px-4 pb-4 md:px-5">
            <EmptyState size="compact" message="No conflict checks yet. Run one before taking on a client, and always for attest work." />
          </div>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {s.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 md:px-5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-text">{r.client_display_name ?? r.prospect_name}</span>
                  <span className="block text-xs text-text-muted">
                    {(r.conflict_count ?? 0) > 0 ? `${r.conflict_count} possible ${r.conflict_count === 1 ? "conflict" : "conflicts"}` : "No conflict found"}
                    {r.independence_threat ? " · independence threat recorded" : ""}
                    {r.decided_by_name ? ` · decided by ${r.decided_by_name}` : ""}
                  </span>
                </span>
                {r.outcome && OUTCOME[r.outcome] ? <StatusChip label={OUTCOME[r.outcome].label} tone={OUTCOME[r.outcome].tone} meaning={OUTCOME[r.outcome].meaning} /> : null}
                <span className="num w-28 text-right text-sm text-text-muted">
                  <DateText date={r.decided_at ?? r.created_at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

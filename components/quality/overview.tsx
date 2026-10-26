import Link from "next/link"
import { ChevronRightIcon } from "lucide-react"
import type { StatusTone } from "@/lib/status"
import { formatDate } from "@/lib/format"
import { istDateOf } from "@/lib/domain/fy"
import type { QualityOverview } from "@/lib/data/quality"
import { QUALITY_FRAMEWORK_LABELS, RESTORE_OUTCOME_INFO, type QualityTab, type RestoreOutcome } from "@/lib/schemas/quality"
import { toneClasses } from "@/components/app/tones"
import { cn } from "@/lib/utils"

type Area = { tab: QualityTab; label: string; tone: StatusTone; state: string; group: "Quality" | "Data protection" }

const RANK: Record<StatusTone, number> = { danger: 0, warning: 1, violet: 2, info: 3, neutral: 4, muted: 5, success: 6 }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Each area of the quality system with its state in one line (§7.15.4, §6.8, §6.10, §12). Pure. */
export function qualityAreas(o: QualityOverview, fy: string): Area[] {
  const kycBad = o.kyc.missing + o.kyc.incomplete
  const kycTotal = kycBad + o.kyc.review_due + o.kyc.current
  const drillOutcome = o.restoreDrill.lastOutcome as RestoreOutcome | null
  const areas: Area[] = [
    {
      tab: "manual",
      label: "Quality manual",
      group: "Quality",
      ...(o.manual.total === 0
        ? { tone: "warning" as const, state: `No items yet. Record the firm's policies under each ${o.framework === "sqm1" ? "SQM 1 component" : "SQC 1 element"}.` }
        : o.manual.reviewDue > 0
          ? { tone: "warning" as const, state: `${plural(o.manual.reviewDue, "item is", "items are")} due for review, of ${o.manual.total}.` }
          : { tone: "success" as const, state: `All ${o.manual.total} items reviewed within their cycle.` }),
    },
    {
      tab: "peer-reviews",
      label: "Peer review",
      group: "Quality",
      ...(o.peerReview.state === "missing"
        ? { tone: "danger" as const, state: "No peer review certificate is recorded." }
        : o.peerReview.state === "expired"
          ? { tone: "danger" as const, state: `The certificate expired on ${formatDate(o.peerReview.validUntil)}.` }
          : o.peerReview.state === "expiring"
            ? { tone: "warning" as const, state: `The certificate expires on ${formatDate(o.peerReview.validUntil)}, in ${plural(o.peerReview.daysLeft ?? 0, "day", "days")}.` }
            : { tone: "success" as const, state: `Certificate${o.peerReview.certificateNo ? ` ${o.peerReview.certificateNo}` : ""} valid until ${formatDate(o.peerReview.validUntil)}.` }),
    },
    {
      tab: "acceptance",
      label: "Client acceptance",
      group: "Quality",
      ...(o.acceptancePending > 0 ? { tone: "warning" as const, state: `${plural(o.acceptancePending, "conflict check waits", "conflict checks wait")} for a decision.` } : { tone: "success" as const, state: "No conflict check is waiting for a decision." }),
    },
    {
      tab: "kyc",
      label: "KYC",
      group: "Quality",
      ...(kycTotal === 0
        ? { tone: "muted" as const, state: "No attest clients yet: KYC is kept for audit and certification clients." }
        : kycBad > 0
          ? { tone: "danger" as const, state: `${plural(kycBad, "attest client has", "attest clients have")} no complete KYC, so their audits stay at Acceptance.` }
          : o.kyc.review_due > 0
            ? { tone: "warning" as const, state: `${plural(o.kyc.review_due, "client's", "clients'")} annual re-confirmation is due.` }
            : { tone: "success" as const, state: `All ${kycTotal} attest clients' KYC is current.` }),
    },
    {
      tab: "previous-auditors",
      label: "Previous auditors",
      group: "Quality",
      ...(o.previousAuditor.awaitingReply > 0
        ? { tone: "info" as const, state: `${plural(o.previousAuditor.awaitingReply, "letter has", "letters have")} no reply recorded yet.` }
        : { tone: "success" as const, state: o.previousAuditor.total ? `${plural(o.previousAuditor.total, "letter", "letters")} recorded; every one answered or closed.` : "No letters to previous auditors yet." }),
    },
    {
      tab: "independence",
      label: "Independence",
      group: "Quality",
      ...(o.independence.declared < o.independence.staff
        ? { tone: "warning" as const, state: `${o.independence.declared} of ${o.independence.staff} staff have declared for FY ${fy}.` }
        : o.independence.withExceptions > 0
          ? { tone: "info" as const, state: `Everyone has declared for FY ${fy}; ${plural(o.independence.withExceptions, "declaration lists", "declarations list")} exceptions to check.` }
          : { tone: "success" as const, state: `All ${o.independence.staff} staff have declared for FY ${fy}, with no exceptions.` }),
    },
    {
      tab: "retention",
      label: "Retention",
      group: "Quality",
      ...(o.disposal > 0 ? { tone: "warning" as const, state: `${plural(o.disposal, "document is", "documents are")} past retention, to review for disposal.` } : { tone: "success" as const, state: "No document is past its retention date." }),
    },
    {
      tab: "restore-drills",
      label: "Restore drill",
      group: "Quality",
      ...(o.restoreDrill.thisQuarter
        ? { tone: drillOutcome === "passed" ? ("success" as const) : ("warning" as const), state: `Done ${formatDate(o.restoreDrill.lastOn)} this quarter: ${drillOutcome ? RESTORE_OUTCOME_INFO[drillOutcome].label.toLowerCase() : "recorded"}.` }
        : { tone: drillOutcome === "failed" ? ("danger" as const) : ("warning" as const), state: o.restoreDrill.lastOn ? `Not recorded this quarter. The last was on ${formatDate(o.restoreDrill.lastOn)}.` : "No restore drill has been recorded." }),
    },
    {
      tab: "notices",
      label: "Privacy notice",
      group: "Data protection",
      ...(!o.notice.version
        ? { tone: "danger" as const, state: "No privacy notice is published, so portal users have nothing to acknowledge." }
        : o.notice.draftPending
          ? { tone: "info" as const, state: `${o.notice.version} is in force; a new draft is waiting to be published.` }
          : { tone: "success" as const, state: `${o.notice.version} in force since ${o.notice.publishedAt ? formatDate(istDateOf(o.notice.publishedAt)) : "publication"}.` }),
    },
    {
      tab: "data-requests",
      label: "Data requests",
      group: "Data protection",
      ...(o.dataRequests.overdue > 0
        ? { tone: "danger" as const, state: `${plural(o.dataRequests.overdue, "request is", "requests are")} past the due date, of ${o.dataRequests.open} open.` }
        : o.dataRequests.open > 0
          ? { tone: "warning" as const, state: `${plural(o.dataRequests.open, "request is", "requests are")} open, none overdue.` }
          : { tone: "success" as const, state: "No data principal's request is open." }),
    },
    {
      tab: "incidents",
      label: "Incidents",
      group: "Data protection",
      ...(o.incidents.boardOverdue > 0
        ? { tone: "danger" as const, state: `${plural(o.incidents.boardOverdue, "breach report to the Board is", "breach reports to the Board are")} late.` }
        : o.incidents.open > 0
          ? { tone: "warning" as const, state: `${plural(o.incidents.open, "incident is", "incidents are")} open on the breach checklist.` }
          : { tone: "success" as const, state: "No open personal data breach." }),
    },
  ]
  return areas
}

/**
 * The quality module's overview (§7.15.4): "Is the quality system current, and what needs a Partner
 * now?" Every area in one list, those needing attention first, each opening its section.
 * Server-safe.
 */
export function QualityOverviewView({ o, fy }: { o: QualityOverview; fy: string }) {
  const areas = qualityAreas(o, fy).sort((a, b) => RANK[a.tone] - RANK[b.tone])
  const attention = areas.filter((a) => a.tone === "danger" || a.tone === "warning").length
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="areas-title" className="rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-3 md:px-5">
          <h2 id="areas-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            {attention ? `${plural(attention, "area needs", "areas need")} attention` : "Nothing needs attention"}
          </h2>
          <span className="text-sm text-text-muted">{QUALITY_FRAMEWORK_LABELS[o.framework]}</span>
        </div>
        <ul className="divide-y divide-border border-t border-border">
          {areas.map((a) => {
            const t = toneClasses(a.tone)
            return (
              <li key={a.tab}>
                {/* Phones: the area's name, then its state on the full width under it (side by side, the
                    sentence was squeezed into a narrow column of four or five lines). */}
                <Link
                  href={`/quality?tab=${a.tab}`}
                  className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
                >
                  <span aria-hidden="true" className={cn("size-2 flex-none self-start rounded-full max-sm:mt-1.5 sm:self-center", t.dot)} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-sm font-medium text-text sm:w-36 sm:flex-none md:w-44">{a.label}</span>
                    <span className={cn("min-w-0 flex-1 text-sm", a.tone === "danger" || a.tone === "warning" ? t.text : "text-text-muted")}>{a.state}</span>
                  </span>
                  <span className="hidden flex-none text-xs text-text-muted md:inline">{a.group}</span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
                </Link>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

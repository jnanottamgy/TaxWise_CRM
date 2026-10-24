import Link from "next/link"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { AUDIT_STAGES, AUDIT_STAGE_LABELS, STAGE_STANDARDS, type AuditStage } from "@/lib/domain/audit-stages"
import { trackerState } from "@/components/audits/audit-ui"

/**
 * The stage tracker (§7.15.5): Acceptance → Planning → Risk assessment → Execution → Completion →
 * Reporting → Archive, with the Standards each rests on. Done stages carry a tick, the current
 * one its dot; each opens that stage's checklist (`?stage=`). Scrolls inside its own frame on a
 * phone, never the page. Server-safe.
 */
export function StageTracker({ current, viewing, hrefFor, progress }: { current: AuditStage; viewing: AuditStage; hrefFor: (s: AuditStage) => string; progress: Partial<Record<AuditStage, { done: number; total: number }>> }) {
  return (
    <nav aria-label="Audit stages" className="-mx-4 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
      <ol className="flex w-max min-w-full divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {AUDIT_STAGES.map((s, i) => {
          const st = trackerState(s, current, AUDIT_STAGES)
          const selected = s === viewing
          const p = progress[s]
          return (
            <li key={s} className="min-w-[9.5rem] flex-1">
              <Link
                href={hrefFor(s)}
                aria-current={s === current ? "step" : undefined}
                className={cn(
                  "flex h-full flex-col gap-1 px-3 py-2.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  selected ? "bg-primary-soft" : "hover:bg-surface-2"
                )}
              >
                <span className="flex items-center gap-1.5">
                  {st === "done" ? (
                    <CheckIcon aria-hidden="true" className="size-3.5 flex-none text-success-text" />
                  ) : (
                    <span aria-hidden="true" className={cn("size-2 flex-none rounded-full", st === "current" ? "bg-primary" : "bg-transparent ring-[1.5px] ring-inset ring-text-muted")} />
                  )}
                  <span className={cn("text-sm whitespace-nowrap", selected ? "font-medium text-primary" : st === "ahead" ? "text-text-muted" : "font-medium text-text")}>
                    {i + 1}. {AUDIT_STAGE_LABELS[s]}
                  </span>
                  <span className="sr-only">{st === "done" ? "(done)" : st === "current" ? "(current stage)" : "(ahead)"}</span>
                </span>
                <span className="text-xs whitespace-nowrap text-text-muted">{STAGE_STANDARDS[s]}</span>
                {p && p.total ? (
                  <span className="num text-xs text-text-muted">
                    {p.done} of {p.total} signed
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

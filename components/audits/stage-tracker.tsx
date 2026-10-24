import * as React from "react"
import Link from "next/link"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { AUDIT_STAGES, AUDIT_STAGE_LABELS, STAGE_STANDARDS, type AuditStage } from "@/lib/domain/audit-stages"
import { trackerState } from "@/components/audits/audit-ui"

/**
 * The stage tracker (§7.15.5): Acceptance → Planning → Risk assessment → Execution → Completion →
 * Reporting → Archive, with the Standards each rests on. Done stages carry a tick, the current
 * one its dot; each opens that stage's checklist (`?stage=`). Server-safe.
 *
 * Sizing: the row is as wide as the page, or as wide as the seven stages need at their narrowest
 * (`w-min`: each stage's name on one line, its Standards wrapping under it), whichever is wider; past
 * that it scrolls inside its own frame (a phone), never the page. Each Standard ("SA 330") stays on
 * one line. The frame is `relative` so the screen-reader-only text of a stage scrolled out of view is
 * clipped with it instead of widening the page.
 */
export function StageTracker({ current, viewing, hrefFor, progress }: { current: AuditStage; viewing: AuditStage; hrefFor: (s: AuditStage) => string; progress: Partial<Record<AuditStage, { done: number; total: number }>> }) {
  return (
    <nav aria-label="Audit stages" className="relative -mx-4 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
      <ol className="flex w-min min-w-full divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {AUDIT_STAGES.map((s, i) => {
          const st = trackerState(s, current, AUDIT_STAGES)
          const selected = s === viewing
          const p = progress[s]
          return (
            <li key={s} className="relative flex-1">
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
                <span className="text-xs text-text-muted">
                  {STAGE_STANDARDS[s].split(" · ").map((ref, k) => (
                    <React.Fragment key={ref}>
                      {k > 0 ? " · " : null}
                      <span className="whitespace-nowrap">{ref}</span>
                    </React.Fragment>
                  ))}
                </span>
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

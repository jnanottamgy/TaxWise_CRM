"use client"

import { ArrowLeftIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AUDIT_STAGE_LABELS, nextStage, previousStage, type AuditStage, type GateResult } from "@/lib/domain/audit-stages"
import { useAuditWorkspace } from "@/components/audits/audit-workspace"

const sentence = (m: string) => `${m.charAt(0).toUpperCase()}${m.slice(1).replace(/\.?$/, ".")}`

/**
 * What stands between the engagement and its next stage (§6.9, §18.3 Partner 3), as the database
 * gate reports it (audit_stage_gate, 0196), with the engagement partner's approval: only they move
 * the engagement on (one stage at a time) or back (with a reason). Everyone else sees who approves.
 */
export function GatePanel({ stage, gate, isEngagementPartner, partnerName, canWork }: { stage: AuditStage; gate: GateResult | null; isEngagementPartner: boolean; partnerName: string | null; canWork: boolean }) {
  const { open } = useAuditWorkspace()
  const to = nextStage(stage)
  const back = previousStage(stage)
  if (!to) return null
  const ready = gate?.ok === true
  const approver = partnerName ?? "the engagement partner"
  const nextLabel = to === "archived" ? "Archive" : AUDIT_STAGE_LABELS[to]
  return (
    <section aria-labelledby="gate-title" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-start md:justify-between md:px-5">
        <div className="min-w-0 flex-1">
          <h2 id="gate-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            {ready ? `Ready for ${nextLabel}` : `Before ${nextLabel}`}
          </h2>
          {gate === null ? (
            <p className="mt-1 text-sm text-text-muted">The checks couldn&apos;t be read just now. Reload the page to see what&apos;s left.</p>
          ) : ready ? (
            <p className="mt-1 text-sm text-text-muted">
              Every step of {AUDIT_STAGE_LABELS[stage]} is prepared and reviewed{stage === "acceptance" ? ", and the acceptance checks pass" : ""}.{" "}
              {isEngagementPartner ? "Your approval moves it on." : `${approver} approves the move.`}
            </p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-text">
              {gate.missing.map((m, i) => (
                <li key={`${m.code}-${i}`}>{sentence(m.message)}</li>
              ))}
            </ul>
          )}
          {gate?.warnings.length ? (
            <ul className="mt-2 space-y-1 text-sm text-warning-text">
              {gate.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>{sentence(w.message)}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2 md:justify-end">
          {back && canWork ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!isEngagementPartner}
              title={isEngagementPartner ? undefined : `Only ${approver} can move the engagement back.`}
              onClick={() => open({ kind: "move", to: back })}
            >
              <ArrowLeftIcon aria-hidden="true" />
              Back to {AUDIT_STAGE_LABELS[back]}
            </Button>
          ) : null}
          {canWork ? (
            <Button
              type="button"
              size="sm"
              disabled={!ready || !isEngagementPartner}
              title={!isEngagementPartner ? `Only ${approver}, the engagement partner, approves stage moves.` : !ready ? "Finish what's listed first." : undefined}
              onClick={() => open({ kind: "move", to })}
            >
              {to === "archived" ? "Archive the file" : `Approve: move to ${AUDIT_STAGE_LABELS[to]}`}
            </Button>
          ) : null}
        </div>
      </div>
      {!isEngagementPartner && canWork ? <p className="border-t border-border px-4 py-2.5 text-sm text-text-muted md:px-5">{approver} is the engagement partner and approves each move. Prepare and review the steps; they are told when the stage is ready.</p> : null}
    </section>
  )
}

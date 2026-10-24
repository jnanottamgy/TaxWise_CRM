import type { StatusTone } from "@/lib/status"
import { STEP_STATE_LABELS, isAuditStage, isAuditType, AUDIT_TYPE_LABELS, type AssemblyCountdown, type AuditStage, type StepState } from "@/lib/domain/audit-stages"
import { STAGE_CHIP } from "@/lib/schemas/audits"

/**
 * Presentation helpers for audit engagements (§6.9, §7.15.5): the stage chip, the step-state chip
 * and the SA 230 assembly countdown in words. Pure and client-safe.
 */

export type Chip = { label: string; tone: StatusTone; meaning?: string }

export function stageChip(stage: string | null | undefined): Chip {
  if (!isAuditStage(stage)) return { label: "Unknown stage", tone: "muted" }
  return STAGE_CHIP[stage]
}

export function auditTypeLabel(t: string | null | undefined): string {
  return isAuditType(t) ? AUDIT_TYPE_LABELS[t] : "Audit"
}

const STEP_TONE: Record<StepState, StatusTone> = { not_started: "muted", prepared: "violet", not_applicable: "violet", reviewed: "success" }
const STEP_MEANING: Record<StepState, string> = {
  not_started: "To prepare: nobody has signed this step yet.",
  prepared: "Awaiting review: prepared, and waits for someone who didn't prepare it to review it.",
  not_applicable: "Not applicable, awaiting review: marked not applicable with a reason, and waits for a reviewer.",
  reviewed: "Reviewed: prepared (or marked not applicable) and reviewed. The step is done.",
}

export function stepChip(state: StepState): Chip {
  return { label: STEP_STATE_LABELS[state], tone: STEP_TONE[state], meaning: STEP_MEANING[state] }
}

/** The countdown in words and its tone: "18 days left", "3 days overdue", "Assembled on time". */
export function assemblyWords(c: AssemblyCountdown): Chip {
  switch (c.state) {
    case "no_report":
      return { label: "No report date yet", tone: "muted", meaning: "The 60-day assembly period (SA 230) starts on the report date." }
    case "running":
      return { label: `${c.daysLeft} days left`, tone: "neutral", meaning: "Assemble the final audit file within 60 days of the report date (SA 230)." }
    case "due_soon":
      return { label: c.daysLeft === 0 ? "Due today" : `${c.daysLeft} ${c.daysLeft === 1 ? "day" : "days"} left`, tone: "warning", meaning: "The 60-day file assembly date (SA 230) is near. Finish the archive steps and archive the file." }
    case "overdue":
      return { label: `${c.daysLate} ${c.daysLate === 1 ? "day" : "days"} overdue`, tone: "danger", meaning: "The final file should have been assembled within 60 days of the report date (SA 230)." }
    case "assembled":
      return { label: "Assembled on time", tone: "success", meaning: "Archived within 60 days of the report date (SA 230)." }
    case "assembled_late":
      return { label: `Assembled ${c.daysLate} ${c.daysLate === 1 ? "day" : "days"} late`, tone: "warning", meaning: "Archived after the 60-day assembly date (SA 230)." }
  }
}

/** The stages, in order, with a "done / current / ahead" mark for the tracker. */
export function trackerState(stage: AuditStage, current: AuditStage, order: readonly AuditStage[]): "done" | "current" | "ahead" {
  const i = order.indexOf(stage)
  const c = order.indexOf(current)
  if (current === "archived") return "done"
  return i < c ? "done" : i === c ? "current" : "ahead"
}

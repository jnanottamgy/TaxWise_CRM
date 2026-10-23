/**
 * The board's move rules (§7.6.1 Board, §7.6.4): which columns a card may be dropped on, using the
 * same checks as the status menu (lib/domain/transitions.ts). A board card knows how many of its
 * blockers are open but not their titles, so a dependency refusal names the count instead. Pure.
 */

import type { AppRole, TaskAcceptance, TaskStatus } from "@/lib/domain/enums"
import { DEPENDENCY_GATED_STATUSES, nextStatusOptions, type NextStatusOption } from "@/lib/domain/transitions"

export type BoardCardFacts = {
  status: TaskStatus
  assigned_employee_id: string | null
  acceptance_status: TaskAcceptance
  declined_by_employee_id: string | null
  open_blockers: number
}

export function boardMoveOptions(card: BoardCardFacts, viewer: { role: AppRole; employeeId: string | null }): NextStatusOption[] {
  const options = nextStatusOptions({
    from: card.status,
    actorRole: viewer.role,
    actorEmployeeId: viewer.employeeId,
    assigneeEmployeeId: card.assigned_employee_id,
    acceptance: card.acceptance_status,
    declinedByEmployeeId: card.declined_by_employee_id,
    blockers: [],
  })
  if (card.open_blockers <= 0) return options
  const n = card.open_blockers
  const error = `Waiting on ${n} blocking ${n === 1 ? "task that isn't" : "tasks that aren't"} Filed/Done yet.`
  return options.map((o) => (o.allowed && DEPENDENCY_GATED_STATUSES.includes(o.status) ? { ...o, allowed: false, error } : o))
}

/** The option for a drop on `to`, or a refusal sentence for a drop that can't happen. */
export function dropCheck(card: BoardCardFacts, to: TaskStatus, viewer: { role: AppRole; employeeId: string | null }): { ok: true; requiresReason: boolean } | { ok: false; error: string } {
  if (card.status === to) return { ok: false, error: "It's already in this column." }
  const o = boardMoveOptions(card, viewer).find((x) => x.status === to)
  if (!o) return { ok: false, error: "That move isn't possible." }
  return o.allowed ? { ok: true, requiresReason: o.requiresReason } : { ok: false, error: o.error ?? "That move isn't possible." }
}

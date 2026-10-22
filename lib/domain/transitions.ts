/**
 * Task status rules (§7.6.3, §7.6.4), enforced here for the UI and again in the Postgres function
 * `change_task_status` (§4.6), which must agree with this module.
 *
 * - **Moves:** any move is allowed, including backwards, except a no-op (refused, not silently
 *   written) and Filed/Done → Not started ("already done and filed; reopen to In progress instead").
 * - **Acceptance:** status can't change until the task is accepted; the decliner can't update a task
 *   they declined (§7.6.3).
 * - **Who:** Employees change only tasks assigned to them (§4.6). Employees cannot set Filed/Done
 *   (they submit Under review); Managers may file work they didn't do; nobody files their own
 *   (separation of duties); Partners may file anything (§4.1).
 * - **Reason required:** sending back (Under review → In progress), reopening (Filed/Done →
 *   anything) and putting On hold.
 * - **Dependencies:** no move to In progress, Under review or Filed/Done while any blocker isn't
 *   Filed/Done; the error names the blocker.
 * - **Derived values:** `completion_date` set when first Filed/Done, kept on re-save, cleared on
 *   reopen; escalation resets on reopen; overdue is computed, never stored.
 * - **Notifications:** Under review → the named reviewer, otherwise all Managers · Sent back → the
 *   assignee with the reason · Filed → the assignee, plus the client's owner if different · Data
 *   awaited → the Manager's call list (§7.6.4, §9).
 *
 * Pure and client-safe.
 */

import { TASK_STATUSES, type AppRole, type NotificationType, type TaskAcceptance, type TaskStatus } from "@/lib/domain/enums";

/** Status names as the rules and their messages use them (§3.6, §7.6.4). */
export const TASK_STATUS_NAMES: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  data_awaited: "Data awaited",
  under_review: "Under review",
  filed_done: "Filed/Done",
  on_hold: "On hold",
};

/** Moves into these statuses wait until every blocker is Filed/Done (§7.6.4). */
export const DEPENDENCY_GATED_STATUSES: readonly TaskStatus[] = ["in_progress", "under_review", "filed_done"];

export type BlockerTask = { id: string; title: string; status: TaskStatus };

/** Everything about the task and the person moving it, apart from the target status. */
export type TransitionContext = {
  from: TaskStatus;
  actorRole: AppRole | null;
  actorEmployeeId: string | null;
  assigneeEmployeeId: string | null;
  acceptance: TaskAcceptance;
  /** `tasks.declined_by_employee_id`: the person who declined it, if anyone did (§7.6.3). */
  declinedByEmployeeId?: string | null;
  /** The tasks this one is blocked by (`task_dependencies`), with their current status. */
  blockers?: readonly BlockerTask[];
};

export type TransitionRequest = TransitionContext & { to: TaskStatus; reason?: string | null };

export type TransitionErrorCode =
  | "forbidden"
  | "noop"
  | "declined_by_you"
  | "not_accepted"
  | "not_assignee"
  | "reopen_to_not_started"
  | "employee_cannot_file"
  | "own_work"
  | "blocked"
  | "reason_required";

export type TransitionCheck = { ok: true } | { ok: false; error: string; code: TransitionErrorCode; field?: "reason" };

/** Under review → In progress: the reviewer sends the work back (§7.6.4). */
export function isSendBack(from: TaskStatus, to: TaskStatus): boolean {
  return from === "under_review" && to === "in_progress";
}

/** Filed/Done → anything else: a reopen (§7.6.4). */
export function isReopen(from: TaskStatus, to: TaskStatus): boolean {
  return from === "filed_done" && to !== "filed_done";
}

/**
 * True when the move needs a reason (§7.6.4): sending back, reopening, and putting On hold.
 * A no-op needs nothing (it is refused anyway).
 */
export function requiresReason(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  return isSendBack(from, to) || isReopen(from, to) || to === "on_hold";
}

function reasonPrompt(from: TaskStatus, to: TaskStatus): string {
  if (isReopen(from, to)) return "Give a reason for reopening this task.";
  if (isSendBack(from, to)) return "Give a reason for sending this back; the assignee sees it.";
  return "Give a reason for putting this task on hold.";
}

function quoteList(titles: readonly string[]): string {
  const q = titles.map((t) => `“${t}”`);
  return q.length <= 1 ? q.join("") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/** The open blockers: tasks this one depends on that aren't Filed/Done yet. */
export function openBlockers(blockers: readonly BlockerTask[] | undefined): BlockerTask[] {
  return (blockers ?? []).filter((b) => b.status !== "filed_done");
}

function refuse(code: TransitionErrorCode, error: string, field?: "reason"): TransitionCheck {
  return field ? { ok: false, error, code, field } : { ok: false, error, code };
}

/** The checks, in the order their refusals are reported; `ignoreReason` serves the status menu. */
function check(req: TransitionRequest, ignoreReason: boolean): TransitionCheck {
  const { from, to, actorRole } = req;
  if (actorRole !== "partner" && actorRole !== "manager" && actorRole !== "employee") {
    return refuse("forbidden", "Only the firm's staff can change a task's status.");
  }
  if (from === to) return refuse("noop", `This task is already ${TASK_STATUS_NAMES[to]}.`);

  if (req.declinedByEmployeeId && req.actorEmployeeId === req.declinedByEmployeeId) {
    const takenBack = req.assigneeEmployeeId === req.actorEmployeeId && req.acceptance === "accepted";
    if (!takenBack) return refuse("declined_by_you", "You declined this task, so you can't update it.");
  }
  if (req.acceptance === "pending") {
    return refuse("not_accepted", "This task is waiting for acceptance. Its status can change once the assignee accepts it.");
  }
  if (req.acceptance === "declined") {
    return refuse("not_accepted", "This task was declined. Reassign it; its status can change once the new assignee accepts it.");
  }
  if (actorRole === "employee" && (req.actorEmployeeId === null || req.actorEmployeeId !== req.assigneeEmployeeId)) {
    return refuse("not_assignee", "You can only change the status of tasks assigned to you.");
  }

  if (from === "filed_done" && to === "not_started") {
    return refuse("reopen_to_not_started", "This task is already done and filed; reopen it to In progress instead.");
  }
  if (to === "filed_done") {
    if (actorRole === "employee") {
      return refuse("employee_cannot_file", "Employees can't set Filed/Done. Submit it for review (Under review) instead.");
    }
    if (actorRole === "manager" && req.actorEmployeeId !== null && req.actorEmployeeId === req.assigneeEmployeeId) {
      return refuse("own_work", "Nobody files their own work. Ask another Manager or a Partner to file it.");
    }
  }

  if (DEPENDENCY_GATED_STATUSES.includes(to)) {
    const open = openBlockers(req.blockers);
    if (open.length > 0) {
      const verb = open.length === 1 ? "which isn't" : "which aren't";
      return refuse("blocked", `Blocked by ${quoteList(open.map((b) => b.title))}, ${verb} Filed/Done yet.`);
    }
  }

  if (!ignoreReason && requiresReason(from, to) && !(req.reason ?? "").trim()) {
    return refuse("reason_required", reasonPrompt(from, to), "reason");
  }
  return { ok: true };
}

/**
 * Whether a status change is allowed (§7.6.3, §7.6.4). A refusal carries one plain sentence (naming
 * the blocker for a dependency block) and `field: "reason"` when only the reason is missing.
 */
export function canTransition(req: TransitionRequest): TransitionCheck {
  return check(req, false);
}

export type NextStatusOption = {
  status: TaskStatus;
  allowed: boolean;
  /** The dialog must ask for a reason (send back, reopen, on hold). */
  requiresReason: boolean;
  /** Why the move is refused, for a disabled menu item's hint. */
  error?: string;
};

/**
 * Every other status with whether it is allowed now and whether it needs a reason (the status
 * chip's menu, §7.6.6). The reason itself is collected by the dialog, so it isn't checked here.
 */
export function nextStatusOptions(ctx: TransitionContext): NextStatusOption[] {
  return TASK_STATUSES.filter((s) => s !== ctx.from).map((status) => {
    const result = check({ ...ctx, to: status }, true);
    const option: NextStatusOption = { status, allowed: result.ok, requiresReason: requiresReason(ctx.from, status) };
    return result.ok ? option : { ...option, error: result.error };
  });
}

/** The statuses the task can move to now (§7.6.6 "status chip with its allowed next moves"). */
export function allowedNextStatuses(ctx: TransitionContext): { status: TaskStatus; requiresReason: boolean }[] {
  return nextStatusOptions(ctx)
    .filter((o) => o.allowed)
    .map((o) => ({ status: o.status, requiresReason: o.requiresReason }));
}

// -------------------------------------------------------------------------------------------------
// Derived values and notifications (§7.6.4, §9)
// -------------------------------------------------------------------------------------------------

/** Who a notification goes to: one person, or everyone holding a role (e.g. "all Managers"). */
export type NotificationTarget = { kind: "employee"; employeeId: string } | { kind: "role"; role: "manager" | "partner" };

export type TransitionNotification = {
  type: Extract<NotificationType, "review_requested" | "task_sent_back" | "task_approved">;
  targets: NotificationTarget[];
  /** The reason, for a send-back ("Sent back to you" shows it, §9). */
  reason?: string;
};

export type TransitionKind = "file" | "reopen" | "send_back" | "submit_for_review" | "hold" | "data_awaited" | "move";

export type TransitionEffectsInput = {
  from: TaskStatus;
  to: TaskStatus;
  reason?: string | null;
  now: Date;
  /** `tasks.completion_date` before the change (timestamptz as returned, or null). */
  currentCompletionDate: string | Date | null;
  actorEmployeeId: string | null;
  assigneeEmployeeId: string | null;
  reviewerEmployeeId: string | null;
  /** `clients.owner_employee_id` of the task's client. */
  clientOwnerEmployeeId: string | null;
};

export type TransitionEffects = {
  kind: TransitionKind;
  /** The value to store in `tasks.completion_date` (ISO timestamp or null). */
  completionDate: string | null;
  /** Reopen resets `escalation_level` to 0 and clears `escalated_at` (§7.6.4, §7.6.7). */
  resetEscalation: boolean;
  /** `tasks.on_hold_reason`: the reason while On hold, cleared on leaving it, else unchanged. */
  onHoldReason: string | null | undefined;
  /** The `task_status_history` row (who and when are added by the caller). */
  history: { fromStatus: TaskStatus; toStatus: TaskStatus; reason: string | null };
  notifications: TransitionNotification[];
  /** Data awaited puts the task on the Manager's call list (§7.6.4, §7.2). */
  addsToCallList: boolean;
};

function iso(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}

/** The kind of move, for the timeline wording and the notification. */
export function transitionKind(from: TaskStatus, to: TaskStatus): TransitionKind {
  if (to === "filed_done") return "file";
  if (isReopen(from, to)) return "reopen";
  if (isSendBack(from, to)) return "send_back";
  if (to === "under_review") return "submit_for_review";
  if (to === "on_hold") return "hold";
  if (to === "data_awaited") return "data_awaited";
  return "move";
}

function employeeTargets(ids: readonly (string | null)[], actor: string | null): NotificationTarget[] {
  const seen = new Set<string>();
  const out: NotificationTarget[] = [];
  for (const id of ids) {
    if (!id || id === actor || seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: "employee", employeeId: id });
  }
  return out;
}

/**
 * What an allowed status change writes besides the status (§7.6.4): the completion date, the
 * escalation reset, the on-hold reason, the history row and who is told. The person who made the
 * change is never notified about their own move (the dispatcher also drops them from role targets).
 */
export function transitionEffects(input: TransitionEffectsInput): TransitionEffects {
  const { from, to, now } = input;
  const reason = (input.reason ?? "").trim() || null;
  const kind = transitionKind(from, to);

  let completionDate: string | null;
  if (to === "filed_done") completionDate = input.currentCompletionDate ? iso(input.currentCompletionDate) : now.toISOString();
  else if (from === "filed_done") completionDate = null;
  else completionDate = input.currentCompletionDate ? iso(input.currentCompletionDate) : null;

  const onHoldReason = to === "on_hold" ? reason : from === "on_hold" ? null : undefined;

  const notifications: TransitionNotification[] = [];
  const actor = input.actorEmployeeId;
  if (to === "under_review") {
    const targets: NotificationTarget[] = input.reviewerEmployeeId
      ? employeeTargets([input.reviewerEmployeeId], actor)
      : [{ kind: "role", role: "manager" }];
    if (targets.length > 0) notifications.push({ type: "review_requested", targets });
  } else if (kind === "send_back") {
    const targets = employeeTargets([input.assigneeEmployeeId], actor);
    if (targets.length > 0) notifications.push(reason ? { type: "task_sent_back", targets, reason } : { type: "task_sent_back", targets });
  } else if (to === "filed_done") {
    const targets = employeeTargets([input.assigneeEmployeeId, input.clientOwnerEmployeeId], actor);
    if (targets.length > 0) notifications.push({ type: "task_approved", targets });
  }

  return {
    kind,
    completionDate,
    resetEscalation: isReopen(from, to),
    onHoldReason,
    history: { fromStatus: from, toStatus: to, reason },
    notifications,
    addsToCallList: to === "data_awaited",
  };
}

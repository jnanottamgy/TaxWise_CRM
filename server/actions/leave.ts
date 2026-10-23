"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { log } from "@/lib/log";
import { LEAVE_TYPE_LABELS } from "@/lib/domain/enums";
import { findOverlappingLeave, formatLeaveRange, overlapMessage, reassignPrompt } from "@/lib/domain/leave";
import { todayIST } from "@/lib/domain/fy";
import { canManagePerson, type StaffRole } from "@/lib/schemas/people";
import { LeaveCancelSchema, LeaveDecisionSchema, LeaveRequestSchema, LeaveUpdateSchema, NoCoverNeededSchema, ReassignLeaveTasksSchema } from "@/lib/schemas/leave";
import { getLeave, getLiveLeave, getTasksDuringLeave, type LeaveRow } from "@/lib/data/leave";
import { getClientsOfPerson, type CoverClientRow } from "@/lib/data/covers";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";

/**
 * Leave (§7.11.3): request, edit and cancel your own; Managers decide Employees' leave, Partners
 * decide Managers' and Partners' (decide_leave, 0106, which also marks attendance On leave);
 * after approval the approver is asked who covers the person's clients, or records "No cover
 * needed", and sees the tasks due during the leave ("Reassign before 01 Jul?").
 */

const STAFF = ["partner", "manager", "employee"] as const;
const MANAGERS = ["partner", "manager"] as const;

async function subjectOf(ctx: ActionContext, employeeId: string): Promise<{ id: string; full_name: string; role: StaffRole; profile_id: string | null }> {
  const { data, error } = await ctx.supabase.from("people_overview").select("id, full_name, role, profile_id, login_status").eq("id", employeeId).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That person wasn't found.", { code: "not_found" });
  if (data.login_status === "disabled") throw new ActionError(`${data.full_name}'s account is disabled.`, { code: "blocked" });
  return { id: data.id as string, full_name: data.full_name ?? "", role: (data.role ?? "employee") as StaffRole, profile_id: data.profile_id };
}

function overlapFor(name: string | null, leave: Parameters<typeof overlapMessage>[0]): string {
  const own = overlapMessage(leave);
  return name ? own.replace("your approved leave", `${name}'s approved leave`).replace("your leave request", `${name}'s leave request`) : own;
}

// -------------------------------------------------------------------------------------------------
// Request, edit, cancel
// -------------------------------------------------------------------------------------------------

export const requestLeave = defineAction(
  { name: "leave.request", schema: LeaveRequestSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    if (!ctx.user.employeeId) return fail("Your staff record is missing. Ask a Partner.", { code: "forbidden" });
    const forId = input.employee_id ?? ctx.user.employeeId;
    const own = forId === ctx.user.employeeId;
    const subject = await subjectOf(ctx, forId);
    if (!own && !canManagePerson(ctx.user.role, subject.role)) {
      return fail(ctx.user.role === "manager" ? "A Partner records leave for Managers and Partners." : "You can ask for leave only for yourself.", { code: "forbidden" });
    }

    const clash = findOverlappingLeave(
      { startDate: input.start_date, endDate: input.end_date },
      (await getLiveLeave(ctx.supabase, forId)).map((l) => ({ id: l.id, startDate: l.start_date, endDate: l.end_date, status: l.status, halfDay: l.half_day })),
    );
    if (clash) {
      const msg = overlapFor(own ? null : subject.full_name, clash);
      return fail(msg, { code: "validation", fieldErrors: { start_date: [msg] } });
    }

    const { data, error } = await ctx.supabase
      .from("employee_leave")
      .insert({ employee_id: forId, type: input.type, start_date: input.start_date, end_date: input.end_date, half_day: input.half_day, reason: input.reason })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = data!.id;

    await ctx.audit({ event: "data_create", resourceType: "employee_leave", resourceId: id, details: { employee_id: forId, type: input.type, start: input.start_date, end: input.end_date, half_day: input.half_day } });
    const range = formatLeaveRange(input.start_date, input.end_date, input.half_day);
    ctx.after("Tell the approvers", () =>
      notify({
        to: { roles: subject.role === "employee" ? ["manager"] : ["partner"] },
        type: "leave_requested",
        title: `${subject.full_name} asks for ${LEAVE_TYPE_LABELS[input.type].toLowerCase()} leave ${range}`,
        body: input.reason ? `Reason: ${input.reason}` : "No reason given.",
        linkUrl: `/leave?tab=requests`,
        entity: { type: "employee_leave", id },
        dedupeKey: `leave-requested:${id}`,
      }),
    );
    if (own) {
      ctx.after("Record it in your activity", () =>
        logEmployeeActivity({ activityType: "leave_requested", description: `Asked for ${LEAVE_TYPE_LABELS[input.type].toLowerCase()} leave ${range}.`, entityType: "employee_leave", entityId: id }),
      );
    }
    return ok({ id });
  },
);

export const updateLeaveRequest = defineAction(
  { name: "leave.update", schema: LeaveUpdateSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const leave = await getLeave(ctx.supabase, input.id);
    if (!leave) return fail("That leave request no longer exists.", { code: "not_found" });
    if (leave.status !== "requested") return fail("Only a leave request that hasn't been decided can be changed. Cancel it and ask again.", { code: "blocked" });
    const clash = findOverlappingLeave(
      { id: leave.id, startDate: input.start_date, endDate: input.end_date },
      (await getLiveLeave(ctx.supabase, leave.employee_id)).map((l) => ({ id: l.id, startDate: l.start_date, endDate: l.end_date, status: l.status, halfDay: l.half_day })),
    );
    if (clash) return fail(overlapMessage(clash), { code: "validation", fieldErrors: { start_date: [overlapMessage(clash)] } });
    const { data, error } = await ctx.supabase
      .from("employee_leave")
      .update({ type: input.type, start_date: input.start_date, end_date: input.end_date, half_day: input.half_day, reason: input.reason })
      .eq("id", leave.id)
      .eq("updated_at", input.updated_at)
      .select("updated_at");
    throwIfDbError(error);
    if (!data?.length) return fail("This leave request was changed after you opened it. Reload to see the changes.", { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "employee_leave", resourceId: leave.id, details: { start: input.start_date, end: input.end_date, type: input.type } });
    return ok({ updated_at: data[0].updated_at });
  },
);

export const cancelLeave = defineAction(
  { name: "leave.cancel", schema: LeaveCancelSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ days_cleared: number }>> => {
    const leave = await getLeave(ctx.supabase, input.id);
    if (!leave) return fail("That leave request no longer exists.", { code: "not_found" });
    const { data, error } = await ctx.supabase.rpc("cancel_leave", { p_leave_id: input.id, p_updated_at: input.updated_at });
    throwIfDbError(error);
    const r = (data ?? {}) as { was?: string; days_cleared?: number };
    await ctx.audit({ event: "data_update", resourceType: "employee_leave", resourceId: input.id, action: "leave.cancel", details: { was: r.was, days_cleared: r.days_cleared ?? 0 } });

    if (r.was === "approved") {
      // Covers set up for this leave end with it (§4.7).
      ctx.after(
        "End the covers set up for this leave",
        async () => {
          const { error: coverError } = await ctx.supabase
            .from("client_covers")
            .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.user.id, revoke_reason: "Leave cancelled" })
            .eq("leave_id", input.id)
            .is("revoked_at", null)
            .gt("ends_at", new Date().toISOString());
          if (coverError) throw coverError;
        },
        "The leave is cancelled, but a cover set up for it is still in force. End it from the person's page.",
      );
      const range = formatLeaveRange(leave.start_date, leave.end_date, leave.half_day);
      ctx.after("Tell the approvers", () =>
        notify({
          to: { roles: leave.employee_role === "employee" ? ["manager"] : ["partner"] },
          type: "leave_decided",
          title: `${leave.employee_name}'s approved leave ${range} is cancelled`,
          body: `Cancelled by ${ctx.user.fullName}. Attendance for the days still ahead is back to normal.`,
          linkUrl: `/leave?tab=all`,
          entity: { type: "employee_leave", id: leave.id },
        }),
      );
    }
    return ok({ days_cleared: r.days_cleared ?? 0 });
  },
);

// -------------------------------------------------------------------------------------------------
// Decide (approve / decline)
// -------------------------------------------------------------------------------------------------

export interface DecisionResult {
  status: "approved" | "declined";
  leave: LeaveRow;
  daysMarked: number;
}

export const decideLeave = defineAction(
  { name: "leave.decide", schema: LeaveDecisionSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<DecisionResult>> => {
    // Read before deciding: once decide_leave has committed, a failed read must not turn the
    // decision into an error (§0.1 rule 5).
    const before = await getLeave(ctx.supabase, input.id);
    if (!before) return fail("That leave request no longer exists.", { code: "not_found" });
    const { data, error } = await ctx.supabase.rpc("decide_leave", { p_leave_id: input.id, p_decision: input.decision, p_note: input.note, p_updated_at: input.updated_at });
    throwIfDbError(error);
    const r = (data ?? {}) as { days_marked?: number; updated_at?: string };
    let leave: LeaveRow = { ...before, status: input.decision, updated_at: r.updated_at ?? before.updated_at };
    try {
      leave = (await getLeave(ctx.supabase, input.id)) ?? leave;
    } catch (err) {
      log("warn", "leave read after the decision failed", { source: "action:leave.decide", userId: ctx.user.id, role: ctx.user.role, err });
    }

    await ctx.audit({ event: "data_update", resourceType: "employee_leave", resourceId: input.id, action: `leave.${input.decision === "approved" ? "approve" : "decline"}`, details: { employee_id: leave.employee_id, note: input.note } });
    const range = formatLeaveRange(leave.start_date, leave.end_date, leave.half_day);
    ctx.after("Tell them the decision", () =>
      notify({
        to: { employeeIds: [leave.employee_id] },
        type: "leave_decided",
        title: input.decision === "approved" ? `Your leave ${range} is approved` : `Your leave ${range} is declined`,
        body: input.note ? `${ctx.user.fullName}: ${input.note}` : `Decided by ${ctx.user.fullName}.`,
        linkUrl: "/leave",
        entity: { type: "employee_leave", id: leave.id },
        dedupeKey: `leave-decided:${leave.id}`,
      }),
    );
    return ok({ status: input.decision, leave, daysMarked: r.days_marked ?? 0 });
  },
);

export const recordNoCoverNeeded = defineAction(
  { name: "leave.no_cover_needed", schema: NoCoverNeededSchema, roles: MANAGERS },
  async ({ id }, ctx): Promise<ActionResult<{ recorded: true }>> => {
    const { data, error } = await ctx.supabase.from("employee_leave").update({ no_cover_needed: true }).eq("id", id).eq("status", "approved").select("id");
    throwIfDbError(error);
    if (!data?.length) return fail("Only approved leave records No cover needed.", { code: "blocked" });
    await ctx.audit({ event: "permission_change", resourceType: "employee_leave", resourceId: id, action: "leave.no_cover_needed" });
    return ok({ recorded: true as const });
  },
);

// -------------------------------------------------------------------------------------------------
// After approval: the cover prompt and "Reassign before 01 Jul?"
// -------------------------------------------------------------------------------------------------

export interface LeaveCoverContext {
  leave: LeaveRow;
  clients: CoverClientRow[];
  tasks: Awaited<ReturnType<typeof getTasksDuringLeave>>;
  /** "Reassign before 01 Jul?" */
  prompt: string;
}

export const loadLeaveCoverContext = defineAction(
  { name: "leave.cover_context", schema: z.object({ leave_id: z.uuid() }), roles: MANAGERS },
  async ({ leave_id }, ctx): Promise<ActionResult<LeaveCoverContext>> => {
    const leave = await getLeave(ctx.supabase, leave_id);
    if (!leave) return fail("That leave request no longer exists.", { code: "not_found" });
    const [clients, tasks] = await Promise.all([
      getClientsOfPerson(ctx.supabase, leave.employee_id, todayIST()),
      getTasksDuringLeave(ctx.supabase, leave.employee_id, leave.start_date, leave.end_date),
    ]);
    return ok({ leave, clients, tasks, prompt: reassignPrompt({ startDate: leave.start_date }) });
  },
);

export const reassignLeaveTasks = defineAction(
  { name: "leave.reassign_tasks", schema: ReassignLeaveTasksSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ moved: number; skipped: Array<{ task_id: string; reason: string }> }>> => {
    const leave = await getLeave(ctx.supabase, input.leave_id);
    if (!leave) return fail("That leave request no longer exists.", { code: "not_found" });
    const due = new Map((await getTasksDuringLeave(ctx.supabase, leave.employee_id, leave.start_date, leave.end_date)).map((t) => [t.id, t]));
    const targets = Array.from(new Set(input.moves.map((m) => m.to_employee_id)));
    const { data: people, error } = await ctx.supabase.from("people_overview").select("id, full_name, login_status").in("id", targets);
    throwIfDbError(error);
    const personById = new Map((people ?? []).map((p) => [p.id as string, p]));
    const { data: reviewers, error: rError } = await ctx.supabase.from("tasks").select("id, reviewer_employee_id").in("id", input.moves.map((m) => m.task_id));
    throwIfDbError(rError);
    const reviewerOf = new Map((reviewers ?? []).map((t) => [t.id, t.reviewer_employee_id]));

    let moved = 0;
    const skipped: Array<{ task_id: string; reason: string }> = [];
    const byAssignee = new Map<string, string[]>();
    for (const m of input.moves) {
      const task = due.get(m.task_id);
      const to = personById.get(m.to_employee_id);
      if (!task) {
        skipped.push({ task_id: m.task_id, reason: "It's no longer an open task due during this leave." });
        continue;
      }
      if (!to || to.login_status === "disabled") {
        skipped.push({ task_id: m.task_id, reason: "The person chosen is disabled." });
        continue;
      }
      if (m.to_employee_id === leave.employee_id) continue;
      if (reviewerOf.get(m.task_id) === m.to_employee_id) {
        skipped.push({ task_id: m.task_id, reason: `${to.full_name} reviews ${task.task_number}; nobody reviews their own work.` });
        continue;
      }
      const { data: upd, error: uError } = await ctx.supabase.from("tasks").update({ assigned_employee_id: m.to_employee_id }).eq("id", m.task_id).eq("assigned_employee_id", leave.employee_id).select("id");
      throwIfDbError(uError);
      if (!upd?.length) {
        skipped.push({ task_id: m.task_id, reason: "Someone else changed it meanwhile." });
        continue;
      }
      moved += 1;
      byAssignee.set(m.to_employee_id, [...(byAssignee.get(m.to_employee_id) ?? []), m.task_id]);
      const title = `${task.task_number} reassigned from ${leave.employee_name} to ${to.full_name} (on leave ${formatLeaveRange(leave.start_date, leave.end_date, leave.half_day)})`;
      ctx.after("Add the reassignment to the client timeline", () =>
        addTimelineEvent({ clientId: task.client_id, eventType: "employee_assigned", title, metadata: { task_id: task.id, from_employee_id: leave.employee_id, to_employee_id: m.to_employee_id }, performedBy: ctx.user.id }),
      );
    }
    await ctx.audit({ event: "data_update", resourceType: "tasks", action: "leave.reassign_tasks", details: { leave_id: leave.id, moved, skipped: skipped.length } });
    for (const [assignee, taskIds] of byAssignee) {
      ctx.after("Tell the new assignee", () =>
        notify({
          to: { employeeIds: [assignee] },
          type: "task_assigned",
          title: taskIds.length === 1 ? `A task of ${leave.employee_name}'s is now yours` : `${taskIds.length} of ${leave.employee_name}'s tasks are now yours`,
          body: `${leave.employee_name} is on leave ${formatLeaveRange(leave.start_date, leave.end_date, leave.half_day)}. Accept them from My day.`,
          linkUrl: taskIds.length === 1 ? `/work/${taskIds[0]}` : "/my-day",
          entity: { type: "task", id: taskIds[0] },
        }),
      );
    }
    return ok({ moved, skipped });
  },
);

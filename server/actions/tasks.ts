"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES, isManagerOrPartner } from "@/lib/auth/roles";
import { DECLINE_REASON_LABELS, SERVICE_TYPE_LABELS, type DeclineReason, type TaskStatus } from "@/lib/domain/enums";
import { assignmentBlocked, type AssignmentFinding } from "@/lib/domain/assignment";
import { dueDateChangeRearms } from "@/lib/domain/escalation";
import { istDateOf, todayIST } from "@/lib/domain/fy";
import { TASK_STATUS_NAMES, transitionEffects, type TransitionNotification } from "@/lib/domain/transitions";
import { formatDate, formatTime } from "@/lib/format";
import { parseTableParams } from "@/components/app/data-table/params";
import {
  AssignmentCheckSchema,
  AttachDocumentsSchema,
  BUILT_IN_VIEW_NAMES,
  BulkTaskSchema,
  ChangeStatusSchema,
  CreateTaskSchema,
  DeleteTaskSchema,
  DeleteViewSchema,
  DetachDocumentSchema,
  FileTaskSchema,
  RespondSchema,
  SaveViewSchema,
  UpdateRemarksSchema,
  UpdateTaskSchema,
  WORK_FILTERS,
  WORK_SORTABLE,
  bulkChanges,
  estimateMinutes,
  filingDefaults,
  needsFilingCapture,
  taskRef,
} from "@/lib/schemas/tasks";
import { toCsv } from "@/lib/schemas/clients";
import {
  listClientDeadlines,
  listExistingFilings,
  listTasksForExport,
  listUnlinkedUdins,
  runAssignmentCheck,
  searchClientOptions,
  searchTaskOptions,
  type ClientOption,
  type DeadlineOption,
  type FilingRecordRef,
  type TaskOption,
} from "@/lib/data/tasks";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";
import type { ServerSupabase } from "@/lib/supabase/server";
import { log } from "@/lib/log";

/**
 * Task mutations (§7.6): create and edit with the assignment check (§7.6.2), accept / decline
 * (§7.6.3), status changes through change_task_status only (§7.6.4), Filed/Done with the filing
 * capture (§7.6.5), bulk changes (§7.6.7), remarks, delete to the recycle bin, attachments through
 * the documents vault, saved views and the CSV export. Every action runs under the caller's
 * session (RLS and the task triggers agree), writes an audit row, and sends its notifications
 * (§9) and timeline entries after the save, so they can never fail it (§0.1 rule 5).
 */

const PM = ["partner", "manager"] as const;

type TaskBrief = {
  id: string;
  task_number: string;
  title: string;
  client_id: string;
  client_name: string | null;
  assigned_employee_id: string | null;
  reviewer_employee_id: string | null;
  due_date: string | null;
  status: TaskStatus;
};

async function taskBrief(supabase: ServerSupabase, id: string): Promise<TaskBrief | null> {
  const { data, error } = await supabase
    .from("tasks_list")
    .select("id, task_number, title, client_id, client_name, assigned_employee_id, reviewer_employee_id, due_date, status")
    .eq("id", id)
    .maybeSingle();
  throwIfDbError(error);
  return data ? (data as unknown as TaskBrief) : null;
}

/**
 * taskBrief once the save has committed: a failed read must never turn a saved change into an
 * error (§0.1 rule 5); it only costs the client's name in the notice and timeline line.
 */
async function briefAfterSave(ctx: ActionContext, id: string): Promise<TaskBrief | null> {
  try {
    return await taskBrief(ctx.supabase, id);
  } catch (err) {
    log("warn", "task read after a saved change failed", { source: "action:tasks", userId: ctx.user.id, role: ctx.user.role, taskId: id, err });
    return null;
  }
}

async function employeeName(supabase: ServerSupabase, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from("employee_directory").select("full_name").eq("id", id).maybeSingle();
  return data?.full_name ?? null;
}

function link(id: string): string {
  return `/work/${id}`;
}

function forClient(t: { client_name: string | null }): string {
  return t.client_name ? ` for ${t.client_name}` : "";
}

/** Tell a newly assigned person (§9 "Task assigned to you"). */
function notifyAssigned(task: { id: string; task_number: string | null; title: string; client_id: string; client_name: string | null; due_date: string | null }, assigneeId: string, by: string) {
  return notify({
    to: { employeeIds: [assigneeId] },
    type: "task_assigned",
    title: "Task assigned to you",
    body: `${by} assigned you ${taskRef(task)}${forClient(task)}${task.due_date ? `, due ${formatDate(task.due_date)}` : ""}. Accept it or decline it with a reason.`,
    linkUrl: link(task.id),
    entity: { type: "task", id: task.id },
    clientId: task.client_id,
  });
}

function blockedFailure(findings: readonly AssignmentFinding[]): ActionResult<never> {
  const block = findings.find((f) => f.level === "block");
  const field = block?.code === "reviewer_is_assignee" ? "reviewer_employee_id" : "assigned_employee_id";
  return fail(block?.message ?? "This assignment can't be saved.", { code: "blocked", fieldErrors: { [field]: [block?.message ?? "Choose someone else."] } });
}

// =================================================================================================
// Assignment check (§7.6.2): asked by the form before saving
// =================================================================================================

export const checkTaskAssignment = defineAction(
  { name: "tasks.check_assignment", schema: AssignmentCheckSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<AssignmentFinding[]>> => {
    const findings = await runAssignmentCheck(
      ctx.supabase,
      { taskId: input.task_id, clientId: input.client_id, assigneeId: input.assigned_employee_id, reviewerId: input.reviewer_employee_id, dueDate: input.due_date },
      todayIST(),
    );
    return ok(findings);
  },
);

// =================================================================================================
// Create / edit / delete
// =================================================================================================

export const createTask = defineAction(
  { name: "tasks.create", schema: CreateTaskSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; task_number: string }>> => {
    const findings = await runAssignmentCheck(
      ctx.supabase,
      { taskId: null, clientId: input.client_id, assigneeId: input.assigned_employee_id, reviewerId: input.reviewer_employee_id, dueDate: input.due_date },
      todayIST(),
    );
    if (assignmentBlocked(findings)) return blockedFailure(findings);

    const { data, error } = await ctx.supabase.rpc("create_task", {
      p: {
        client_id: input.client_id,
        title: input.title,
        description: input.description,
        service_type: input.service_type,
        financial_year: input.financial_year,
        period_label: input.period_label,
        due_date: input.due_date,
        priority: input.priority,
        estimated_minutes: estimateMinutes(input.estimate_hours, input.estimate_minutes),
        assigned_employee_id: input.assigned_employee_id,
        reviewer_employee_id: input.reviewer_employee_id,
        remarks: input.remarks,
        compliance_event_id: input.compliance_event_id,
        template_id: input.template_id,
        checklist: input.checklist.filter((c) => c.title.trim()).map((c) => ({ title: c.title })),
        blocker_ids: input.blocker_ids,
      },
    });
    throwIfDbError(error);
    const r = data as { id: string; task_number: string; checklist_items: number };

    await ctx.audit({
      event: "data_create",
      resourceType: "task",
      resourceId: r.id,
      details: {
        task_number: r.task_number,
        client_id: input.client_id,
        title: input.title,
        assigned_employee_id: input.assigned_employee_id,
        reviewer_employee_id: input.reviewer_employee_id,
        due_date: input.due_date,
        template_id: input.template_id,
        checklist_items: r.checklist_items,
        warnings: findings.filter((f) => f.level !== "block").map((f) => f.code),
      },
    });

    const brief = (await briefAfterSave(ctx, r.id)) ?? {
      id: r.id,
      task_number: r.task_number,
      title: input.title,
      client_id: input.client_id,
      client_name: null,
      due_date: input.due_date,
    };
    if (input.assigned_employee_id) {
      ctx.after("Tell the assignee", () => notifyAssigned(brief, input.assigned_employee_id!, ctx.user.fullName), "The assignee wasn't notified. Tell them about the task.");
    }
    ctx.after("Add the task to the client's timeline", async () => {
      const who = await employeeName(ctx.supabase, input.assigned_employee_id);
      await addTimelineEvent({
        clientId: input.client_id,
        eventType: "task_created",
        title: `Task created: ${input.title}${who ? ` · assigned to ${who}` : ""}`,
        metadata: { task_id: r.id, task_number: r.task_number, due_date: input.due_date },
      });
    });
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "task_created", description: `Created ${r.task_number}: ${input.title}`, entityType: "task", entityId: r.id, entityName: input.title }),
    );
    return ok({ id: r.id, task_number: r.task_number });
  },
);

export const updateTask = defineAction(
  { name: "tasks.update", schema: UpdateTaskSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; updated_at: string }>> => {
    const { data: before, error: loadError } = await ctx.supabase
      .from("tasks")
      .select("id, task_number, client_id, title, due_date, assigned_employee_id, reviewer_employee_id, priority, compliance_event_id, status, deleted_at, updated_at")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(loadError);
    if (!before || before.deleted_at) return fail("That task no longer exists, or it's in the recycle bin.", { code: "not_found" });
    if (before.client_id !== input.client_id) return fail("A task can't move to another client. Create a new task for that client.", { code: "validation", fieldErrors: { client_id: ["A task stays with its client."] } });

    const assigneeChanged = before.assigned_employee_id !== input.assigned_employee_id;
    const dueChanged = dueDateChangeRearms(before.due_date, input.due_date);
    if (assigneeChanged || dueChanged || before.reviewer_employee_id !== input.reviewer_employee_id) {
      const findings = await runAssignmentCheck(
        ctx.supabase,
        { taskId: input.id, clientId: input.client_id, assigneeId: input.assigned_employee_id, reviewerId: input.reviewer_employee_id, dueDate: input.due_date },
        todayIST(),
      );
      if (assignmentBlocked(findings)) return blockedFailure(findings);
    }

    const patch = {
      title: input.title,
      description: input.description,
      service_type: input.service_type,
      financial_year: input.financial_year,
      period_label: input.period_label,
      due_date: input.due_date,
      priority: input.priority,
      estimated_minutes: estimateMinutes(input.estimate_hours, input.estimate_minutes),
      assigned_employee_id: input.assigned_employee_id,
      reviewer_employee_id: input.reviewer_employee_id,
      remarks: input.remarks,
      compliance_event_id: input.compliance_event_id,
      // Unassigning puts the task back to waiting; a new assignee waits for acceptance (tasks_guard).
      ...(assigneeChanged && !input.assigned_employee_id ? { acceptance_status: "pending" as const, accepted_at: null } : {}),
    };
    const { data: saved, error } = await ctx.supabase.from("tasks").update(patch).eq("id", input.id).eq("updated_at", input.expected_updated_at).select("id, updated_at");
    throwIfDbError(error, { uniqueMessage: "That deadline already has a task." });
    if (!saved || saved.length === 0) {
      const { data: now } = await ctx.supabase.from("tasks").select("updated_at").eq("id", input.id).maybeSingle();
      return fail(`This task was changed by someone else${now ? ` at ${formatTime(now.updated_at)}` : ""}. Reload to see their changes.`, { code: "conflict" });
    }
    if (input.compliance_event_id && input.compliance_event_id !== before.compliance_event_id) {
      const { error: linkError } = await ctx.supabase.from("compliance_events").update({ task_id: input.id }).eq("id", input.compliance_event_id).eq("client_id", input.client_id).is("task_id", null);
      throwIfDbError(linkError);
    }

    const changed = Object.entries({
      title: before.title !== input.title,
      due_date: dueChanged,
      assigned_employee_id: assigneeChanged,
      reviewer_employee_id: before.reviewer_employee_id !== input.reviewer_employee_id,
      priority: before.priority !== input.priority,
    })
      .filter(([, v]) => v)
      .map(([k]) => k);
    await ctx.audit({
      event: "data_update",
      resourceType: "task",
      resourceId: input.id,
      details: {
        changed,
        before: { due_date: before.due_date, assigned_employee_id: before.assigned_employee_id, reviewer_employee_id: before.reviewer_employee_id, priority: before.priority },
        after: { due_date: input.due_date, assigned_employee_id: input.assigned_employee_id, reviewer_employee_id: input.reviewer_employee_id, priority: input.priority },
      },
    });

    if (assigneeChanged && input.assigned_employee_id) {
      const brief = (await briefAfterSave(ctx, input.id)) ?? {
        id: input.id,
        task_number: before.task_number,
        title: input.title,
        client_id: input.client_id,
        client_name: null,
        due_date: input.due_date,
      };
      ctx.after("Tell the new assignee", () => notifyAssigned(brief, input.assigned_employee_id!, ctx.user.fullName), "The new assignee wasn't notified. Tell them about the task.");
    }
    if (assigneeChanged || dueChanged) {
      ctx.after("Add the change to the client's timeline", async () => {
        const parts: string[] = [];
        if (assigneeChanged) {
          const who = await employeeName(ctx.supabase, input.assigned_employee_id);
          parts.push(who ? `assigned to ${who}` : "unassigned");
        }
        if (dueChanged) parts.push(`due date ${formatDate(before.due_date)} → ${formatDate(input.due_date)}`);
        await addTimelineEvent({
          clientId: input.client_id,
          eventType: assigneeChanged ? "task_assigned" : "task_due_changed",
          title: `${input.title}: ${parts.join(", ")}`,
          metadata: { task_id: input.id, task_number: before.task_number },
        });
        await logActivity({ entityType: "task", entityId: input.id, action: "task_updated", description: `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())}.` });
      });
    } else if (changed.length) {
      ctx.after("Record the change", () => logActivity({ entityType: "task", entityId: input.id, action: "task_updated", description: `Edited: ${changed.map((c) => c.replace(/_/g, " ")).join(", ")}.` }));
    }
    return ok({ id: input.id, updated_at: saved[0].updated_at });
  },
);

/** An Employee's remarks on their own task (§4.6); Partners and Managers may edit anyone's. */
export const updateTaskRemarks = defineAction(
  { name: "tasks.remarks", schema: UpdateRemarksSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const { data, error } = await ctx.supabase.from("tasks").update({ remarks: input.remarks }).eq("id", input.id).eq("updated_at", input.expected_updated_at).select("updated_at");
    throwIfDbError(error);
    if (!data || data.length === 0) {
      const { data: still } = await ctx.supabase.from("tasks").select("updated_at, assigned_employee_id").eq("id", input.id).maybeSingle();
      if (!still) return fail("That task doesn't exist, or it isn't one of yours.", { code: "not_found" });
      if (ctx.user.role === "employee" && still.assigned_employee_id !== ctx.user.employeeId) return fail("You can add remarks only to tasks assigned to you.", { code: "forbidden" });
      return fail(`This task was changed by someone else at ${formatTime(still.updated_at)}. Reload to see their changes.`, { code: "conflict" });
    }
    await ctx.audit({ event: "data_update", resourceType: "task", resourceId: input.id, details: { changed: ["remarks"] } });
    ctx.after("Record the change", () => logActivity({ entityType: "task", entityId: input.id, action: "remarks_updated", description: input.remarks ? "Remarks updated." : "Remarks cleared." }));
    return ok({ updated_at: data[0].updated_at });
  },
);

export const deleteTask = defineAction(
  { name: "tasks.delete", schema: DeleteTaskSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const brief = await taskBrief(ctx.supabase, input.id);
    if (!brief) return fail("That task no longer exists.", { code: "not_found" });
    const { data, error } = await ctx.supabase
      .from("tasks")
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.user.id })
      .eq("id", input.id)
      .eq("updated_at", input.expected_updated_at)
      .is("deleted_at", null)
      .select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("This task was changed by someone else. Reload to see their changes.", { code: "conflict" });
    await ctx.audit({ event: "data_delete", resourceType: "task", resourceId: input.id, details: { task_number: brief.task_number, title: brief.title, client_id: brief.client_id } });
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({ clientId: brief.client_id, eventType: "task_deleted", title: `Task moved to the recycle bin: ${brief.title}`, metadata: { task_id: input.id, task_number: brief.task_number } }),
    );
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Acceptance (§7.6.3)
// =================================================================================================

export const respondToTask = defineAction(
  { name: "tasks.respond", schema: RespondSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ acceptance: "accepted" | "declined" }>> => {
    const { data: before } = await ctx.supabase.from("tasks").select("assigned_by, created_by").eq("id", input.id).maybeSingle();
    const { data, error } = await ctx.supabase.rpc("respond_to_task", {
      p_task_id: input.id,
      p_accept: input.accept,
      p_decline_reason: input.accept ? undefined : (input.reason ?? undefined),
      p_decline_note: input.accept ? undefined : (input.note ?? undefined),
    });
    throwIfDbError(error);
    const r = data as { task_id: string; task_number: string; title: string; client_id: string; acceptance_status: "accepted" | "declined"; decline_reason: DeclineReason | null; decline_note: string | null; created_by: string };

    await ctx.audit({
      event: "data_update",
      resourceType: "task",
      resourceId: r.task_id,
      action: input.accept ? "tasks.accept" : "tasks.decline",
      details: { acceptance: r.acceptance_status, decline_reason: r.decline_reason },
    });

    const reasonText = r.decline_reason ? `${DECLINE_REASON_LABELS[r.decline_reason]}${r.decline_note ? `: ${r.decline_note}` : ""}` : null;
    if (!input.accept) {
      const assigner = before?.assigned_by ?? before?.created_by ?? r.created_by;
      ctx.after(
        "Tell the assigner and Managers",
        () =>
          notify({
            to: { userIds: assigner ? [assigner] : [], roles: ["manager"] },
            type: "task_declined",
            title: `Task declined: ${r.title}`,
            body: `${ctx.user.fullName} declined ${r.task_number}: ${reasonText}. It is unassigned now; reassign it.`,
            linkUrl: link(r.task_id),
            entity: { type: "task", id: r.task_id },
            clientId: r.client_id,
          }),
        "The Managers weren't notified of the decline. Tell your Manager.",
      );
    }
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({
        clientId: r.client_id,
        eventType: input.accept ? "task_accepted" : "task_declined",
        title: input.accept ? `${ctx.user.fullName} accepted ${r.title}` : `${ctx.user.fullName} declined ${r.title}: ${reasonText}`,
        metadata: { task_id: r.task_id, task_number: r.task_number, decline_reason: r.decline_reason },
      }),
    );
    ctx.after("Record it on the task", () =>
      logActivity({
        entityType: "task",
        entityId: r.task_id,
        action: input.accept ? "accepted" : "declined",
        description: input.accept ? "Accepted." : `Declined: ${reasonText}.`,
      }),
    );
    return ok({ acceptance: r.acceptance_status });
  },
);

// =================================================================================================
// Status (§7.6.4) and filing capture (§7.6.5)
// =================================================================================================

type StatusResult = {
  task_id: string;
  task_number: string;
  title: string;
  client_id: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  reason: string | null;
  kind: string;
  completion_date: string | null;
  actor_employee_id: string | null;
  assigned_employee_id: string | null;
  reviewer_employee_id: string | null;
  client_owner_employee_id: string | null;
  filing_record_id?: string | null;
  filing_skipped?: boolean;
};

const NOTICE_TITLE: Record<TransitionNotification["type"], (title: string) => string> = {
  review_requested: (t) => `Submitted for review: ${t}`,
  task_sent_back: (t) => `Sent back to you: ${t}`,
  task_approved: (t) => `Filed: ${t}`,
};

/** The §9 notices, the timeline entry and the history line for a status change that went through. */
function afterStatusChange(ctx: ActionContext, r: StatusResult, clientName: string | null, extra: { filingNote?: string | null } = {}) {
  const effects = transitionEffects({
    from: r.from_status,
    to: r.to_status,
    reason: r.reason,
    now: new Date(),
    currentCompletionDate: r.completion_date,
    actorEmployeeId: r.actor_employee_id,
    assigneeEmployeeId: r.assigned_employee_id,
    reviewerEmployeeId: r.reviewer_employee_id,
    clientOwnerEmployeeId: r.client_owner_employee_id,
  });
  const ref = taskRef(r);
  const where = clientName ? ` for ${clientName}` : "";
  for (const n of effects.notifications) {
    const employeeIds = n.targets.flatMap((t) => (t.kind === "employee" ? [t.employeeId] : []));
    const roles = n.targets.flatMap((t) => (t.kind === "role" ? [t.role] : []));
    const body =
      n.type === "review_requested"
        ? `${ctx.user.fullName} submitted ${ref}${where} for review. File it, or send it back with a reason.`
        : n.type === "task_sent_back"
          ? `${ctx.user.fullName} sent ${ref}${where} back to you: ${n.reason ?? "no reason given"}.`
          : `${ctx.user.fullName} filed ${ref}${where}.${extra.filingNote ? ` ${extra.filingNote}` : ""}`;
    ctx.after(
      "Send the notifications",
      () => notify({ to: { employeeIds, roles }, type: n.type, title: NOTICE_TITLE[n.type](r.title), body, linkUrl: link(r.task_id), entity: { type: "task", id: r.task_id }, clientId: r.client_id }),
      "Some people weren't notified of the change. Tell them by hand.",
    );
  }
  const move = `${TASK_STATUS_NAMES[r.from_status]} → ${TASK_STATUS_NAMES[r.to_status]}`;
  const title =
    effects.kind === "file"
      ? `Filed: ${r.title}${extra.filingNote ? ` · ${extra.filingNote}` : ""}`
      : effects.kind === "data_awaited"
        ? `Data awaited from the client: ${r.title}`
        : effects.kind === "send_back"
          ? `Sent back: ${r.title}`
          : effects.kind === "reopen"
            ? `Reopened: ${r.title}`
            : `${r.title}: ${move}`;
  ctx.after("Add the change to the client's timeline", () =>
    addTimelineEvent({
      clientId: r.client_id,
      eventType: effects.kind === "file" ? "task_filed" : "task_status_changed",
      title,
      description: r.reason,
      metadata: { task_id: r.task_id, task_number: r.task_number, from: r.from_status, to: r.to_status, filing_record_id: r.filing_record_id ?? null },
    }),
  );
  ctx.after("Add to your activity", () =>
    logEmployeeActivity({ activityType: "task_status_changed", description: `${r.task_number}: ${move}`, entityType: "task", entityId: r.task_id, entityName: r.title }),
  );
}

export const changeTaskStatus = defineAction(
  { name: "tasks.change_status", schema: ChangeStatusSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ status: TaskStatus }>> => {
    if (input.to === "filed_done") {
      const { data: t } = await ctx.supabase.from("tasks").select("service_type, compliance_event_id").eq("id", input.id).maybeSingle();
      if (t && needsFilingCapture(t)) {
        return fail("Record the filing details (return, period, filed-on date, acknowledgement), or skip them with a reason.", { code: "blocked" });
      }
    }
    const { data, error } = await ctx.supabase.rpc("change_task_status", { p_task_id: input.id, p_to: input.to, p_reason: input.reason ?? undefined });
    if (error?.message?.startsWith("USER: Give a reason")) {
      throw new ActionError(error.message.slice(6), { code: "validation", fieldErrors: { reason: [error.message.slice(6)] } });
    }
    throwIfDbError(error);
    const r = data as unknown as StatusResult;
    await ctx.audit({ event: "data_update", resourceType: "task", resourceId: r.task_id, details: { from: r.from_status, to: r.to_status, reason: r.reason } });
    const brief = await briefAfterSave(ctx, r.task_id);
    afterStatusChange(ctx, r, brief?.client_name ?? null);
    return ok({ status: r.to_status });
  },
);

export const fileTask = defineAction(
  { name: "tasks.file", schema: FileTaskSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ status: TaskStatus; filing_record_id: string | null }>> => {
    const filing =
      input.mode === "skip"
        ? null
        : input.mode === "existing"
          ? { filing_record_id: input.filing_record_id }
          : {
              filing_type: input.filing_type,
              period: input.period,
              financial_year: input.financial_year,
              filed_on: input.filed_on,
              acknowledgement_no: input.acknowledgement_no,
              document_id: input.document_id,
              udin_record_id: input.udin_record_id,
              shareable_with_client: input.shareable_with_client,
              notes: input.notes,
            };
    const { data, error } = await ctx.supabase.rpc("file_task", {
      p_task_id: input.id,
      p_filing: filing ?? undefined,
      p_skip_reason: input.mode === "skip" ? (input.skip_reason ?? undefined) : undefined,
      p_expected_updated_at: input.expected_updated_at ?? undefined,
    });
    if (error?.message?.startsWith("USER: ")) {
      const msg = error.message.slice(6);
      const field = /return or form/.test(msg) ? "filing_type" : /period/.test(msg) ? "period" : /financial year/.test(msg) ? "financial_year" : /filed-on|filed on|date it was filed/.test(msg) ? "filed_on" : /UDIN/.test(msg) ? "udin_record_id" : /acknowledgement isn't/.test(msg) ? "document_id" : null;
      throw new ActionError(msg, { code: /changed by someone else/.test(msg) ? "conflict" : "blocked", fieldErrors: field ? { [field]: [msg] } : undefined });
    }
    throwIfDbError(error);
    const r = data as unknown as StatusResult & { compliance_event_id: string | null };

    await ctx.audit({
      event: "data_update",
      resourceType: "task",
      resourceId: r.task_id,
      action: "tasks.file",
      details: { from: r.from_status, to: r.to_status, filing_record_id: r.filing_record_id, skipped: r.filing_skipped, skip_reason: input.mode === "skip" ? input.skip_reason : null, compliance_event_id: r.compliance_event_id },
    });
    if (input.mode === "record" && input.document_id) {
      ctx.after("Attach the acknowledgement to the task", async () => {
        const { error: attachError } = await ctx.supabase.from("task_attachments").insert({ task_id: r.task_id, document_id: input.document_id, uploaded_by: ctx.user.id });
        if (attachError) throw attachError;
      });
    }
    const brief = await briefAfterSave(ctx, r.task_id);
    const filingNote =
      input.mode === "record"
        ? [input.filing_type, input.period, input.acknowledgement_no ? `ARN/ack ${input.acknowledgement_no}` : null].filter(Boolean).join(" · ")
        : input.mode === "skip"
          ? "No filing record: " + (input.skip_reason ?? "")
          : null;
    afterStatusChange(ctx, r, brief?.client_name ?? null, { filingNote });
    return ok({ status: r.to_status, filing_record_id: r.filing_record_id ?? null });
  },
);

export type FilingContext = {
  task: { id: string; task_number: string; title: string; client_id: string; client_name: string | null; updated_at: string; compliance_event_id: string | null; service_type: string | null };
  event: { id: string; title: string; form_code: string | null; filing_period: string | null; financial_year: string | null; due_date: string } | null;
  defaults: { filing_type: string; period: string; financial_year: string; filed_on: string };
  filings: FilingRecordRef[];
  udins: Array<{ id: string; udin: string; document_type: string; document_date: string }>;
};

/** What the filing dialog (§7.6.5) needs: the deadline, its defaults, filings already recorded and unlinked UDINs. */
export const getFilingContext = defineAction(
  { name: "tasks.filing_context", schema: z.object({ id: z.uuid() }), roles: PM },
  async (input, ctx): Promise<ActionResult<FilingContext>> => {
    const { data: t, error } = await ctx.supabase
      .from("tasks_list")
      .select("id, task_number, title, client_id, client_name, updated_at, compliance_event_id, service_type, period_label, financial_year")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(error);
    if (!t?.id || !t.client_id) return fail("That task no longer exists.", { code: "not_found" });
    const [eventRes, filings, udins] = await Promise.all([
      t.compliance_event_id
        ? ctx.supabase.from("compliance_events").select("id, title, form_code, filing_period, financial_year, due_date").eq("id", t.compliance_event_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      listExistingFilings(ctx.supabase, t.id, t.compliance_event_id),
      listUnlinkedUdins(ctx.supabase, t.client_id),
    ]);
    throwIfDbError(eventRes.error);
    const event = eventRes.data;
    return ok({
      task: {
        id: t.id,
        task_number: t.task_number ?? "",
        title: t.title ?? "",
        client_id: t.client_id,
        client_name: t.client_name,
        updated_at: t.updated_at ?? "",
        compliance_event_id: t.compliance_event_id,
        service_type: t.service_type,
      },
      event,
      defaults: filingDefaults({ title: t.title ?? "", period_label: t.period_label, financial_year: t.financial_year }, event, todayIST()),
      filings,
      udins,
    });
  },
);

// =================================================================================================
// Bulk (§7.6.7)
// =================================================================================================

type BulkResult = {
  updated: Array<{ id: string; task_number: string; title: string; client_id: string; assignee_changed: boolean; new_assignee: string | null; due_changed: boolean; old_due: string | null; new_due: string | null }>;
  skipped: Array<{ id: string | null; task_number: string | null; reason: string }>;
};

export const bulkUpdateTasks = defineAction(
  { name: "tasks.bulk", schema: BulkTaskSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updated: number; skipped: BulkResult["skipped"] }>> => {
    const { data, error } = await ctx.supabase.rpc("bulk_update_tasks", { p_task_ids: input.ids, p_changes: bulkChanges(input), p_reason: input.reason ?? undefined });
    throwIfDbError(error);
    const r = data as unknown as BulkResult;
    await ctx.audit({
      event: "data_update",
      resourceType: "task",
      action: "tasks.bulk",
      details: { change: input.change, changes: bulkChanges(input), reason: input.reason, updated: r.updated.map((u) => u.id), skipped: r.skipped.length },
    });

    const assigned = r.updated.filter((u) => u.assignee_changed && u.new_assignee);
    if (assigned.length) {
      const assignee = assigned[0].new_assignee!;
      ctx.after(
        "Tell the assignee",
        () =>
          notify({
            to: { employeeIds: [assignee] },
            type: "task_assigned",
            title: assigned.length === 1 ? "Task assigned to you" : `${assigned.length} tasks assigned to you`,
            body:
              assigned.length === 1
                ? `${ctx.user.fullName} assigned you ${taskRef(assigned[0])}. Accept it or decline it with a reason.`
                : `${ctx.user.fullName} assigned you ${assigned.length} tasks: ${assigned.slice(0, 3).map((a) => a.task_number).join(", ")}${assigned.length > 3 ? " and more" : ""}. Accept or decline each.`,
            linkUrl: assigned.length === 1 ? link(assigned[0].id) : "/work?assignee=me&acceptance=pending",
            entity: assigned.length === 1 ? { type: "task", id: assigned[0].id } : null,
            clientId: assigned.length === 1 ? assigned[0].client_id : null,
          }),
        "The assignee wasn't notified. Tell them about the tasks.",
      );
    }
    const timeline = r.updated.filter((u) => u.assignee_changed || u.due_changed);
    if (timeline.length) {
      ctx.after("Add the changes to the clients' timelines", async () => {
        const who = input.change === "assignee" ? await employeeName(ctx.supabase, input.assigned_employee_id) : null;
        for (const u of timeline) {
          await addTimelineEvent({
            clientId: u.client_id,
            eventType: u.assignee_changed ? "task_assigned" : "task_due_changed",
            title: u.assignee_changed ? `${u.title}: ${who ? `assigned to ${who}` : "unassigned"}` : `${u.title}: due date ${formatDate(u.old_due)} → ${formatDate(u.new_due)}`,
            description: input.reason,
            metadata: { task_id: u.id, task_number: u.task_number },
          });
        }
      });
    }
    return ok({ updated: r.updated.length, skipped: r.skipped });
  },
);

// =================================================================================================
// Attachments (through the documents vault, §5.5 task_attachments)
// =================================================================================================

export const attachTaskDocuments = defineAction(
  { name: "tasks.attach", schema: AttachDocumentsSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ attached: number }>> => {
    const brief = await taskBrief(ctx.supabase, input.task_id);
    if (!brief) return fail("That task doesn't exist, or it isn't one of yours.", { code: "not_found" });
    const { data: docs, error: docError } = await ctx.supabase.from("documents").select("id, title").in("id", input.document_ids).eq("client_id", brief.client_id).is("deleted_at", null);
    throwIfDbError(docError);
    const found = docs ?? [];
    if (found.length !== input.document_ids.length) return fail("Some of those documents aren't in this client's vault.", { code: "validation" });
    const { data: existing } = await ctx.supabase.from("task_attachments").select("document_id").eq("task_id", input.task_id).in("document_id", input.document_ids);
    const already = new Set((existing ?? []).map((e) => e.document_id));
    const rows = found.filter((d) => !already.has(d.id)).map((d) => ({ task_id: input.task_id, document_id: d.id, uploaded_by: ctx.user.id }));
    if (rows.length) {
      const { error } = await ctx.supabase.from("task_attachments").insert(rows);
      throwIfDbError(error);
    }
    await ctx.audit({ event: "data_create", resourceType: "task_attachment", resourceId: input.task_id, details: { document_ids: rows.map((r) => r.document_id) } });
    if (rows.length) {
      ctx.after("Record it on the task", () =>
        logActivity({
          entityType: "task",
          entityId: input.task_id,
          action: "attachment_added",
          description: rows.length === 1 ? `Attached “${found.find((d) => d.id === rows[0].document_id)?.title ?? "a document"}”.` : `Attached ${rows.length} documents.`,
        }),
      );
    }
    return ok({ attached: rows.length });
  },
);

export const detachTaskDocument = defineAction(
  { name: "tasks.detach", schema: DetachDocumentSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("task_attachments").delete().eq("id", input.id).select("id, task_id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail(isManagerOrPartner(ctx.user.role) ? "That attachment no longer exists." : "You can remove only attachments you added.", { code: "forbidden" });
    await ctx.audit({ event: "data_delete", resourceType: "task_attachment", resourceId: input.id, details: { task_id: data[0].task_id } });
    ctx.after("Record it on the task", () => logActivity({ entityType: "task", entityId: data[0].task_id, action: "attachment_removed", description: "Removed an attachment (the file stays in the client's documents)." }));
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Saved views (§7.6.1)
// =================================================================================================

export const saveWorkView = defineAction(
  { name: "tasks.views.save", schema: SaveViewSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    if (BUILT_IN_VIEW_NAMES.includes(input.name.trim().toLowerCase())) {
      return fail("That name belongs to a built-in view. Choose another name.", { code: "validation", fieldErrors: { name: ["Choose another name."] } });
    }
    const shared = input.shared && isManagerOrPartner(ctx.user.role);
    const { data, error } = await ctx.supabase
      .from("saved_views")
      .upsert({ user_id: ctx.user.id, page: "work", name: input.name, filters: { query: input.query }, is_shared: shared }, { onConflict: "user_id,page,name" })
      .select("id")
      .single();
    throwIfDbError(error, { uniqueField: "name", uniqueMessage: "You already have a view with this name." });
    await ctx.audit({ event: "data_update", resourceType: "saved_view", resourceId: data!.id, details: { page: "work", name: input.name, shared } });
    return ok({ id: data!.id });
  },
);

export const deleteWorkView = defineAction(
  { name: "tasks.views.delete", schema: DeleteViewSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("saved_views").delete().eq("id", input.id).eq("user_id", ctx.user.id).select("id");
    throwIfDbError(error);
    if (data?.length) await ctx.audit({ event: "data_delete", resourceType: "saved_view", resourceId: input.id, details: { page: "work" } });
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Pickers (read-only)
// =================================================================================================

const SearchSchema = z.object({ q: z.string().max(100).default(""), clientId: z.uuid().nullish(), excludeId: z.uuid().nullish(), openOnly: z.boolean().default(false) });

export const searchTaskClients = defineAction(
  { name: "tasks.search_clients", schema: SearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<ClientOption[]>> => ok(await searchClientOptions(ctx.supabase, input.q)),
);

export const searchTasks = defineAction(
  { name: "tasks.search", schema: SearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<TaskOption[]>> =>
    ok(await searchTaskOptions(ctx.supabase, input.q, { clientId: input.clientId ?? null, excludeId: input.excludeId ?? null, openOnly: input.openOnly })),
);

export const listDeadlinesForClient = defineAction(
  { name: "tasks.client_deadlines", schema: z.object({ clientId: z.uuid() }), roles: PM },
  async (input, ctx): Promise<ActionResult<DeadlineOption[]>> => ok(await listClientDeadlines(ctx.supabase, input.clientId, todayIST())),
);

// =================================================================================================
// Export (§3.4 "CSV export of the current view")
// =================================================================================================

export const exportTasks = defineAction(
  { name: "tasks.export", schema: z.object({ query: z.string().max(4000) }), roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean }>> => {
    const t = parseTableParams(new URLSearchParams(input.query), { sortable: WORK_SORTABLE, defaultSort: { sort: "due_date", dir: "asc" }, filters: WORK_FILTERS });
    const viewer = { employeeId: ctx.user.employeeId, role: ctx.user.role, today: todayIST() };
    const { rows, truncated } = await listTasksForExport(ctx.supabase, t, viewer);
    const header = ["Task", "Title", "Client", "Client code", "Service", "FY", "Period", "Status", "Acceptance", "Priority", "Due date", "Days overdue", "Assignee", "Reviewer", "Checklist", "Estimate (min)", "Logged (min)", "Filed on"];
    const body = rows.map((r) => [
      r.task_number,
      r.title,
      r.client_name ?? "",
      r.client_code ?? "",
      r.service_type ? SERVICE_TYPE_LABELS[r.service_type] : "",
      r.financial_year ?? "",
      r.period_label ?? "",
      TASK_STATUS_NAMES[r.status],
      r.acceptance_status,
      r.priority,
      r.due_date ?? "",
      r.days_overdue,
      r.assignee_name ?? "",
      r.reviewer_name ?? "",
      `${r.checklist_done}/${r.checklist_total}`,
      r.estimated_minutes ?? "",
      r.logged_minutes,
      r.completion_date ? istDateOf(r.completion_date) : "",
    ]);
    await ctx.audit({ event: "export_run", resourceType: "tasks", details: { rows: rows.length, truncated, query: input.query } });
    return ok({
      fileName: `taxwise-tasks-${todayIST()}.csv`,
      mimeType: "text/csv;charset=utf-8",
      base64: Buffer.from(toCsv(header, body), "utf8").toString("base64"),
      rows: rows.length,
      truncated,
    });
  },
);

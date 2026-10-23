"use server";

import type { Json } from "@/lib/database.types";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import type { ComplianceType, ServiceType } from "@/lib/domain/enums";
import { parsePeriodLabel, todayIST, type DateString } from "@/lib/domain/fy";
import { serviceTypesOfEvent } from "@/lib/domain/statutory-calendar";
import { formatDate, formatTime } from "@/lib/format";
import {
  CancelEventSchema,
  EventFormSchema,
  FilingSchema,
  GenerateManySchema,
  GenerateSchema,
  NotesSchema,
  WorkflowChangeSchema,
} from "@/lib/schemas/compliance";
import { z } from "zod";
import { checklistHints } from "@/components/compliance/logic/event";
import { loadComplianceEngine } from "@/server/compliance/engine";
import { generateForClient, loadClientCalendarFacts, type GenerateResult } from "@/server/compliance/generate";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity } from "@/server/activity";
import { notify } from "@/server/notify";

/**
 * Compliance mutations (§7.7, §7.6.5, §5.6). Every one runs under the caller's session (RLS and the
 * compliance_events_guard trigger, 0125, are the real control; these checks mirror them):
 *
 *   generateDeadlinesForClient   "Generate deadlines" (Client 360), service changes and onboarding
 *                                after-effects: idempotent by dedupe_key (staff, own clients for Employees)
 *   generateDeadlinesForClients  the coverage-gaps one-click fix for many clients (Partner/Manager)
 *   saveComplianceEvent          add or edit a deadline (§7.7 event form), optionally with its task
 *   createTaskForEvent           a linked task for a deadline that has none
 *   changeComplianceWorkflow     Not started → … → Filed → Completed (change_compliance_workflow, 0126)
 *   recordComplianceFiling       the §7.6.5 details: creates the filing record and marks it Filed
 *   cancelComplianceEvent        cancel with a reason, or restore
 *   updateComplianceNotes        notes (Employees too, 0037 column limits)
 *
 * Nothing here carries fee data (§4.1): timeline entries are compliance_* events, never money-side.
 */

const STAFF = ["partner", "manager", "employee"] as const;
const MANAGERS = ["partner", "manager"] as const;

const NOT_VISIBLE = "That client isn't in your client list any more. It may be in the recycle bin.";
const GONE = "That deadline no longer exists, or isn't one of your clients'.";

function stale(updatedAt: string | null | undefined): string {
  return updatedAt
    ? `This deadline was changed by someone else at ${formatTime(updatedAt)} on ${formatDate(updatedAt)}. Reload to see their changes.`
    : "This deadline was changed by someone else. Reload to see their changes.";
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a === b || Date.parse(a) === Date.parse(b));

function plannedSentence(r: GenerateResult): string {
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} ${r.created === 1 ? "deadline" : "deadlines"} added`);
  if (r.updated) parts.push(`${r.updated} ${r.updated === 1 ? "date" : "dates"} updated`);
  if (r.retired) parts.push(`${r.retired} cancelled for ended services`);
  return parts.length ? parts.join(", ") : "Deadlines already up to date";
}

function generationWarnings(facts: { gstBlocked: boolean }, r: GenerateResult): string[] {
  const out: string[] = [];
  if (facts.gstBlocked) out.push("GST returns are active, but the client isn't recorded as GST-registered with a valid GSTIN, so no GST dates were planned. Update the GST details on the profile.");
  if (r.skippedRules > 0) out.push(`${r.skippedRules} ${r.skippedRules === 1 ? "row" : "rows"} on Law & rules couldn't be read and ${r.skippedRules === 1 ? "was" : "were"} skipped. A Partner should check the page.`);
  return out;
}

// -------------------------------------------------------------------------------------------------
// Generation (§7.7: on onboarding, on service changes, Generate deadlines, the monthly job)
// -------------------------------------------------------------------------------------------------

export const generateDeadlinesForClient = defineAction(
  { name: "compliance.generate", schema: GenerateSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<GenerateResult>> => {
    const today = todayIST();
    const facts = await loadClientCalendarFacts(ctx.supabase, input.clientId);
    if (!facts) return fail(NOT_VISIBLE, { code: "not_found" });
    const engine = await loadComplianceEngine(ctx.supabase, today);
    let r: GenerateResult | null = null;
    try {
      r = await generateForClient(ctx.supabase, facts.id, { today, engine, facts, retire: ctx.user.role !== "employee" });
    } catch (err) {
      // A refusal from upsert_compliance_events ('USER: …', RLS) reaches the user as a sentence.
      throwIfDbError(err as { code?: string; message?: string });
    }
    if (!r) return fail(NOT_VISIBLE, { code: "not_found" });
    const result = r;

    await ctx.audit({
      event: "data_create",
      resourceType: "compliance_events",
      resourceId: facts.id,
      details: { client: facts.displayName, created: result.created, updated: result.updated, locked: result.locked, retired: result.retired, generated: result.generated },
    });
    if (result.created > 0 || result.updated > 0 || result.retired > 0) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId: facts.id,
          eventType: "compliance_planned",
          title: `Compliance calendar updated: ${plannedSentence(result).toLowerCase()}`,
          metadata: { created: result.created, updated: result.updated },
        }),
      );
    }
    return ok(result, generationWarnings(facts, result));
  },
);

export const generateDeadlinesForClients = defineAction(
  { name: "compliance.generate_many", schema: GenerateManySchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ clients: number; created: number; updated: number; failed: string[] }>> => {
    const today = todayIST();
    const engine = await loadComplianceEngine(ctx.supabase, today);
    let created = 0;
    let updated = 0;
    let clients = 0;
    const failed: string[] = [];
    for (const clientId of input.clientIds) {
      const facts = await loadClientCalendarFacts(ctx.supabase, clientId);
      if (!facts) continue;
      try {
        const r = await generateForClient(ctx.supabase, clientId, { today, engine, facts, retire: true });
        if (!r) continue;
        clients++;
        created += r.created;
        updated += r.updated;
        if (r.created > 0 || r.updated > 0) {
          const res = r;
          ctx.after("Add to the clients' timelines", () =>
            addTimelineEvent({ clientId, eventType: "compliance_planned", title: `Compliance calendar updated: ${plannedSentence(res).toLowerCase()}`, metadata: { created: res.created, updated: res.updated } }),
          );
        }
      } catch {
        failed.push(facts.displayName);
      }
    }
    await ctx.audit({ event: "data_create", resourceType: "compliance_events", details: { clients, created, updated, failed: failed.length } });
    const warnings = failed.length ? [`Deadlines couldn't be planned for ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ` and ${failed.length - 5} more` : ""}. Try those clients one at a time.`] : [];
    return ok({ clients, created, updated, failed }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// The event form (§7.7)
// -------------------------------------------------------------------------------------------------

type EventRow = {
  id: string;
  client_id: string | null;
  type: string;
  form_code: string | null;
  title: string;
  description: string | null;
  financial_year: string | null;
  filing_period: string | null;
  period_start: string | null;
  due_date: string;
  source: string;
  rule_code: string | null;
  task_id: string | null;
  agm_date: string | null;
  status: string;
  workflow_status: string;
  is_statutory: boolean;
  updated_at: string;
};

const EVENT_COLUMNS = "id, client_id, type, form_code, title, description, financial_year, filing_period, period_start, due_date, source, rule_code, task_id, agm_date, status, workflow_status, is_statutory, updated_at";

async function loadEvent(ctx: ActionContext, id: string): Promise<EventRow | null> {
  const { data, error } = await ctx.supabase.from("compliance_events").select(EVENT_COLUMNS).eq("id", id).maybeSingle();
  throwIfDbError(error);
  return (data as EventRow | null) ?? null;
}

function dedupeKeyFor(clientId: string | null, formCode: string | null, period: string | null): string | null {
  return clientId && formCode && period ? `${clientId}|${formCode}|${period}` : null;
}

function periodDates(label: string | null): { period_start: string | null; period_end: string | null } {
  const p = label ? parsePeriodLabel(label) : null;
  return { period_start: p?.start ?? null, period_end: p?.end ?? null };
}

const DUPLICATE = "This client already has a deadline for that form and period. Open it from the calendar instead.";

/** The task a deadline brings (§7.7 "Linked task (create one automatically)"), assigned to the client's owner. */
async function createLinkedTask(ctx: ActionContext, ev: EventRow): Promise<{ id: string; task_number: string; assignee: string | null } | null> {
  if (!ev.client_id) return null;
  const { data: client, error: ce } = await ctx.supabase.from("clients").select("id, display_name, owner_employee_id").eq("id", ev.client_id).maybeSingle();
  throwIfDbError(ce);
  if (!client) throw new Error("client not visible for linked task");
  let assignee: string | null = null;
  if (client.owner_employee_id) {
    const { data: owner } = await ctx.supabase.from("employee_directory").select("id, is_active").eq("id", client.owner_employee_id).maybeSingle();
    assignee = owner?.is_active ? client.owner_employee_id : null;
  }
  const service = serviceTypesOfEvent({ type: ev.type as ComplianceType, formCode: ev.form_code, ruleCode: ev.rule_code, dueDate: ev.due_date })[0] ?? null;
  const { data: task, error } = await ctx.supabase
    .from("tasks")
    .insert({
      client_id: ev.client_id,
      title: ev.title.slice(0, 200),
      description: ev.description,
      service_type: service as ServiceType | null,
      financial_year: ev.financial_year,
      period_label: ev.filing_period,
      due_date: ev.due_date,
      priority: "medium",
      assigned_employee_id: assignee,
      acceptance_status: "pending",
      created_by: ctx.user.id,
      compliance_event_id: ev.id,
      task_number: "",
    })
    .select("id, task_number")
    .single();
  throwIfDbError(error);
  if (!task) return null;
  const link = await ctx.supabase.from("compliance_events").update({ task_id: task.id }).eq("id", ev.id);
  throwIfDbError(link.error);
  const items = checklistHints({ form_code: ev.form_code, period_start: ev.period_start });
  if (items.length) {
    const r = await ctx.supabase.from("task_checklist_items").insert(items.map((title, i) => ({ task_id: task.id, title, sort_order: i })));
    throwIfDbError(r.error);
  }
  const clientName = client.display_name;
  ctx.after("Add the task to the client's timeline", () =>
    addTimelineEvent({ clientId: ev.client_id, eventType: "task_created", title: `Task created: ${ev.title}`, metadata: { task_id: task.id, compliance_event_id: ev.id } }),
  );
  if (assignee) {
    const to = assignee;
    ctx.after("Tell the assignee", () =>
      notify({
        to: { employeeIds: [to] },
        type: "task_assigned",
        title: "Task assigned to you",
        body: `${ev.title} for ${clientName}, due ${formatDate(ev.due_date)}.`,
        linkUrl: `/work/${task.id}`,
        entity: { type: "task", id: task.id },
        clientId: ev.client_id,
      }),
    );
  }
  return { id: task.id, task_number: task.task_number, assignee };
}

export const saveComplianceEvent = defineAction(
  { name: "compliance.save_event", schema: EventFormSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string; taskId: string | null }>> => {
    const formCode = input.formCode;
    const period = input.filingPeriod;
    const isRoc = input.type === "roc";

    if (input.clientId) {
      const { data: client, error } = await ctx.supabase.from("clients").select("id, deleted_at").eq("id", input.clientId).maybeSingle();
      throwIfDbError(error);
      if (!client || client.deleted_at) return fail(NOT_VISIBLE, { code: "not_found", fieldErrors: { clientId: ["Choose a client from the list."] } });
    }

    // ---- New deadline ----
    if (!input.id) {
      const row = {
        client_id: input.clientId,
        type: input.type,
        form_code: formCode,
        title: input.title,
        description: input.description,
        financial_year: input.financialYear,
        filing_period: period,
        ...periodDates(period),
        due_date: input.dueDate,
        is_statutory: input.isStatutory,
        source: "manual" as const,
        reminder_days: input.reminderDays,
        notes: input.notes,
        dedupe_key: input.isStatutory ? dedupeKeyFor(input.clientId, formCode, period) : null,
        agm_date: isRoc ? input.agmDate : null,
      };
      const { data, error } = await ctx.supabase.from("compliance_events").insert(row).select(EVENT_COLUMNS).single();
      throwIfDbError(error, { uniqueField: "filingPeriod", uniqueMessage: DUPLICATE });
      const ev = data as EventRow;
      await ctx.audit({ event: "data_create", resourceType: "compliance_event", resourceId: ev.id, details: { title: ev.title, due_date: ev.due_date, client_id: ev.client_id } });
      ctx.after("Record it on the deadline's history", () =>
        logActivity({ entityType: "compliance_event", entityId: ev.id, action: "created", description: `Added by hand, due ${formatDate(ev.due_date)}.` }),
      );
      let taskId: string | null = null;
      const warnings: string[] = [];
      if (input.createTask && ev.client_id) {
        try {
          const t = await createLinkedTask(ctx, ev);
          taskId = t?.id ?? null;
          if (t && !t.assignee) warnings.push(`Task ${t.task_number} was created unassigned: the client has no active owner. Assign it on the Work tracker.`);
        } catch {
          warnings.push("The deadline was saved, but its task couldn't be created. Use Create task on the deadline.");
        }
      }
      const { data: after } = await ctx.supabase.from("compliance_events").select("updated_at").eq("id", ev.id).maybeSingle();
      return ok({ id: ev.id, updatedAt: after?.updated_at ?? ev.updated_at, taskId }, warnings);
    }

    // ---- Edit ----
    const before = await loadEvent(ctx, input.id);
    if (!before) return fail(GONE, { code: "not_found" });
    if (!sameInstant(before.updated_at, input.expectedUpdatedAt)) return fail(stale(before.updated_at), { code: "conflict" });
    if (before.client_id !== input.clientId) {
      return fail("A deadline can't be moved to another client. Cancel it and add one for the right client.", { code: "blocked", fieldErrors: { clientId: ["Keep the original client."] } });
    }
    const generated = before.source !== "manual";
    if (generated && (before.type !== input.type || before.form_code !== formCode || before.filing_period !== period || before.financial_year !== input.financialYear)) {
      return fail("Planned deadlines keep their type, form and period, so they never double up. Cancel this one and add one by hand instead.", {
        code: "blocked",
        fieldErrors: { formCode: ["Can't change on a planned deadline."] },
      });
    }

    const patch: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      due_date: input.dueDate,
      reminder_days: input.reminderDays,
      notes: input.notes,
    };
    if (!generated) {
      Object.assign(patch, {
        type: input.type,
        form_code: formCode,
        financial_year: input.financialYear,
        filing_period: period,
        ...periodDates(period),
        is_statutory: input.isStatutory,
        dedupe_key: input.isStatutory ? dedupeKeyFor(before.client_id, formCode, period) : null,
      });
    }
    if (isRoc) patch.agm_date = input.agmDate;
    const moved = before.due_date !== input.dueDate;
    if (moved) patch.reminder_sent_at = null;

    const { data, error } = await ctx.supabase.from("compliance_events").update(patch as never).eq("id", before.id).eq("updated_at", before.updated_at).select("id, updated_at");
    throwIfDbError(error, { uniqueField: "filingPeriod", uniqueMessage: DUPLICATE });
    if (!data || data.length === 0) {
      const now = await loadEvent(ctx, before.id);
      return fail(now ? stale(now.updated_at) : GONE, { code: now ? "conflict" : "not_found" });
    }

    await ctx.audit({ event: "data_update", resourceType: "compliance_event", resourceId: before.id, details: { title: input.title, due_from: before.due_date, due_to: input.dueDate } });
    if (moved) {
      ctx.after("Record the date change on the deadline's history", () =>
        logActivity({
          entityType: "compliance_event",
          entityId: before.id,
          action: "due_date_changed",
          description: `Due date moved by hand from ${formatDate(before.due_date)} to ${formatDate(input.dueDate)}.`,
          metadata: { from: before.due_date, to: input.dueDate },
        }),
      );
    }
    const agmChanged = isRoc && (before.agm_date ?? null) !== (input.agmDate ?? null);
    if (agmChanged) {
      ctx.after("Record the AGM date", () =>
        logActivity({
          entityType: "compliance_event",
          entityId: before.id,
          action: "agm_date_set",
          description: input.agmDate ? `AGM held on ${formatDate(input.agmDate)}.` : "AGM date cleared.",
          metadata: { agm_date: input.agmDate },
        }),
      );
      if (before.client_id && before.rule_code === "AGM") {
        const clientId = before.client_id;
        ctx.after(
          "Re-plan the AGM-linked dates",
          async () => {
            const r = await generateDeadlinesForClient({ clientId });
            if (!r.ok) throw new Error(r.error);
          },
          "The AGM date is saved, but ADT-1, AOC-4 and MGT-7 weren't re-planned. Use Generate deadlines on the client's Compliance tab.",
        );
      }
    }
    return ok({ id: before.id, updatedAt: data[0].updated_at, taskId: before.task_id });
  },
);

export const createTaskForEvent = defineAction(
  { name: "compliance.create_task", schema: z.object({ eventId: z.uuid({ error: "That deadline isn't valid." }) }), roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ taskId: string; taskNumber: string }>> => {
    const ev = await loadEvent(ctx, input.eventId);
    if (!ev) return fail(GONE, { code: "not_found" });
    if (!ev.client_id) return fail("A firm-level deadline has no client to open a task for.", { code: "blocked" });
    if (ev.task_id) return fail("This deadline already has a task. Open it from the deadline.", { code: "conflict" });
    if (ev.status === "cancelled") return fail("This deadline is cancelled. Restore it first.", { code: "blocked" });
    const t = await createLinkedTask(ctx, ev);
    if (!t) return fail("The task couldn't be created. Please try again.", { code: "blocked" });
    await ctx.audit({ event: "data_create", resourceType: "task", resourceId: t.id, details: { compliance_event_id: ev.id, title: ev.title } });
    const warnings = t.assignee ? [] : [`Task ${t.task_number} was created unassigned: the client has no active owner. Assign it on the Work tracker.`];
    return ok({ taskId: t.id, taskNumber: t.task_number }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// Workflow and filing (§7.7, §7.6.5)
// -------------------------------------------------------------------------------------------------

export const changeComplianceWorkflow = defineAction(
  { name: "compliance.workflow", schema: WorkflowChangeSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; from: string; to: string; status: string; updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("change_compliance_workflow", {
      p_event_id: input.eventId,
      p_to: input.to,
      p_reason: input.reason,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error && /changed by someone else/.test(error.message ?? "")) {
      const now = await loadEvent(ctx, input.eventId);
      return fail(stale(now?.updated_at), { code: "conflict" });
    }
    throwIfDbError(error);
    const r = (data ?? {}) as { id: string; client_id: string | null; from: string; to: string; status: string; updated_at: string };
    await ctx.audit({ event: "data_update", resourceType: "compliance_event", resourceId: input.eventId, details: { from: r.from, to: r.to, reason: input.reason } });
    const reopened = (r.from === "filed" || r.from === "completed") && r.to !== "filed" && r.to !== "completed";
    if (reopened && r.client_id) {
      const ev = await loadEvent(ctx, input.eventId);
      const clientId = r.client_id;
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({ clientId, eventType: "compliance_reopened", title: `Reopened: ${ev?.title ?? "a deadline"}`, description: input.reason ?? null, metadata: { compliance_event_id: input.eventId } }),
      );
    }
    return ok({ id: r.id, from: r.from, to: r.to, status: r.status, updatedAt: r.updated_at });
  },
);

export const recordComplianceFiling = defineAction(
  { name: "compliance.record_filing", schema: FilingSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ filingRecordId: string; workflowStatus: string; updatedAt: string; onTime: boolean }>> => {
    const ev = await loadEvent(ctx, input.eventId);
    if (!ev) return fail(GONE, { code: "not_found" });
    const service = input.serviceType ?? (serviceTypesOfEvent({ type: ev.type as ComplianceType, formCode: ev.form_code, ruleCode: ev.rule_code, dueDate: ev.due_date })[0] ?? null);
    const payload = {
      filing_record_id: input.filingRecordId,
      filing_type: input.filingType,
      period: input.period,
      financial_year: input.financialYear,
      filed_on: input.filedOn,
      acknowledgement_no: input.acknowledgementNo,
      service_type: service,
      document_id: input.documentId,
      udin_record_id: input.udinRecordId,
      notes: input.notes,
      shareable_with_client: input.shareableWithClient,
      complete: input.complete,
    };
    const { data, error } = await ctx.supabase.rpc("record_compliance_filing", {
      p_event_id: ev.id,
      p_filing: payload as unknown as Json,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error && /changed by someone else/.test(error.message ?? "")) {
      const now = await loadEvent(ctx, ev.id);
      return fail(stale(now?.updated_at), { code: "conflict" });
    }
    throwIfDbError(error);
    const r = (data ?? {}) as { filing_record_id: string; workflow_status: string; updated_at: string; on_time: boolean; filed_on: DateString | null; due_date: DateString };

    await ctx.audit({
      event: "data_create",
      resourceType: "filing_record",
      resourceId: r.filing_record_id,
      details: { compliance_event_id: ev.id, filing_type: input.filingType, period: input.period, filed_on: r.filed_on, acknowledgement_no: input.acknowledgementNo, linked_existing: Boolean(input.filingRecordId) },
    });

    const clientId = ev.client_id;
    if (clientId) {
      const when = r.filed_on ? ` on ${formatDate(r.filed_on)}` : "";
      const late = r.filed_on && !r.on_time ? " (after the due date)" : "";
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId,
          eventType: "compliance_filed",
          title: `Filed: ${ev.title}${when}${late}`,
          description: input.acknowledgementNo ? `Acknowledgement ${input.acknowledgementNo}` : null,
          metadata: { compliance_event_id: ev.id, filing_record_id: r.filing_record_id, on_time: r.on_time },
        }),
      );
      const { data: client } = await ctx.supabase.from("clients").select("display_name, owner_employee_id").eq("id", clientId).maybeSingle();
      if (client?.owner_employee_id) {
        const owner = client.owner_employee_id;
        ctx.after("Tell the client's owner", () =>
          notify({
            to: { employeeIds: [owner] },
            type: "info",
            title: `Filed: ${ev.title}`,
            body: `${client.display_name}${when ? `, filed${when}` : ""}${input.acknowledgementNo ? `. Acknowledgement ${input.acknowledgementNo}.` : "."}`,
            linkUrl: `/calendar?view=agenda&event=${ev.id}`,
            entity: { type: "compliance_event", id: ev.id },
            clientId,
          }),
        );
      }
    }

    const warnings: string[] = [];
    if (ev.task_id) {
      const { data: task } = await ctx.supabase.from("tasks").select("task_number, status").eq("id", ev.task_id).maybeSingle();
      if (task && task.status !== "filed_done") warnings.push(`The linked task ${task.task_number} is still open. Move it to Filed/Done on the task when the work is signed off.`);
    }
    return ok({ filingRecordId: r.filing_record_id, workflowStatus: r.workflow_status, updatedAt: r.updated_at, onTime: r.on_time }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// Cancel / restore, notes
// -------------------------------------------------------------------------------------------------

export const cancelComplianceEvent = defineAction(
  { name: "compliance.cancel", schema: CancelEventSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; status: string; updatedAt: string }>> => {
    const ev = await loadEvent(ctx, input.eventId);
    if (!ev) return fail(GONE, { code: "not_found" });
    if (!sameInstant(ev.updated_at, input.expectedUpdatedAt)) return fail(stale(ev.updated_at), { code: "conflict" });
    if (input.restore && ev.status !== "cancelled") return fail("This deadline isn't cancelled.", { code: "blocked" });
    if (!input.restore && ev.status === "cancelled") return fail("This deadline is already cancelled.", { code: "blocked" });
    if (!input.restore && (ev.workflow_status === "filed" || ev.workflow_status === "completed")) {
      return fail("A filed deadline can't be cancelled. Reopen it first if it was marked filed by mistake.", { code: "blocked" });
    }
    const { data, error } = await ctx.supabase
      .from("compliance_events")
      .update({ status: input.restore ? "pending" : "cancelled" })
      .eq("id", ev.id)
      .eq("updated_at", ev.updated_at)
      .select("id, status, updated_at");
    throwIfDbError(error);
    if (!data || data.length === 0) {
      const now = await loadEvent(ctx, ev.id);
      return fail(stale(now?.updated_at), { code: "conflict" });
    }
    await ctx.audit({ event: "data_update", resourceType: "compliance_event", resourceId: ev.id, action: input.restore ? "compliance.restore" : "compliance.cancel", details: { title: ev.title, reason: input.reason } });
    ctx.after("Record it on the deadline's history", () =>
      logActivity({
        entityType: "compliance_event",
        entityId: ev.id,
        action: input.restore ? "restored" : "cancelled",
        description: input.restore ? `Restored${input.reason ? `: ${input.reason}` : "."}` : `Cancelled: ${input.reason}`,
        metadata: { reason: input.reason },
      }),
    );
    if (ev.client_id && !input.restore) {
      const clientId = ev.client_id;
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({ clientId, eventType: "compliance_cancelled", title: `Deadline cancelled: ${ev.title}`, description: input.reason, metadata: { compliance_event_id: ev.id } }),
      );
    }
    return ok({ id: data[0].id, status: data[0].status, updatedAt: data[0].updated_at });
  },
);

export const updateComplianceNotes = defineAction(
  { name: "compliance.notes", schema: NotesSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const ev = await loadEvent(ctx, input.eventId);
    if (!ev) return fail(GONE, { code: "not_found" });
    if (!sameInstant(ev.updated_at, input.expectedUpdatedAt)) return fail(stale(ev.updated_at), { code: "conflict" });
    const { data, error } = await ctx.supabase.from("compliance_events").update({ notes: input.notes }).eq("id", ev.id).eq("updated_at", ev.updated_at).select("updated_at");
    throwIfDbError(error);
    if (!data || data.length === 0) {
      const now = await loadEvent(ctx, ev.id);
      return fail(stale(now?.updated_at), { code: "conflict" });
    }
    await ctx.audit({ event: "data_update", resourceType: "compliance_event", resourceId: ev.id, action: "compliance.notes" });
    return ok({ updatedAt: data[0].updated_at });
  },
);

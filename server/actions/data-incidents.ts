"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import type { Json, TablesUpdate } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STEP_LABELS, boardReportDueAt, incidentCloseBlockers, type IncidentFacts } from "@/lib/domain/dpdp";
import { IncidentActionSchema, IncidentCloseSchema, IncidentSchema, IncidentStepSchema, istLocalToIso, readIncidentActions, type IncidentAction } from "@/lib/schemas/dpdp";
import { logActivity } from "@/server/activity";
import { notify } from "@/server/notify";

/**
 * Personal data breaches (§6.10 "data_incidents records an incident and drives a checklist:
 * contain; assess; notify the Data Protection Board and the affected people within the time the
 * Rules require; record the root cause"). Partners only (§7.15.4; RLS 0039). The database keeps the
 * steps after detection and out of the future, and refuses to close an incident until every step is
 * done (0197 guard). Every step and action is appended to the incident's own log (`actions`), with
 * who and when, so the Board's report can be written from it.
 */

const PARTNER = ["partner"] as const;
const STALE = "This incident was changed by someone else. Reload to see their changes.";

type Row = {
  id: string;
  title: string | null;
  detected_at: string;
  contained_at: string | null;
  assessed_at: string | null;
  board_notified_at: string | null;
  principals_notified_at: string | null;
  root_cause: string | null;
  closed_at: string | null;
  actions: Json;
  updated_at: string;
};

const COLUMNS = "id, title, detected_at, contained_at, assessed_at, board_notified_at, principals_notified_at, root_cause, closed_at, actions, updated_at";

async function load(ctx: { supabase: ServerSupabase }, id: string): Promise<Row> {
  const { data, error } = await ctx.supabase.from("data_incidents").select(COLUMNS).eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That incident no longer exists.", { code: "not_found" });
  return data as Row;
}

function facts(r: Row): IncidentFacts {
  return {
    detectedAt: r.detected_at,
    containedAt: r.contained_at,
    assessedAt: r.assessed_at,
    boardNotifiedAt: r.board_notified_at,
    principalsNotifiedAt: r.principals_notified_at,
    rootCause: r.root_cause,
    closedAt: r.closed_at,
  };
}

function appended(actions: Json, entry: IncidentAction): Json {
  return [...readIncidentActions(actions), entry].slice(-500) as unknown as Json;
}

function dbStepError(error: { message?: string } | null, field: string): void {
  const msg = error?.message ?? "";
  if (msg.startsWith("USER: ") && /dated|detected|future/i.test(msg)) throw new ActionError(msg.slice(6), { fieldErrors: { [field]: [msg.slice(6)] } });
}

export const saveIncident = defineAction(
  { name: "data_incidents.save", schema: IncidentSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    if (new Date(input.detectedAt).getTime() > Date.now() + 5 * 60_000) {
      return fail("The breach can't have been detected in the future.", { code: "validation", fieldErrors: { detectedAt: ["Enter when it was detected."] } });
    }
    const values = {
      title: input.title,
      detected_at: input.detectedAt,
      description: input.description,
      data_categories: input.dataCategories,
      people_affected_estimate: input.peopleAffectedEstimate,
      severity: input.severity,
    };
    if (input.id) {
      if (!input.updatedAt) return fail(STALE, { code: "conflict" });
      const current = await load(ctx, input.id);
      if (current.closed_at) return fail("This incident is closed. Reopen it to change it.", { code: "blocked" });
      const { data, error } = await ctx.supabase.from("data_incidents").update(values).eq("id", input.id).eq("updated_at", input.updatedAt).select("id, updated_at");
      dbStepError(error, "detectedAt");
      throwIfDbError(error);
      if (!data?.length) return fail(STALE, { code: "conflict" });
      await ctx.audit({ event: "data_update", resourceType: "data_incident", resourceId: input.id, details: { severity: input.severity, categories: input.dataCategories, people: input.peopleAffectedEstimate } });
      return ok({ id: data[0].id, updatedAt: data[0].updated_at });
    }

    const entry: IncidentAction = { at: new Date().toISOString(), by: ctx.user.id, by_name: ctx.user.fullName, text: "Incident recorded" };
    const { data, error } = await ctx.supabase
      .from("data_incidents")
      .insert({ ...values, actions: [entry] as unknown as Json })
      .select("id, updated_at")
      .single();
    dbStepError(error, "detectedAt");
    throwIfDbError(error);
    const row = data!;
    const due = boardReportDueAt(input.detectedAt);
    await ctx.audit({ event: "data_create", resourceType: "data_incident", resourceId: row.id, details: { severity: input.severity, categories: input.dataCategories, people: input.peopleAffectedEstimate, detected_at: input.detectedAt } });
    ctx.after("Record it in the incident's history", () =>
      logActivity({ entityType: "data_incident", entityId: row.id, action: "data_incident_recorded", description: `Recorded by ${ctx.user.fullName}` }),
    );
    // A "warning", not "security_alert": insert_notifications (0101) refuses security alerts from a
    // signed-in session (only the system raises them). The practice-reminders job raises the
    // security_alert for the Board report deadline.
    ctx.after("Tell the Partners", () =>
      notify({
        to: { roles: ["partner"] },
        type: "warning",
        title: `Personal data breach recorded: ${input.title}`,
        body: `${INCIDENT_SEVERITY_LABELS[input.severity]} severity, recorded by ${ctx.user.fullName}. Contain it, assess it and send the Data Protection Board its report by ${formatDateTime(due)}.`,
        linkUrl: `/quality?tab=incidents&incident=${row.id}`,
        entity: { type: "data_incident", id: row.id },
        dedupeKey: `data_incident_recorded:${row.id}`,
      }),
    );
    return ok({ id: row.id, updatedAt: row.updated_at });
  },
);

export const recordIncidentStep = defineAction(
  { name: "data_incidents.step", schema: IncidentStepSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const current = await load(ctx, input.id);
    if (current.closed_at) return fail("This incident is closed. Reopen it to change its checklist.", { code: "blocked" });
    const at = input.undo || input.step === "root_cause" ? null : istLocalToIso(input.at ?? "");
    if (!input.undo && input.step !== "root_cause" && !at) return fail("Enter when it was done.", { code: "validation", fieldErrors: { at: ["Enter when it was done."] } });
    if (at && new Date(at).getTime() > Date.now() + 5 * 60_000) return fail("A step can't be dated in the future.", { code: "validation", fieldErrors: { at: ["Pick now or an earlier time."] } });
    if (at && new Date(at).getTime() < new Date(current.detected_at).getTime()) return fail("A step can't be dated before the breach was detected.", { code: "validation", fieldErrors: { at: ["Pick a time after it was detected."] } });

    const patch: TablesUpdate<"data_incidents"> = {};
    switch (input.step) {
      case "contain":
        patch.contained_at = input.undo ? null : at;
        break;
      case "assess":
        patch.assessed_at = input.undo ? null : at;
        if (!input.undo) patch.assessment = input.text;
        break;
      case "notify_board":
        patch.board_notified_at = input.undo ? null : at;
        if (!input.undo) patch.board_reference = input.text;
        break;
      case "notify_people":
        patch.principals_notified_at = input.undo ? null : at;
        break;
      case "root_cause":
        patch.root_cause = input.undo ? null : input.text;
        break;
    }
    const label = INCIDENT_STEP_LABELS[input.step];
    const entry: IncidentAction = {
      at: new Date().toISOString(),
      by: ctx.user.id,
      by_name: ctx.user.fullName,
      text: input.undo ? `Step undone: ${label}` : at ? `${label} (${formatDateTime(at)})` : label,
    };
    patch.actions = appended(current.actions, entry);
    const { data, error } = await ctx.supabase.from("data_incidents").update(patch).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at");
    dbStepError(error, "at");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "data_incident", resourceId: input.id, action: `data_incidents.step.${input.step}`, details: { undo: input.undo, at } });
    ctx.after("Record it in the incident's history", () =>
      logActivity({ entityType: "data_incident", entityId: input.id, action: "data_incident_step", description: `${entry.text}, by ${ctx.user.fullName}`, metadata: { step: input.step, undo: input.undo } }),
    );
    return ok({ updatedAt: data[0].updated_at });
  },
);

export const addIncidentAction = defineAction(
  { name: "data_incidents.action", schema: IncidentActionSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const current = await load(ctx, input.id);
    const entry: IncidentAction = { at: new Date().toISOString(), by: ctx.user.id, by_name: ctx.user.fullName, text: input.text };
    const { data, error } = await ctx.supabase
      .from("data_incidents")
      .update({ actions: appended(current.actions, entry) })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("updated_at");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "data_incident", resourceId: input.id, action: "data_incidents.action", details: { length: input.text.length } });
    return ok({ updatedAt: data[0].updated_at });
  },
);

export const closeIncident = defineAction(
  { name: "data_incidents.close", schema: IncidentCloseSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; closed: boolean }>> => {
    const current = await load(ctx, input.id);
    if (input.reopen) {
      if (!current.closed_at) return fail("The incident is already open.", { code: "blocked" });
    } else {
      if (current.closed_at) return fail("The incident is already closed.", { code: "blocked" });
      const blockers = incidentCloseBlockers(facts(current));
      if (blockers.length) {
        return fail(`Before closing: ${blockers.map((s) => INCIDENT_STEP_LABELS[s].toLowerCase()).join("; ")}.`, { code: "blocked" });
      }
    }
    const entry: IncidentAction = { at: new Date().toISOString(), by: ctx.user.id, by_name: ctx.user.fullName, text: input.reopen ? "Incident reopened" : "Incident closed" };
    const { data, error } = await ctx.supabase
      .from("data_incidents")
      .update({ closed_at: input.reopen ? null : new Date().toISOString(), actions: appended(current.actions, entry) })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("updated_at");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "data_incident", resourceId: input.id, action: input.reopen ? "data_incidents.reopen" : "data_incidents.close" });
    ctx.after("Record it in the incident's history", () =>
      logActivity({ entityType: "data_incident", entityId: input.id, action: input.reopen ? "data_incident_reopened" : "data_incident_closed", description: `${entry.text} by ${ctx.user.fullName}` }),
    );
    return ok({ updatedAt: data[0].updated_at, closed: !input.reopen });
  },
);

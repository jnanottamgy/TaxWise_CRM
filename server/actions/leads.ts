"use server";

import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { formatDateTime, formatTime } from "@/lib/format";
import { CALL_KIND_LABEL } from "@/lib/handoff";
import { LEAD_SOURCE_LABELS, SERVICE_TYPE_LABELS, type LeadStatus } from "@/lib/domain/enums";
import { todayIST } from "@/lib/domain/fy";
import { parseTableParams } from "@/components/app/data-table/params";
import { toCsv } from "@/lib/schemas/clients";
import { listLeads } from "@/lib/data/leads";
import { formatWhatsAppNumber } from "@/lib/domain/messaging";
import { getStatus } from "@/lib/status";
import {
  LEAD_FILTERS,
  LEAD_SORTABLE,
  LeadFollowUpSchema,
  LeadFormSchema,
  LeadHandoffSchema,
  LeadNoteSchema,
  LeadRefSchema,
  MoveLeadSchema,
  UpdateLeadSchema,
  leadMoveCheck,
  lostCategoryLabel,
  stageMoveTitle,
  type LeadFormData,
} from "@/lib/schemas/leads";
import type { ServerSupabase } from "@/lib/supabase/server";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";

/**
 * Leads (§7.5.1), Partner/Manager only (§4.1: leads never reach an Employee; RLS 0034 refuses
 * anyone else). Create and edit (at least one contact method), move between stages (a reason for
 * Lost; a converted lead stays Won: 0142), log calls and notes, record WhatsApp / Gmail hand-offs
 * and the next follow-up, and delete. A lead's story is its timeline (client_timeline_events with
 * lead_id, money-side so Employees never read it), written here; the client it becomes inherits it.
 * Converting goes through the onboarding wizard (/clients/new?fromLead=<id>), whose
 * onboard_client function marks the lead Won and stamps converted_client_id once.
 */

const PM = ["partner", "manager"] as const;

const LEAD_COLUMNS = "id, lead_number, name, company, status, assigned_to, next_follow_up_at, converted_client_id, updated_at, deleted_at";

type LeadRow = {
  id: string;
  lead_number: string | null;
  name: string;
  company: string | null;
  status: LeadStatus;
  assigned_to: string | null;
  next_follow_up_at: string | null;
  converted_client_id: string | null;
  updated_at: string;
  deleted_at: string | null;
};

async function loadLead(supabase: ServerSupabase, id: string): Promise<LeadRow> {
  const { data, error } = await supabase.from("leads").select(LEAD_COLUMNS).eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("This lead no longer exists. It may have been deleted.", { code: "not_found" });
  return data as LeadRow;
}

function conflict(updatedAt: string): ActionError {
  return new ActionError(`This lead was changed at ${formatTime(updatedAt)}. Reload to see the changes.`, { code: "conflict" });
}

function label(lead: Pick<LeadRow, "name" | "company" | "lead_number">): string {
  return `${lead.lead_number ? `${lead.lead_number} · ` : ""}${lead.company ? `${lead.company} (${lead.name})` : lead.name}`;
}

/** Leads are worked by Partners and Managers (Employees can't see them, §4.1). */
async function assertAssignable(supabase: ServerSupabase, employeeId: string | null): Promise<void> {
  if (!employeeId) return;
  const { data, error } = await supabase.from("employees").select("id, is_active, deleted_at, staff_role, profiles(role, is_active)").eq("id", employeeId).maybeSingle();
  throwIfDbError(error);
  const p = data?.profiles as { role: string; is_active: boolean } | null | undefined;
  const role = p?.role ?? data?.staff_role;
  if (!data || !data.is_active || data.deleted_at || (p && !p.is_active)) {
    throw new ActionError("That person isn't an active member of the team.", { code: "validation", fieldErrors: { assigned_to: ["Choose an active Partner or Manager."] } });
  }
  if (role !== "partner" && role !== "manager") {
    throw new ActionError("Leads are handled by Partners and Managers.", { code: "validation", fieldErrors: { assigned_to: ["Choose a Partner or Manager: Employees don't see leads."] } });
  }
}

function rowFrom(v: LeadFormData) {
  return {
    name: v.name,
    company: v.company || null,
    email: v.email || null,
    phone: v.phone || null,
    whatsapp: v.whatsapp || null,
    services_required: v.services_required,
    requirement_notes: v.requirement_notes || null,
    source: v.source,
    source_detail: v.source_detail || null,
    estimated_value: v.estimated_value === null ? null : Number(v.estimated_value),
    assigned_to: v.assigned_to,
    next_follow_up_at: v.next_follow_up_at,
    status: v.status,
  };
}

function tellAssignee(ctx: { user: { employeeId: string | null; fullName: string } }, lead: { id: string; name: string; company: string | null; lead_number: string | null }, employeeId: string | null) {
  if (!employeeId || employeeId === ctx.user.employeeId) return null;
  return () =>
    notify({
      to: { employeeIds: [employeeId] },
      type: "info",
      title: `Lead assigned to you: ${lead.company || lead.name}`,
      body: `${ctx.user.fullName} asked you to take ${label(lead)} forward.`,
      linkUrl: `/leads/${lead.id}`,
      entity: { type: "lead", id: lead.id },
    });
}

export const createLead = defineAction(
  { name: "leads.create", schema: LeadFormSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; leadNumber: string | null }>> => {
    await assertAssignable(ctx.supabase, input.assigned_to);
    const { data, error } = await ctx.supabase
      .from("leads")
      .insert({ ...rowFrom(input), created_by: ctx.user.id })
      .select("id, lead_number, name, company")
      .single();
    throwIfDbError(error);
    const lead = data!;
    await ctx.audit({ event: "data_create", resourceType: "lead", resourceId: lead.id, action: "leads.create", details: { lead_number: lead.lead_number, source: input.source, assigned_to: input.assigned_to } });
    ctx.after("Start the lead's timeline", () =>
      addTimelineEvent({
        leadId: lead.id,
        eventType: "lead_created",
        title: `Lead ${lead.lead_number ?? ""} added from ${LEAD_SOURCE_LABELS[input.source].toLowerCase()}`.replace(/\s+/g, " "),
        description: input.requirement_notes || null,
        metadata: { source: input.source, source_detail: input.source_detail || null },
      }),
    );
    const tell = tellAssignee(ctx, lead, input.assigned_to);
    if (tell) ctx.after("Tell the person it's assigned to", tell);
    return ok({ id: lead.id, leadNumber: lead.lead_number });
  },
);

export const updateLead = defineAction(
  { name: "leads.update", schema: UpdateLeadSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const before = await loadLead(ctx.supabase, input.id);
    if (before.updated_at !== input.updatedAt) throw conflict(before.updated_at);
    await assertAssignable(ctx.supabase, input.assigned_to);
    const { status, ...rest } = rowFrom(input);
    // The form offers the open stages only; editing a Won or Lost lead keeps its stage.
    const patch = before.status === "won" || before.status === "lost" ? rest : { ...rest, status };
    const { data, error } = await ctx.supabase
      .from("leads")
      .update(patch)
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at, status, name, company, lead_number")
      .maybeSingle();
    throwIfDbError(error);
    if (!data) throw conflict(before.updated_at);
    await ctx.audit({
      event: "data_update",
      resourceType: "lead",
      resourceId: input.id,
      action: "leads.update",
      details: { before: { status: before.status, assigned_to: before.assigned_to, next_follow_up_at: before.next_follow_up_at }, after: { status: data.status, assigned_to: input.assigned_to, next_follow_up_at: input.next_follow_up_at } },
    });
    if (data.status !== before.status) {
      ctx.after("Add the stage change to the timeline", () =>
        addTimelineEvent({ leadId: input.id, eventType: "lead_status_changed", title: stageMoveTitle(getStatus("lead_status", before.status).label, getStatus("lead_status", data.status).label) }),
      );
    }
    if (input.assigned_to !== before.assigned_to) {
      const tell = tellAssignee(ctx, data, input.assigned_to);
      if (tell) ctx.after("Tell the person it's assigned to", tell);
    }
    return ok({ updatedAt: data.updated_at });
  },
);

export const moveLeadStage = defineAction(
  { name: "leads.move", schema: MoveLeadSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; status: LeadStatus }>> => {
    const before = await loadLead(ctx.supabase, input.id);
    if (before.updated_at !== input.updatedAt) throw conflict(before.updated_at);
    const check = leadMoveCheck(before, input.to);
    if (!check.ok) return fail(check.error, { code: "blocked" });
    const patch =
      input.to === "lost"
        ? { status: input.to, lost_category: input.lostCategory, lost_reason: input.lostReason }
        : { status: input.to };
    const { data, error } = await ctx.supabase.from("leads").update(patch).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at, status").maybeSingle();
    throwIfDbError(error);
    if (!data) throw conflict(before.updated_at);
    await ctx.audit({
      event: "data_update",
      resourceType: "lead",
      resourceId: input.id,
      action: "leads.move",
      details: { from: before.status, to: input.to, lost_category: input.lostCategory, lost_reason: input.to === "lost" ? input.lostReason : null },
    });
    const from = getStatus("lead_status", before.status).label;
    const to = getStatus("lead_status", input.to).label;
    ctx.after("Add the stage change to the timeline", () =>
      addTimelineEvent({
        leadId: input.id,
        clientId: before.converted_client_id,
        eventType: "lead_status_changed",
        title: stageMoveTitle(from, to),
        description: input.to === "lost" ? `${lostCategoryLabel(input.lostCategory)}: ${input.lostReason}` : null,
        metadata: { from: before.status, to: input.to },
      }),
    );
    return ok({ updatedAt: data.updated_at, status: data.status });
  },
);

export const logLeadNote = defineAction(
  { name: "leads.log_call", schema: LeadNoteSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string | null }>> => {
    const lead = await loadLead(ctx.supabase, input.leadId);
    const isNote = input.kind === "note";
    const title = isNote
      ? input.subject
        ? `Note: ${input.subject}`
        : "Note added"
      : `${CALL_KIND_LABEL[input.kind]}${input.subject ? `: ${input.subject}` : ""}`;
    const at = input.occurredAt ?? new Date().toISOString();
    const { error } = await ctx.supabase.from("client_timeline_events").insert({
      lead_id: lead.id,
      client_id: lead.converted_client_id,
      event_type: isNote ? "lead_note_added" : "lead_call_logged",
      title,
      description: input.body,
      metadata: { kind: input.kind, occurred_at: at },
      performed_by: ctx.user.id,
    });
    throwIfDbError(error);
    let updatedAt: string | null = null;
    if (input.nextFollowUpAt !== null && input.nextFollowUpAt !== lead.next_follow_up_at) {
      const { data, error: fErr } = await ctx.supabase.from("leads").update({ next_follow_up_at: input.nextFollowUpAt }).eq("id", lead.id).select("updated_at").maybeSingle();
      throwIfDbError(fErr);
      updatedAt = data?.updated_at ?? null;
    }
    await ctx.audit({
      event: "data_create",
      resourceType: "lead",
      resourceId: lead.id,
      action: "leads.log_call",
      details: { kind: input.kind, occurred_at: at, next_follow_up_at: input.nextFollowUpAt },
    });
    return ok({ updatedAt });
  },
);

export const logLeadHandoff = defineAction(
  { name: "leads.handoff", schema: LeadHandoffSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ ok: true }>> => {
    const lead = await loadLead(ctx.supabase, input.leadId);
    const app = input.channel === "whatsapp_handoff" ? "WhatsApp" : "Gmail";
    const to = input.channel === "whatsapp_handoff" && /^\d{8,15}$/.test(input.recipient) ? formatWhatsAppNumber(input.recipient) : input.recipient;
    const { error } = await ctx.supabase.from("client_timeline_events").insert({
      lead_id: lead.id,
      client_id: lead.converted_client_id,
      event_type: "lead_message_sent",
      title: input.subject ? `${app} handed off to ${to}: ${input.subject}` : `${app} handed off to ${to}`,
      description: input.body,
      metadata: { channel: input.channel, recipient: input.recipient },
      performed_by: ctx.user.id,
    });
    throwIfDbError(error);
    await ctx.audit({ event: "data_create", resourceType: "lead", resourceId: lead.id, action: "leads.handoff", details: { channel: input.channel, recipient: input.recipient } });
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({
        activityType: input.channel === "whatsapp_handoff" ? "whatsapp_sent" : "email_sent",
        description: `${app} handed off to ${label(lead)}`,
        entityType: "lead",
        entityId: lead.id,
        entityName: lead.company || lead.name,
      }),
    );
    return ok({ ok: true });
  },
);

export const setLeadFollowUp = defineAction(
  { name: "leads.follow_up", schema: LeadFollowUpSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const before = await loadLead(ctx.supabase, input.id);
    if (before.updated_at !== input.updatedAt) throw conflict(before.updated_at);
    const { data, error } = await ctx.supabase.from("leads").update({ next_follow_up_at: input.nextFollowUpAt }).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at").maybeSingle();
    throwIfDbError(error);
    if (!data) throw conflict(before.updated_at);
    await ctx.audit({ event: "data_update", resourceType: "lead", resourceId: input.id, action: "leads.follow_up", details: { before: before.next_follow_up_at, after: input.nextFollowUpAt } });
    ctx.after("Add to the timeline", () =>
      addTimelineEvent({
        leadId: input.id,
        eventType: "lead_follow_up_set",
        title: input.nextFollowUpAt ? `Next follow-up set for ${formatDateTime(input.nextFollowUpAt)}` : "Next follow-up cleared",
      }),
    );
    return ok({ updatedAt: data.updated_at });
  },
);

export const deleteLead = defineAction(
  { name: "leads.delete", schema: LeadRefSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const before = await loadLead(ctx.supabase, input.id);
    if (before.converted_client_id) return fail("This lead has become a client, so it stays on record. Delete the client instead if it was a mistake.", { code: "blocked" });
    const { data, error } = await ctx.supabase
      .from("leads")
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.user.id })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id")
      .maybeSingle();
    throwIfDbError(error);
    if (!data) throw conflict(before.updated_at);
    await ctx.audit({ event: "data_delete", resourceType: "lead", resourceId: input.id, action: "leads.delete", details: { lead_number: before.lead_number, name: before.name, status: before.status } });
    ctx.after("Add to the timeline", () => addTimelineEvent({ leadId: input.id, eventType: "lead_deleted", title: "Lead moved to the recycle bin" }));
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Export (§3.4 "CSV export of the current view"; §12 every export audited)
// =================================================================================================

const EXPORT_MAX = 5000;

export type LeadExport = { fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean };

export const exportLeads = defineAction(
  { name: "leads.export", schema: z.object({ query: z.string().max(2000).default("") }), roles: PM },
  async (input, ctx): Promise<ActionResult<LeadExport>> => {
    const t = parseTableParams(new URLSearchParams(input.query), { sortable: LEAD_SORTABLE, defaultSort: { sort: "last_activity_at", dir: "desc" }, filters: LEAD_FILTERS });
    const { rows, total } = await listLeads(ctx.supabase, { ...t, from: 0, to: EXPORT_MAX - 1 });
    const header = ["Lead number", "Name", "Company", "Email", "Phone", "WhatsApp", "Stage", "Lost because", "Source", "Source detail", "Services", "Estimated value a year (₹)", "Assigned to", "Next follow-up", "Last activity", "Open quotations", "Open quotation value (₹)", "Added on"];
    const body = rows.map((r) => [
      r.lead_number ?? "",
      r.name,
      r.company ?? "",
      r.email ?? "",
      r.phone ?? "",
      r.whatsapp ?? "",
      getStatus("lead_status", r.status).label,
      r.status === "lost" ? `${lostCategoryLabel(r.lost_category)}${r.lost_reason ? `: ${r.lost_reason}` : ""}` : "",
      LEAD_SOURCE_LABELS[r.source],
      r.source_detail ?? "",
      r.services_required.map((s) => SERVICE_TYPE_LABELS[s]).join("; "),
      r.estimated_value === null ? "" : r.estimated_value.toFixed(2),
      r.assigned_name ?? "",
      r.next_follow_up_at ? formatDateTime(r.next_follow_up_at) : "",
      formatDateTime(r.last_activity_at),
      r.open_quotations,
      r.open_quotation_value.toFixed(2),
      formatDateTime(r.created_at),
    ]);
    const truncated = total > rows.length;
    await ctx.audit({ event: "export_run", resourceType: "leads", details: { rows: rows.length, truncated, query: input.query } });
    return ok({
      fileName: `taxwise-leads-${todayIST()}.csv`,
      mimeType: "text/csv;charset=utf-8",
      base64: Buffer.from(toCsv(header, body), "utf8").toString("base64"),
      rows: rows.length,
      truncated,
    });
  },
);

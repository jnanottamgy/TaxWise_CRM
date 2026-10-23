"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { env } from "@/lib/env";
import { todayIST, type DateString } from "@/lib/domain/fy";
import { complianceServiceType } from "@/lib/domain/reminders";
import type { ComplianceType, ServiceType } from "@/lib/domain/enums";
import { readWhatsAppSignaturePreference } from "@/lib/schemas/profile";
import { requestPortalPath } from "@/lib/schemas/document-requests";
import { channelFits, isMoneyTemplateType } from "@/lib/schemas/message-templates";
import {
  BULK_MAX_STEPS,
  PrepareQueueSchema,
  complianceWindowEnd,
  planQueueStep,
  queueLabel,
  sortQueue,
  type QueueClient,
  type QueueContact,
  type QueueContext,
  type QueueFacts,
  type QueueSkip,
  type QueueStep,
} from "@/lib/schemas/inbox";
import { myClientIds } from "@/lib/data/threads";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Bulk WhatsApp reminders (§7.13.2 "for a filtered list (e.g. all clients with GSTR-3B data
 * pending), the app builds a queue of personalised drafts. The user steps through them ('Open
 * WhatsApp → mark handed off → next'), each logged. Nothing is sent without a person pressing Send.").
 *
 * prepareBulkQueue builds the drafts; it sends nothing and writes nothing. Each step is logged as a
 * `whatsapp_handoff / handed_off` message by logHandoff (server/actions/messages.ts) when the person
 * marks it handed off. Everything is read under the caller's RLS: an Employee's queue covers only
 * the clients they can see. The sources are never about money (no payment reminders here; §4.1),
 * and a payment-reminder or quotation template is refused for everyone.
 */

type Raw = { key: string; clientId: string; facts: Omit<QueueFacts, "contactName" | "clientName" | "clientCode">; related: { type: string; id: string } };

const DAY_CAP = 60;

async function loadTemplate(supabase: ServerSupabase, templateId: string | null): Promise<{ id: string; name: string; body: string } | null> {
  if (!templateId) return null;
  const { data, error } = await supabase.from("message_templates").select("id, name, type, channel, body, is_active").eq("id", templateId).maybeSingle();
  throwIfDbError(error);
  if (!data || !data.is_active) throw new ActionError("That template isn't available any more. Pick another, or use the suggested message.", { code: "validation", fieldErrors: { templateId: ["Pick another template."] } });
  if (isMoneyTemplateType(data.type)) throw new ActionError("Payment and quotation templates can't be used for bulk reminders.", { code: "validation", fieldErrors: { templateId: ["Pick a reminder template."] } });
  if (!channelFits(data.channel, "whatsapp")) throw new ActionError("That template is for email. Pick a WhatsApp template, or use the suggested message.", { code: "validation", fieldErrors: { templateId: ["Pick a WhatsApp template."] } });
  return { id: data.id, name: String(data.name), body: data.body };
}

async function fromTasks(supabase: ServerSupabase, filter: { ids?: string[]; service?: ServiceType | null; mineEmployeeId?: string | null }, portalLink: string): Promise<Raw[]> {
  let q = supabase
    .from("tasks")
    .select("id, task_number, title, client_id, service_type, period_label, due_date, priority, status")
    .is("deleted_at", null)
    .neq("status", "filed_done")
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(BULK_MAX_STEPS + 1);
  // A data request only makes sense while the task waits on the client: picked ids are narrowed too.
  q = q.eq("status", "data_awaited");
  if (filter.ids) q = q.in("id", filter.ids);
  if (filter.service) q = q.eq("service_type", filter.service);
  if (filter.mineEmployeeId) q = q.eq("assigned_employee_id", filter.mineEmployeeId);
  const { data, error } = await q;
  throwIfDbError(error);
  const tasks = data ?? [];
  if (tasks.length === 0) return [];
  const { data: items, error: itemsError } = await supabase
    .from("task_checklist_items")
    .select("task_id, title, done, sort_order")
    .in("task_id", tasks.map((t) => t.id))
    .eq("done", false)
    .order("sort_order");
  throwIfDbError(itemsError);
  const open = new Map<string, string[]>();
  for (const i of items ?? []) open.set(i.task_id, [...(open.get(i.task_id) ?? []), i.title]);
  return tasks.map((t) => ({
    key: `task:${t.id}`,
    clientId: t.client_id,
    related: { type: "task", id: t.id },
    facts: {
      kind: "data_awaited",
      serviceType: (t.service_type as ServiceType | null) ?? null,
      complianceType: null,
      formLabel: null,
      period: t.period_label ?? null,
      dueDate: (t.due_date as DateString | null) ?? null,
      taskTitle: t.title,
      priority: t.priority ? t.priority.charAt(0).toUpperCase() + t.priority.slice(1) : null,
      missing: open.get(t.id) ?? [],
      portalLink,
    },
  }));
}

async function fromCompliance(
  supabase: ServerSupabase,
  filter: { ids?: string[]; withinDays?: number; complianceType?: ComplianceType | null; clientIds?: string[] | null },
  today: DateString,
  portalLink: string,
): Promise<Raw[]> {
  let q = supabase
    .from("compliance_events")
    .select("id, client_id, type, form_code, title, filing_period, due_date, status")
    .eq("status", "pending")
    .not("client_id", "is", null)
    .order("due_date", { ascending: true })
    .limit(BULK_MAX_STEPS + 1);
  if (filter.ids) q = q.in("id", filter.ids);
  else q = q.gte("due_date", today).lte("due_date", complianceWindowEnd(today, Math.min(DAY_CAP, filter.withinDays ?? 7)));
  if (filter.complianceType) q = q.eq("type", filter.complianceType);
  if (filter.clientIds) q = q.in("client_id", filter.clientIds);
  const { data, error } = await q;
  throwIfDbError(error);
  return (data ?? []).map((e) => ({
    key: `compliance:${e.id}`,
    clientId: e.client_id as string,
    related: { type: "compliance_event", id: e.id },
    facts: {
      kind: "compliance_due",
      serviceType: complianceServiceType(e.type),
      complianceType: e.type as ComplianceType,
      formLabel: e.form_code ?? e.title ?? null,
      period: e.filing_period ?? null,
      dueDate: e.due_date as DateString,
      taskTitle: null,
      priority: null,
      missing: [],
      portalLink,
    },
  }));
}

async function fromRequests(supabase: ServerSupabase, filter: { ids?: string[]; clientIds?: string[] | null }, appUrl: string): Promise<Raw[]> {
  let q = supabase.from("document_requests").select("id, client_id, title, due_date, status").eq("status", "open").order("due_date", { ascending: true, nullsFirst: false }).limit(BULK_MAX_STEPS + 1);
  if (filter.ids) q = q.in("id", filter.ids);
  if (filter.clientIds) q = q.in("client_id", filter.clientIds);
  const { data, error } = await q;
  throwIfDbError(error);
  const requests = data ?? [];
  if (requests.length === 0) return [];
  const { data: items, error: itemsError } = await supabase
    .from("document_request_items")
    .select("request_id, title, status, sort_order")
    .in("request_id", requests.map((r) => r.id))
    .in("status", ["pending", "rejected"])
    .order("sort_order");
  throwIfDbError(itemsError);
  const pending = new Map<string, string[]>();
  for (const i of items ?? []) pending.set(i.request_id, [...(pending.get(i.request_id) ?? []), i.title]);
  // A request with nothing left to upload needs no reminder (§7.14 "Reminders stop when nothing is pending").
  return requests
    .filter((r) => (pending.get(r.id) ?? []).length > 0)
    .map((r) => ({
      key: `request:${r.id}`,
      clientId: r.client_id,
      related: { type: "document_request", id: r.id },
      facts: {
        kind: "document_request",
        serviceType: null,
        complianceType: null,
        formLabel: null,
        period: null,
        dueDate: (r.due_date as DateString | null) ?? null,
        taskTitle: r.title,
        priority: null,
        missing: pending.get(r.id) ?? [],
        portalLink: `${appUrl}${requestPortalPath(r.id)}`,
      },
    }));
}

export const prepareBulkQueue = defineAction(
  { name: "bulk_queue.prepare", schema: PrepareQueueSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ steps: QueueStep[]; skipped: QueueSkip[]; truncated: boolean; templateName: string | null }>> => {
    const today = todayIST();
    const appUrl = env.appUrl().replace(/\/+$/, "");
    const portalLink = `${appUrl}/portal`;
    const [template, settings] = await Promise.all([
      loadTemplate(ctx.supabase, input.templateId),
      ctx.supabase.from("firm_settings").select("firm_name, phone, whatsapp_country_code, whatsapp_signature").eq("id", 1).maybeSingle(),
    ]);
    throwIfDbError(settings.error);

    const source = input.source;
    const mine = "mine" in source && source.mine;
    const myClients = mine && ctx.user.employeeId ? await myClientIds(ctx.supabase, ctx.user.employeeId) : mine ? [] : null;

    let raw: Raw[];
    switch (source.kind) {
      case "data_awaited":
        raw = await fromTasks(ctx.supabase, { service: source.service, mineEmployeeId: mine ? (ctx.user.employeeId ?? "00000000-0000-0000-0000-000000000000") : null }, portalLink);
        break;
      case "tasks":
        raw = await fromTasks(ctx.supabase, { ids: source.ids }, portalLink);
        break;
      case "compliance_due":
        raw = myClients && myClients.length === 0 ? [] : await fromCompliance(ctx.supabase, { withinDays: source.withinDays, complianceType: source.complianceType, clientIds: myClients?.slice(0, 500) ?? null }, today, portalLink);
        break;
      case "compliance_events":
        raw = await fromCompliance(ctx.supabase, { ids: source.ids }, today, portalLink);
        break;
      case "document_requests":
        raw = myClients && myClients.length === 0 ? [] : await fromRequests(ctx.supabase, { clientIds: myClients?.slice(0, 500) ?? null }, appUrl);
        break;
      case "request_ids":
        raw = await fromRequests(ctx.supabase, { ids: source.ids }, appUrl);
        break;
    }

    const truncated = raw.length > BULK_MAX_STEPS;
    raw = raw.slice(0, BULK_MAX_STEPS);
    if (raw.length === 0) return ok({ steps: [], skipped: [], truncated: false, templateName: template?.name ?? null });

    const clientIds = Array.from(new Set(raw.map((r) => r.clientId)));
    const [clients, contacts] = await Promise.all([
      ctx.supabase.from("clients").select("id, display_name, client_code, phone, whatsapp, status, deleted_at").in("id", clientIds),
      ctx.supabase.from("client_contacts").select("id, client_id, name, phone, whatsapp, is_primary, handles").in("client_id", clientIds),
    ]);
    throwIfDbError(clients.error);
    throwIfDbError(contacts.error);
    const clientById = new Map<string, QueueClient>();
    for (const c of clients.data ?? []) {
      if (c.deleted_at) continue;
      clientById.set(c.id, { id: c.id, name: c.display_name, code: String(c.client_code), phone: c.phone, whatsapp: c.whatsapp, status: c.status });
    }
    const contactsBy = new Map<string, QueueContact[]>();
    for (const c of contacts.data ?? []) {
      contactsBy.set(c.client_id, [...(contactsBy.get(c.client_id) ?? []), { id: c.id, name: c.name, phone: c.phone, whatsapp: c.whatsapp, isPrimary: c.is_primary, handles: c.handles ?? [] }]);
    }

    const s = settings.data;
    const qctx: QueueContext = {
      firmName: s?.firm_name ?? "TaxWise Consultants",
      firmPhone: s?.phone ?? null,
      senderName: ctx.user.fullName,
      today,
      countryCode: s?.whatsapp_country_code ?? "91",
      signature: readWhatsAppSignaturePreference(ctx.user.preferences, ctx.user.role) ? { format: s?.whatsapp_signature ?? "– {first_name}" } : null,
    };

    const steps: QueueStep[] = [];
    const skipped: QueueSkip[] = [];
    for (const r of raw) {
      const client = clientById.get(r.clientId);
      if (!client) {
        // A task assigned to you on a client you can't open (§4.1), or a client in the recycle bin.
        skipped.push({ clientName: "A client you can't open", label: queueLabel({ ...r.facts, clientName: "", clientCode: "", contactName: null }), reason: "Not one of your clients. Ask its owner to remind them." });
        continue;
      }
      const planned = planQueueStep({ key: r.key, facts: r.facts, client, contacts: contactsBy.get(r.clientId) ?? [], ctx: qctx, template, related: r.related });
      if ("step" in planned) steps.push(planned.step);
      else skipped.push(planned.skip);
    }
    return ok({ steps: sortQueue(steps), skipped, truncated, templateName: template?.name ?? null });
  },
);

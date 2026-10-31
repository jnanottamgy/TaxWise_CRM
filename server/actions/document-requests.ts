"use server";

/**
 * Document requests: PBC lists, the staff side (§5.8, §7.14, §9, §10.11). Staff who can see the
 * client create and manage them (RLS 0037); removing an item is Partner/Manager.
 *
 *   createDocumentRequest   title, due date, items, notes, reminder cadence, who it goes to; one
 *                           transaction (create_document_request, 0122). The client sees it in the
 *                           portal at once, and the screen then offers Send on WhatsApp with the
 *                           list and the portal link (nothing is emailed).
 *   updateDocumentRequest   title, due date, notes, cadence, contact (optimistic, §13).
 *   addRequestItem / updateRequestItem / removeRequestItem
 *   reviewRequestItem       Accept (with the uploaded file, or a vault document), or Reject with a
 *                           reason: the client is told in the portal (§7.14), and on WhatsApp from
 *                           the request. The request completes by itself when every required item
 *                           is accepted (0122).
 *   cancelDocumentRequest / reopenDocumentRequest
 *   recordRequestHandoff    a WhatsApp hand-off of the request counts as a reminder, so the 09:00
 *                           job doesn't ask for another one the next morning.
 *
 * Every save writes an audit row and, where it is part of the client's story, a timeline entry.
 */

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { env } from "@/lib/env";
import { formatDate, formatTime } from "@/lib/format";
import type { RequestItemStatus, RequestStatus } from "@/lib/domain/enums";
import {
  AddRequestItemSchema,
  CancelDocumentRequestSchema,
  CreateDocumentRequestSchema,
  RecordRequestHandoffSchema,
  RemoveRequestItemSchema,
  ReopenDocumentRequestSchema,
  ReviewRequestItemSchema,
  UpdateDocumentRequestSchema,
  UpdateRequestItemSchema,
  requestPortalPath,
} from "@/lib/schemas/document-requests";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";

const STAFF = ["partner", "manager", "employee"] as const;
const MANAGERS = ["partner", "manager"] as const;

interface RequestRecord {
  id: string;
  client_id: string;
  title: string;
  status: RequestStatus;
  due_date: string | null;
  notes: string | null;
  contact_id: string | null;
  reminder_count: number;
  reminder_every_days: number;
  updated_at: string;
  created_by: string;
}

interface ItemRecord {
  id: string;
  request_id: string;
  title: string;
  help_text: string | null;
  is_required: boolean;
  status: RequestItemStatus;
  rejection_reason: string | null;
  sort_order: number;
  updated_at: string;
}

const REQUEST_COLUMNS = "id, client_id, title, status, due_date, notes, contact_id, reminder_count, reminder_every_days, updated_at, created_by";
const ITEM_COLUMNS = "id, request_id, title, help_text, is_required, status, rejection_reason, sort_order, updated_at";

function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

function changedAt(at: string): string {
  const when = formatDate(at) === formatDate(new Date()) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`;
  return `Changed by someone else at ${when}. Reload to see their changes.`;
}

async function loadRequest(ctx: ActionContext, id: string, clientId: string): Promise<RequestRecord> {
  const { data, error } = await ctx.supabase.from("document_requests").select(REQUEST_COLUMNS).eq("id", id).maybeSingle();
  throwIfDbError(error);
  const r = data as RequestRecord | null;
  if (!r || r.client_id !== clientId) throw new ActionError("That request no longer exists. Reload to see the client's requests.", { code: "not_found" });
  return r;
}

async function loadItems(ctx: ActionContext, requestId: string): Promise<ItemRecord[]> {
  const { data, error } = await ctx.supabase.from("document_request_items").select(ITEM_COLUMNS).eq("request_id", requestId).order("sort_order").order("created_at");
  throwIfDbError(error);
  return (data ?? []) as ItemRecord[];
}

async function clientInfo(ctx: ActionContext, clientId: string): Promise<{ display_name: string; portal_user_id: string | null }> {
  const { data, error } = await ctx.supabase.from("clients").select("display_name, portal_user_id, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
  return { display_name: data.display_name, portal_user_id: data.portal_user_id };
}

function portalLink(requestId: string): string {
  return `${env.appUrl().replace(/\/+$/, "")}${requestPortalPath(requestId)}`;
}

/** Contact made: the cadence restarts from now (§7.14 "Reminder every N days"). */
async function markContacted(ctx: ActionContext, req: RequestRecord, countAsReminder: boolean): Promise<void> {
  const { error } = await ctx.supabase
    .from("document_requests")
    .update({ last_reminded_at: new Date().toISOString(), ...(countAsReminder ? { reminder_count: req.reminder_count + 1 } : {}) })
    .eq("id", req.id);
  throwIfDbError(error);
}

// -------------------------------------------------------------------------------------------------
// Create and edit
// -------------------------------------------------------------------------------------------------

export const createDocumentRequest = defineAction(
  { name: "document_requests.create", schema: CreateDocumentRequestSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; portalLink: string }>> => {
    const client = await clientInfo(ctx, input.clientId);
    const { data, error } = await ctx.supabase.rpc("create_document_request", {
      p_client_id: input.clientId,
      p_title: input.title,
      p_due_date: input.dueDate,
      p_notes: input.notes,
      p_reminder_every_days: input.reminderEveryDays,
      p_contact_id: input.contactId,
      p_items: input.items.map((i) => ({ title: i.title, help_text: i.helpText, is_required: i.isRequired })),
    });
    if (error?.code === "42501") throw new ActionError("You can't request documents for this client. It isn't one of yours.", { code: "forbidden" });
    throwIfDbError(error);
    const id = String(data);

    await ctx.audit({
      event: "data_create",
      resourceType: "document_request",
      resourceId: id,
      details: { client_id: input.clientId, title: input.title, items: input.items.length, due_date: input.dueDate, contact_id: input.contactId, reminder_every_days: input.reminderEveryDays },
    });

    const due = input.dueDate ? `, due ${formatDate(input.dueDate)}` : "";
    ctx.after("Add the request to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "document_requested",
        title: `Documents requested: ${input.title} (${input.items.length} ${input.items.length === 1 ? "item" : "items"}${due})`,
        metadata: { request_id: id, items: input.items.length },
      }),
    );
    if (client.portal_user_id) {
      const portalUser = client.portal_user_id;
      ctx.after("Show the request in the client's portal notifications", () =>
        notify({
          to: { userIds: [portalUser] },
          type: "info",
          title: `Documents requested: ${input.title}`,
          body: `${input.items.length} ${input.items.length === 1 ? "item" : "items"} to upload${due}.`,
          linkUrl: requestPortalPath(id),
          entity: { type: "document_request", id },
          clientId: input.clientId,
        }),
      );
    }
    return ok({ id, portalLink: portalLink(id) });
  },
);

export const updateDocumentRequest = defineAction(
  { name: "document_requests.update", schema: UpdateDocumentRequestSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const req = await loadRequest(ctx, input.id, input.clientId);
    if (!sameInstant(req.updated_at, input.updatedAt)) return fail(changedAt(req.updated_at), { code: "conflict" });
    if (input.contactId) {
      const { data: c, error: cError } = await ctx.supabase.from("client_contacts").select("client_id").eq("id", input.contactId).maybeSingle();
      throwIfDbError(cError);
      if (!c || c.client_id !== input.clientId) return fail("Choose one of this client's contacts.", { code: "validation", fieldErrors: { contactId: ["Choose one of this client's contacts."] } });
    }
    const { data, error } = await ctx.supabase
      .from("document_requests")
      .update({ title: input.title, due_date: input.dueDate, notes: input.notes, reminder_every_days: input.reminderEveryDays, contact_id: input.contactId })
      .eq("id", req.id)
      .eq("updated_at", req.updated_at)
      .select("id, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!saved) return fail(changedAt(new Date().toISOString()), { code: "conflict" });
    const changed: string[] = [];
    if (req.title !== input.title) changed.push("title");
    if ((req.due_date ?? null) !== input.dueDate) changed.push("due date");
    if ((req.notes ?? null) !== input.notes) changed.push("notes");
    if (req.reminder_every_days !== input.reminderEveryDays) changed.push("reminder cadence");
    if ((req.contact_id ?? null) !== input.contactId) changed.push("contact");
    await ctx.audit({ event: "data_update", resourceType: "document_request", resourceId: req.id, details: { client_id: req.client_id, changed } });
    return ok({ id: saved.id, updatedAt: saved.updated_at });
  },
);

export const addRequestItem = defineAction(
  { name: "document_requests.add_item", schema: AddRequestItemSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const req = await loadRequest(ctx, input.requestId, input.clientId);
    const items = await loadItems(ctx, req.id);
    if (items.length >= 50) return fail("A request can have at most 50 items. Start a new request.", { code: "blocked" });
    const sortOrder = items.reduce((m, i) => Math.max(m, i.sort_order), -1) + 1;
    const { data, error } = await ctx.supabase
      .from("document_request_items")
      .insert({ request_id: req.id, title: input.title, help_text: input.helpText, is_required: input.isRequired, sort_order: sortOrder })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = (data as { id: string }).id;
    await ctx.audit({ event: "data_create", resourceType: "document_request_item", resourceId: id, details: { client_id: req.client_id, request_id: req.id, title: input.title, required: input.isRequired } });
    return ok({ id });
  },
);

export const updateRequestItem = defineAction(
  { name: "document_requests.update_item", schema: UpdateRequestItemSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    await loadRequest(ctx, input.requestId, input.clientId);
    const { data: before, error: readError } = await ctx.supabase.from("document_request_items").select(ITEM_COLUMNS).eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    const item = before as ItemRecord | null;
    if (!item || item.request_id !== input.requestId) return fail("That item no longer exists. Reload to see the request.", { code: "not_found" });
    if (!sameInstant(item.updated_at, input.updatedAt)) return fail(changedAt(item.updated_at), { code: "conflict" });
    const { data, error } = await ctx.supabase
      .from("document_request_items")
      .update({ title: input.title, help_text: input.helpText, is_required: input.isRequired })
      .eq("id", item.id)
      .eq("updated_at", item.updated_at)
      .select("id, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!saved) return fail(changedAt(new Date().toISOString()), { code: "conflict" });
    await ctx.audit({
      event: "data_update",
      resourceType: "document_request_item",
      resourceId: item.id,
      details: { client_id: input.clientId, request_id: input.requestId, title: input.title, required: input.isRequired },
    });
    return ok({ id: saved.id, updatedAt: saved.updated_at });
  },
);

export const removeRequestItem = defineAction(
  { name: "document_requests.remove_item", schema: RemoveRequestItemSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const req = await loadRequest(ctx, input.requestId, input.clientId);
    const items = await loadItems(ctx, req.id);
    const item = items.find((i) => i.id === input.id);
    if (!item) return fail("That item has already been removed. Reload to see the request.", { code: "not_found" });
    if (items.length === 1) return fail("A request needs at least one item. Cancel the request instead.", { code: "blocked" });
    const { error } = await ctx.supabase.from("document_request_items").delete().eq("id", item.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "document_request_item", resourceId: item.id, details: { client_id: req.client_id, request_id: req.id, title: item.title, status: item.status } });
    return ok({ id: item.id });
  },
);

// -------------------------------------------------------------------------------------------------
// Accept / reject (§7.14)
// -------------------------------------------------------------------------------------------------

export const reviewRequestItem = defineAction(
  { name: "document_requests.review_item", schema: ReviewRequestItemSchema, roles: STAFF },
  async (
    input,
    ctx,
  ): Promise<ActionResult<{ itemStatus: RequestItemStatus; requestStatus: RequestStatus; updatedAt: string; portalLink: string }>> => {
    const req = await loadRequest(ctx, input.requestId, input.clientId);
    const { data, error } = await ctx.supabase.rpc("review_document_request_item", {
      p_item_id: input.id,
      p_decision: input.decision,
      p_reason: input.reason ?? undefined,
      p_document_id: input.documentId ?? undefined,
      p_expected_updated_at: input.updatedAt,
    });
    if (error?.message?.includes("changed by someone else")) return fail("This item was changed by someone else just now. Reload to see the latest.", { code: "conflict" });
    throwIfDbError(error);
    const r = (data ?? {}) as { item_status: RequestItemStatus; request_status: RequestStatus; item_title: string; updated_at: string; document_id: string | null };

    await ctx.audit({
      event: "data_update",
      resourceType: "document_request_item",
      resourceId: input.id,
      action: input.decision === "accept" ? "document_requests.accept_item" : "document_requests.reject_item",
      details: { client_id: req.client_id, request_id: req.id, decision: input.decision, reason: input.reason, document_id: r.document_id, request_status: r.request_status },
    });

    const completedNow = r.request_status === "completed" && req.status !== "completed";
    ctx.after("Add the decision to the client's timeline", async () => {
      await addTimelineEvent({
        clientId: req.client_id,
        eventType: input.decision === "accept" ? "document_request_item_accepted" : "document_request_item_rejected",
        title: input.decision === "accept" ? `Accepted: ${r.item_title} (${req.title})` : `Sent back: ${r.item_title} (${req.title})`,
        description: input.decision === "reject" ? input.reason : null,
        metadata: { request_id: req.id, item_id: input.id, document_id: r.document_id },
      });
      if (completedNow) {
        await addTimelineEvent({ clientId: req.client_id, eventType: "document_request_completed", title: `Document request completed: ${req.title}`, metadata: { request_id: req.id } });
      }
    });

    if (input.decision === "reject") {
      const client = await clientInfo(ctx, req.client_id);
      if (client.portal_user_id) {
        const portalUser = client.portal_user_id;
        ctx.after("Tell the client in the portal", () =>
          notify({
            to: { userIds: [portalUser] },
            type: "info",
            title: `Please upload again: ${r.item_title}`,
            body: `${input.reason ?? ""} (${req.title})`.trim(),
            linkUrl: requestPortalPath(req.id),
            entity: { type: "document_request", id: req.id },
            clientId: req.client_id,
          }),
        );
      }
    }
    return ok({ itemStatus: r.item_status, requestStatus: r.request_status, updatedAt: r.updated_at, portalLink: portalLink(req.id) });
  },
);

// -------------------------------------------------------------------------------------------------
// Cancel, reopen, remind
// -------------------------------------------------------------------------------------------------

export const cancelDocumentRequest = defineAction(
  { name: "document_requests.cancel", schema: CancelDocumentRequestSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const req = await loadRequest(ctx, input.id, input.clientId);
    if (req.status === "cancelled") return ok({ id: req.id });
    if (!sameInstant(req.updated_at, input.updatedAt)) return fail(changedAt(req.updated_at), { code: "conflict" });
    const { data, error } = await ctx.supabase
      .from("document_requests")
      .update({ status: "cancelled", cancel_reason: input.reason })
      .eq("id", req.id)
      .eq("updated_at", req.updated_at)
      .select("id");
    throwIfDbError(error);
    if (!(data ?? []).length) return fail(changedAt(new Date().toISOString()), { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "document_request", resourceId: req.id, action: "document_requests.cancel", details: { client_id: req.client_id, reason: input.reason, previous_status: req.status } });
    ctx.after("Add the cancellation to the client's timeline", () =>
      addTimelineEvent({ clientId: req.client_id, eventType: "document_request_cancelled", title: `Document request cancelled: ${req.title}`, description: input.reason, metadata: { request_id: req.id } }),
    );
    return ok({ id: req.id });
  },
);

export const reopenDocumentRequest = defineAction(
  { name: "document_requests.reopen", schema: ReopenDocumentRequestSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; status: RequestStatus }>> => {
    const req = await loadRequest(ctx, input.id, input.clientId);
    if (req.status !== "cancelled") return fail("Only a cancelled request can be reopened.", { code: "blocked" });
    if (!sameInstant(req.updated_at, input.updatedAt)) return fail(changedAt(req.updated_at), { code: "conflict" });
    const { data, error } = await ctx.supabase.from("document_requests").update({ status: "open" }).eq("id", req.id).eq("updated_at", req.updated_at).select("id, status");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; status: RequestStatus } | undefined;
    if (!saved) return fail(changedAt(new Date().toISOString()), { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "document_request", resourceId: req.id, action: "document_requests.reopen", details: { client_id: req.client_id, status: saved.status } });
    ctx.after("Add the reopening to the client's timeline", () =>
      addTimelineEvent({ clientId: req.client_id, eventType: "document_request_reopened", title: `Document request reopened: ${req.title}`, metadata: { request_id: req.id } }),
    );
    return ok({ id: saved.id, status: saved.status });
  },
);

export const recordRequestHandoff = defineAction(
  { name: "document_requests.handoff", schema: RecordRequestHandoffSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const req = await loadRequest(ctx, input.id, input.clientId);
    if (req.status === "open") await markContacted(ctx, req, true);
    await ctx.audit({ event: "data_update", resourceType: "document_request", resourceId: req.id, action: "document_requests.handoff", details: { client_id: req.client_id, reminder: req.reminder_count + 1 } });
    return ok({ id: req.id });
  },
);

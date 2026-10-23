"use server";

/**
 * The client's document checklist (§7.3.2 step 4, §7.14 "Checklist (from onboarding): items can be
 * ticked collected, linked to a document, added or removed").
 *
 *   setChecklistCollected   anyone who can see the client (Employees may change only this and the
 *                           link, 0033); who and when are stamped by the database (0123).
 *   linkChecklistDocument   link one of the client's vault documents (or unlink); linking ticks the
 *                           item collected.
 *   addChecklistItem        Partner/Manager.
 *   removeChecklistItem     Partner/Manager.
 *
 * Edits carry the row's updated_at (§13). Each writes an audit row and a timeline entry.
 */

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { formatDate, formatTime } from "@/lib/format";
import { AddChecklistItemSchema, LinkChecklistDocumentSchema, RemoveChecklistItemSchema, SetChecklistCollectedSchema } from "@/lib/schemas/documents";
import { addTimelineEvent } from "@/server/timeline";

const STAFF = ["partner", "manager", "employee"] as const;
const MANAGERS = ["partner", "manager"] as const;

interface ItemRow {
  id: string;
  client_id: string;
  label: string;
  collected: boolean;
  document_id: string | null;
  sort_order: number;
  updated_at: string;
}

const COLUMNS = "id, client_id, label, collected, document_id, sort_order, updated_at";

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

async function loadItem(ctx: ActionContext, id: string, clientId: string): Promise<ItemRow | null> {
  const { data, error } = await ctx.supabase.from("client_document_checklist_items").select(COLUMNS).eq("id", id).maybeSingle();
  throwIfDbError(error);
  const row = data as ItemRow | null;
  return row && row.client_id === clientId ? row : null;
}

const GONE = "That checklist item no longer exists. Reload to see the checklist.";

export const setChecklistCollected = defineAction(
  { name: "checklist.set_collected", schema: SetChecklistCollectedSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; collected: boolean; updatedAt: string }>> => {
    const item = await loadItem(ctx, input.id, input.clientId);
    if (!item) return fail(GONE, { code: "not_found" });
    if (!sameInstant(item.updated_at, input.updatedAt)) return fail(changedAt(item.updated_at), { code: "conflict" });
    if (item.collected === input.collected) return ok({ id: item.id, collected: item.collected, updatedAt: item.updated_at });
    const { data, error } = await ctx.supabase
      .from("client_document_checklist_items")
      .update({ collected: input.collected })
      .eq("id", item.id)
      .eq("updated_at", item.updated_at)
      .select("id, collected, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; collected: boolean; updated_at: string } | undefined;
    if (!saved) return fail(changedAt(new Date().toISOString()), { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "client_checklist_item", resourceId: item.id, details: { client_id: item.client_id, label: item.label, collected: input.collected } });
    ctx.after("Add the checklist change to the client's timeline", () =>
      addTimelineEvent({
        clientId: item.client_id,
        eventType: input.collected ? "checklist_item_collected" : "checklist_item_reopened",
        title: input.collected ? `Collected: ${item.label}` : `Marked not collected: ${item.label}`,
        metadata: { checklist_item_id: item.id },
      }),
    );
    return ok({ id: saved.id, collected: saved.collected, updatedAt: saved.updated_at });
  },
);

export const linkChecklistDocument = defineAction(
  { name: "checklist.link_document", schema: LinkChecklistDocumentSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const item = await loadItem(ctx, input.id, input.clientId);
    if (!item) return fail(GONE, { code: "not_found" });
    if (!sameInstant(item.updated_at, input.updatedAt)) return fail(changedAt(item.updated_at), { code: "conflict" });
    let title: string | null = null;
    if (input.documentId) {
      const { data: doc, error: docError } = await ctx.supabase.from("documents").select("id, client_id, title, deleted_at").eq("id", input.documentId).maybeSingle();
      throwIfDbError(docError);
      if (!doc || doc.client_id !== input.clientId || doc.deleted_at) {
        return fail("Choose one of this client's documents in the vault.", { code: "validation", fieldErrors: { documentId: ["Choose one of this client's documents."] } });
      }
      title = doc.title;
    }
    const patch = input.documentId ? { document_id: input.documentId, collected: true } : { document_id: null };
    const { data, error } = await ctx.supabase.from("client_document_checklist_items").update(patch).eq("id", item.id).eq("updated_at", item.updated_at).select("id, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!saved) return fail(changedAt(new Date().toISOString()), { code: "conflict" });
    await ctx.audit({
      event: "data_update",
      resourceType: "client_checklist_item",
      resourceId: item.id,
      details: { client_id: item.client_id, label: item.label, document_id: input.documentId, previous_document_id: item.document_id },
    });
    if (input.documentId) {
      ctx.after("Add the checklist change to the client's timeline", () =>
        addTimelineEvent({
          clientId: item.client_id,
          eventType: "checklist_item_collected",
          title: `Collected: ${item.label} (${title ?? "document"} in the vault)`,
          metadata: { checklist_item_id: item.id, document_id: input.documentId },
        }),
      );
    }
    return ok({ id: saved.id, updatedAt: saved.updated_at });
  },
);

export const addChecklistItem = defineAction(
  { name: "checklist.add_item", schema: AddChecklistItemSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: client, error: clientError } = await ctx.supabase.from("clients").select("id, deleted_at").eq("id", input.clientId).maybeSingle();
    throwIfDbError(clientError);
    if (!client || client.deleted_at) return fail("That client isn't in the client list any more.", { code: "not_found" });
    const { data: last, error: lastError } = await ctx.supabase
      .from("client_document_checklist_items")
      .select("sort_order, label")
      .eq("client_id", input.clientId)
      .order("sort_order", { ascending: false })
      .limit(500);
    throwIfDbError(lastError);
    const existing = last ?? [];
    if (existing.some((i) => i.label.trim().toLowerCase() === input.label.toLowerCase())) {
      return fail("That item is already on the checklist.", { code: "validation", fieldErrors: { label: ["That item is already on the checklist."] } });
    }
    const sortOrder = (existing[0]?.sort_order ?? -1) + 1;
    const { data, error } = await ctx.supabase
      .from("client_document_checklist_items")
      .insert({ client_id: input.clientId, label: input.label, is_required: input.isRequired, sort_order: sortOrder })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = (data as { id: string }).id;
    await ctx.audit({ event: "data_create", resourceType: "client_checklist_item", resourceId: id, details: { client_id: input.clientId, label: input.label, required: input.isRequired } });
    ctx.after("Add the checklist change to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "checklist_item_added", title: `Added to the document checklist: ${input.label}`, metadata: { checklist_item_id: id } }),
    );
    return ok({ id });
  },
);

export const removeChecklistItem = defineAction(
  { name: "checklist.remove_item", schema: RemoveChecklistItemSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const item = await loadItem(ctx, input.id, input.clientId);
    if (!item) return fail(GONE, { code: "not_found" });
    const { error } = await ctx.supabase.from("client_document_checklist_items").delete().eq("id", item.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "client_checklist_item", resourceId: item.id, details: { client_id: item.client_id, label: item.label, collected: item.collected } });
    ctx.after("Add the checklist change to the client's timeline", () =>
      addTimelineEvent({ clientId: item.client_id, eventType: "checklist_item_removed", title: `Removed from the document checklist: ${item.label}`, metadata: { checklist_item_id: item.id } }),
    );
    return ok({ id: item.id });
  },
);

"use server";

import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { CreateClientGroupSchema, DeleteClientGroupSchema, GroupMembersSchema, UpdateClientGroupSchema } from "@/lib/schemas/client-groups";
import { searchClientsForGroup } from "@/lib/data/client-groups";
import { addTimelineEvent } from "@/server/timeline";
import { formatTime } from "@/lib/format";

/**
 * Client groups (§7.4): create, rename and annotate, delete, add and remove members. A client is
 * in one group at a time (clients.group_id); deleting a group leaves its clients ungrouped.
 * Partner/Manager (RLS: client_groups and clients updates are theirs, 0033).
 */

const PM = ["partner", "manager"] as const;
const DUPLICATE_NAME = "There's already a group with this name.";

export const createClientGroup = defineAction(
  { name: "client_groups.create", schema: CreateClientGroupSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; name: string }>> => {
    const { data, error } = await ctx.supabase.from("client_groups").insert({ name: input.name, notes: input.notes || null }).select("id, name").single();
    throwIfDbError(error, { uniqueField: "name", uniqueMessage: DUPLICATE_NAME });
    const group = { id: data!.id, name: String(data!.name) };
    if (input.clientIds.length) {
      const { error: mErr } = await ctx.supabase.from("clients").update({ group_id: group.id }).in("id", input.clientIds).is("deleted_at", null);
      throwIfDbError(mErr);
    }
    await ctx.audit({ event: "data_create", resourceType: "client_group", resourceId: group.id, details: { name: group.name, members: input.clientIds } });
    if (input.clientIds.length) {
      ctx.after("Add to the clients' timelines", async () => {
        for (const id of input.clientIds) await addTimelineEvent({ clientId: id, eventType: "client_group_changed", title: `Added to the group ${group.name}` });
      });
    }
    return ok(group);
  },
);

async function loadGroup(ctx: { supabase: Parameters<typeof searchClientsForGroup>[0] }, id: string) {
  const { data, error } = await ctx.supabase.from("client_groups").select("id, name, notes, updated_at").eq("id", id).maybeSingle();
  throwIfDbError(error);
  return data;
}

export const updateClientGroup = defineAction(
  { name: "client_groups.update", schema: UpdateClientGroupSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const before = await loadGroup(ctx, input.id);
    if (!before) return fail("That group no longer exists.", { code: "not_found" });
    const { data, error } = await ctx.supabase
      .from("client_groups")
      .update({ name: input.name, notes: input.notes || null })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("updated_at")
      .maybeSingle();
    throwIfDbError(error, { uniqueField: "name", uniqueMessage: DUPLICATE_NAME });
    if (!data) {
      return fail(`Changed by someone else at ${formatTime(before.updated_at)}. Reload to see their changes.`, { code: "conflict" });
    }
    await ctx.audit({
      event: "data_update",
      resourceType: "client_group",
      resourceId: input.id,
      details: { before: { name: before.name, notes: before.notes }, after: { name: input.name, notes: input.notes || null } },
    });
    return ok({ updated_at: data.updated_at });
  },
);

export const deleteClientGroup = defineAction(
  { name: "client_groups.delete", schema: DeleteClientGroupSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ name: string; members: number }>> => {
    const before = await loadGroup(ctx, input.id);
    if (!before) return fail("That group no longer exists.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) {
      return fail(`Changed by someone else at ${formatTime(before.updated_at)}. Reload to see their changes.`, { code: "conflict" });
    }
    const { data: members, error: mErr } = await ctx.supabase.from("clients").select("id").eq("group_id", input.id);
    throwIfDbError(mErr);
    const { error } = await ctx.supabase.from("client_groups").delete().eq("id", input.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "client_group", resourceId: input.id, details: { name: before.name, members: (members ?? []).map((m) => m.id) } });
    ctx.after("Add to the clients' timelines", async () => {
      for (const m of members ?? []) await addTimelineEvent({ clientId: m.id, eventType: "client_group_changed", title: `The group ${before.name} was deleted` });
    });
    return ok({ name: String(before.name), members: (members ?? []).length });
  },
);

export const addGroupMembers = defineAction(
  { name: "client_groups.add_members", schema: GroupMembersSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ added: number }>> => {
    const group = await loadGroup(ctx, input.groupId);
    if (!group) return fail("That group no longer exists.", { code: "not_found" });
    const { data: before, error: bErr } = await ctx.supabase.from("clients").select("id, group_id").in("id", input.clientIds).is("deleted_at", null);
    throwIfDbError(bErr);
    const moving = (before ?? []).filter((c) => c.group_id !== input.groupId);
    if (moving.length) {
      const { error } = await ctx.supabase.from("clients").update({ group_id: input.groupId }).in("id", moving.map((c) => c.id));
      throwIfDbError(error);
    }
    await ctx.audit({
      event: "data_update",
      resourceType: "client_group",
      resourceId: input.groupId,
      action: "client_groups.add_members",
      details: { changes: moving.map((c) => ({ client_id: c.id, before: c.group_id, after: input.groupId })) },
    });
    ctx.after("Add to the clients' timelines", async () => {
      for (const c of moving) await addTimelineEvent({ clientId: c.id, eventType: "client_group_changed", title: `Added to the group ${group.name}` });
    });
    return ok({ added: moving.length });
  },
);

export const removeGroupMember = defineAction(
  { name: "client_groups.remove_member", schema: z.object({ groupId: z.uuid(), clientId: z.uuid() }), roles: PM },
  async (input, ctx): Promise<ActionResult<{ removed: boolean }>> => {
    const group = await loadGroup(ctx, input.groupId);
    if (!group) return fail("That group no longer exists.", { code: "not_found" });
    const { data, error } = await ctx.supabase.from("clients").update({ group_id: null }).eq("id", input.clientId).eq("group_id", input.groupId).select("id");
    throwIfDbError(error);
    const removed = (data ?? []).length > 0;
    if (removed) {
      await ctx.audit({ event: "data_update", resourceType: "client_group", resourceId: input.groupId, action: "client_groups.remove_member", details: { client_id: input.clientId } });
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({ clientId: input.clientId, eventType: "client_group_changed", title: `Removed from the group ${group.name}` }),
      );
    }
    return ok({ removed });
  },
);

/** Clients to add (the Add members search): name, code, PAN or GSTIN, not already in this group. */
export const searchGroupCandidates = defineAction(
  { name: "client_groups.search", schema: z.object({ q: z.string().trim().max(100).default(""), groupId: z.uuid().nullish() }), roles: PM },
  async (input, ctx): Promise<ActionResult<Array<{ value: string; label: string; description?: string }>>> => {
    const rows = await searchClientsForGroup(ctx.supabase, input.q, input.groupId ?? null);
    return ok(rows.map((r) => ({ value: r.id, label: r.display_name, description: r.group_name ? `${r.client_code} · in ${r.group_name}` : r.client_code })));
  },
);

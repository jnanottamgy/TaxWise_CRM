"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import {
  AddChecklistItemSchema,
  ApplyTemplateSchema,
  DeleteChecklistItemSchema,
  RenameChecklistItemSchema,
  ReorderChecklistSchema,
  ToggleChecklistItemSchema,
} from "@/lib/schemas/tasks";
import { logActivity } from "@/server/activity";

/**
 * A task's checklist (§7.6.2, §7.6.6): Partners and Managers add, rename, reorder and remove
 * items and apply job templates (their steps get dates from the template offsets); the assignee
 * ticks items done (RLS and the column limit in 0035 allow them `done` only).
 */

const PM = ["partner", "manager"] as const;

export const addChecklistItem = defineAction(
  { name: "tasks.checklist.add", schema: AddChecklistItemSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: last } = await ctx.supabase.from("task_checklist_items").select("sort_order").eq("task_id", input.task_id).order("sort_order", { ascending: false }).limit(1);
    const { data, error } = await ctx.supabase
      .from("task_checklist_items")
      .insert({ task_id: input.task_id, title: input.title, due_offset_days: input.due_offset_days, sort_order: (last?.[0]?.sort_order ?? -1) + 1 })
      .select("id")
      .single();
    throwIfDbError(error);
    await ctx.audit({ event: "data_create", resourceType: "task_checklist_item", resourceId: data!.id, details: { task_id: input.task_id, title: input.title } });
    ctx.after("Record it on the task", () => logActivity({ entityType: "task", entityId: input.task_id, action: "checklist_item_added", description: `Checklist: added “${input.title}”.` }));
    return ok({ id: data!.id });
  },
);

export const toggleChecklistItem = defineAction(
  { name: "tasks.checklist.toggle", schema: ToggleChecklistItemSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string; done: boolean }>> => {
    const { data, error } = await ctx.supabase
      .from("task_checklist_items")
      .update({ done: input.done, done_by: input.done ? ctx.user.id : null, done_at: input.done ? new Date().toISOString() : null })
      .eq("id", input.id)
      .select("id, task_id, title");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("Only the assignee, a Manager or a Partner can tick this checklist.", { code: "forbidden" });
    await ctx.audit({ event: "data_update", resourceType: "task_checklist_item", resourceId: input.id, details: { done: input.done, task_id: data[0].task_id } });
    ctx.after("Record it on the task", () =>
      logActivity({ entityType: "task", entityId: data[0].task_id, action: input.done ? "checklist_item_done" : "checklist_item_reopened", description: `Checklist: “${data[0].title}” ${input.done ? "done" : "not done"}.` }),
    );
    return ok({ id: input.id, done: input.done });
  },
);

export const renameChecklistItem = defineAction(
  { name: "tasks.checklist.rename", schema: RenameChecklistItemSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("task_checklist_items").update({ title: input.title }).eq("id", input.id).select("id, task_id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That checklist item no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_update", resourceType: "task_checklist_item", resourceId: input.id, details: { title: input.title, task_id: data[0].task_id } });
    return ok({ id: input.id });
  },
);

export const deleteChecklistItem = defineAction(
  { name: "tasks.checklist.delete", schema: DeleteChecklistItemSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("task_checklist_items").delete().eq("id", input.id).select("id, task_id, title");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That checklist item no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "task_checklist_item", resourceId: input.id, details: { title: data[0].title, task_id: data[0].task_id } });
    ctx.after("Record it on the task", () => logActivity({ entityType: "task", entityId: data[0].task_id, action: "checklist_item_removed", description: `Checklist: removed “${data[0].title}”.` }));
    return ok({ id: input.id });
  },
);

export const reorderChecklist = defineAction(
  { name: "tasks.checklist.reorder", schema: ReorderChecklistSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ count: number }>> => {
    const { data: items, error: loadError } = await ctx.supabase.from("task_checklist_items").select("id").eq("task_id", input.task_id);
    throwIfDbError(loadError);
    const known = new Set((items ?? []).map((i) => i.id));
    if (input.ids.some((id) => !known.has(id))) return fail("The checklist changed. Reload to see the latest.", { code: "conflict" });
    for (const [i, id] of input.ids.entries()) {
      const { error } = await ctx.supabase.from("task_checklist_items").update({ sort_order: i }).eq("id", id).eq("task_id", input.task_id);
      throwIfDbError(error);
    }
    await ctx.audit({ event: "data_update", resourceType: "task", resourceId: input.task_id, action: "tasks.checklist.reorder", details: { count: input.ids.length } });
    return ok({ count: input.ids.length });
  },
);

export const applyJobTemplate = defineAction(
  { name: "tasks.checklist.apply_template", schema: ApplyTemplateSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ added: number; skipped: number; template_name: string }>> => {
    const { data, error } = await ctx.supabase.rpc("apply_job_template", { p_task_id: input.task_id, p_template_id: input.template_id });
    throwIfDbError(error);
    const r = data as { added: number; skipped: number; template_name: string };
    await ctx.audit({ event: "data_update", resourceType: "task", resourceId: input.task_id, action: "tasks.checklist.apply_template", details: { template_id: input.template_id, added: r.added, skipped: r.skipped } });
    return ok(r);
  },
);

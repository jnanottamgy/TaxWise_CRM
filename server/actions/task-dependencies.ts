"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { AddDependencySchema, RemoveDependencySchema } from "@/lib/schemas/tasks";
import { logActivity } from "@/server/activity";

/**
 * Blocked by / blocking (§7.6.2, §7.6.6). Partners and Managers set them (RLS, 0035); the database
 * refuses self-dependency and cycles with a plain sentence (task_dependencies_guard, 0017). A task
 * can't move to In progress, Under review or Filed/Done while a blocker is open (§7.6.4).
 */

const PM = ["partner", "manager"] as const;

export const addTaskDependency = defineAction(
  { name: "tasks.dependency.add", schema: AddDependencySchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    if (input.task_id === input.blocker_task_id) return fail("A task can't be blocked by itself.", { code: "validation", fieldErrors: { blocker_task_id: ["Choose another task."] } });
    const { data: blocker, error: bErr } = await ctx.supabase.from("tasks_list").select("id, task_number, title, deleted_at").eq("id", input.blocker_task_id).maybeSingle();
    throwIfDbError(bErr);
    if (!blocker || blocker.deleted_at) return fail("That task no longer exists.", { code: "not_found", fieldErrors: { blocker_task_id: ["Choose another task."] } });
    const { data, error } = await ctx.supabase.from("task_dependencies").insert({ task_id: input.task_id, blocker_task_id: input.blocker_task_id }).select("id").single();
    throwIfDbError(error, { uniqueField: "blocker_task_id", uniqueMessage: "This task is already blocked by that one." });
    await ctx.audit({ event: "data_create", resourceType: "task_dependency", resourceId: data!.id, details: { task_id: input.task_id, blocker_task_id: input.blocker_task_id } });
    ctx.after("Record it on the task", () =>
      logActivity({ entityType: "task", entityId: input.task_id, action: "dependency_added", description: `Blocked by ${blocker.task_number} · ${blocker.title}.` }),
    );
    return ok({ id: data!.id });
  },
);

export const removeTaskDependency = defineAction(
  { name: "tasks.dependency.remove", schema: RemoveDependencySchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("task_dependencies").delete().eq("id", input.id).select("id, task_id, blocker_task_id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That link no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "task_dependency", resourceId: input.id, details: { task_id: data[0].task_id, blocker_task_id: data[0].blocker_task_id } });
    ctx.after("Record it on the task", () => logActivity({ entityType: "task", entityId: data[0].task_id, action: "dependency_removed", description: "A blocking task was removed." }));
    return ok({ id: input.id });
  },
);

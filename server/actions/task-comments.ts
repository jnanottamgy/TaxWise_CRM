"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES, isManagerOrPartner } from "@/lib/auth/roles";
import { AddCommentSchema, DeleteCommentSchema, EditCommentSchema, taskRef } from "@/lib/schemas/tasks";
import { notify } from "@/server/notify";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Task comments (§7.6.6): anyone who can see the task comments as themselves (RLS, 0035); authors
 * edit their own; authors and Partners/Managers remove (soft). An `@mention` notifies the person
 * (§9 "`@mention` in a comment"), once per comment, never the author.
 */

const EXCERPT = 160;

function excerpt(body: string): string {
  const one = body.replace(/\s+/g, " ").trim();
  return one.length > EXCERPT ? `${one.slice(0, EXCERPT - 1)}…` : one;
}

async function taskFor(supabase: ServerSupabase, taskId: string) {
  const { data, error } = await supabase.from("tasks_list").select("id, task_number, title, client_id").eq("id", taskId).maybeSingle();
  throwIfDbError(error);
  return data;
}

/** Only staff with a login can be mentioned; the ids are profile ids. */
async function validMentions(supabase: ServerSupabase, ids: readonly string[], author: string): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => id !== author);
  if (!unique.length) return [];
  const { data, error } = await supabase.from("employee_directory").select("profile_id, is_active").in("profile_id", unique);
  throwIfDbError(error);
  return (data ?? []).filter((d) => d.is_active && d.profile_id).map((d) => d.profile_id as string);
}

function mentionNotice(
  task: { id: string | null; task_number: string | null; title: string | null; client_id: string | null },
  commentId: string,
  by: string,
  body: string,
  userIds: string[],
  dedupeKey = `task_mention:${commentId}`,
) {
  return notify({
    to: { userIds },
    type: "info",
    title: `${by} mentioned you`,
    body: `On ${taskRef({ task_number: task.task_number, title: task.title ?? "" })}: “${excerpt(body)}”`,
    linkUrl: `/work/${task.id}#comment-${commentId}`,
    entity: { type: "task", id: task.id ?? "" },
    clientId: task.client_id,
    dedupeKey,
  });
}

export const addTaskComment = defineAction(
  { name: "tasks.comment.add", schema: AddCommentSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const task = await taskFor(ctx.supabase, input.task_id);
    if (!task) return fail("That task doesn't exist, or it isn't one of yours.", { code: "not_found" });
    const mentions = await validMentions(ctx.supabase, input.mentions, ctx.user.id);
    const { data, error } = await ctx.supabase
      .from("task_comments")
      .insert({ task_id: input.task_id, author_id: ctx.user.id, body: input.body, mentions })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = data!.id;
    await ctx.audit({ event: "data_create", resourceType: "task_comment", resourceId: id, details: { task_id: input.task_id, mentions: mentions.length } });
    if (mentions.length) {
      ctx.after("Tell the people you mentioned", () => mentionNotice(task, id, ctx.user.fullName, input.body, mentions), "The people you mentioned weren't notified. Tell them by hand.");
    }
    return ok({ id });
  },
);

export const editTaskComment = defineAction(
  { name: "tasks.comment.edit", schema: EditCommentSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: before, error: loadError } = await ctx.supabase.from("task_comments").select("id, task_id, author_id, mentions, deleted_at").eq("id", input.id).maybeSingle();
    throwIfDbError(loadError);
    if (!before || before.deleted_at) return fail("That comment no longer exists.", { code: "not_found" });
    if (before.author_id !== ctx.user.id) return fail("You can edit only your own comments.", { code: "forbidden" });
    const mentions = await validMentions(ctx.supabase, input.mentions, ctx.user.id);
    const { error } = await ctx.supabase.from("task_comments").update({ body: input.body, mentions, edited_at: new Date().toISOString() }).eq("id", input.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_update", resourceType: "task_comment", resourceId: input.id, details: { task_id: before.task_id } });
    const added = mentions.filter((m) => !(before.mentions ?? []).includes(m));
    if (added.length) {
      const task = await taskFor(ctx.supabase, before.task_id);
      if (task) ctx.after("Tell the people you mentioned", () => mentionNotice(task, input.id, ctx.user.fullName, input.body, added, `task_mention:${input.id}:${Date.now()}`));
    }
    return ok({ id: input.id });
  },
);

export const deleteTaskComment = defineAction(
  { name: "tasks.comment.delete", schema: DeleteCommentSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: before, error: loadError } = await ctx.supabase.from("task_comments").select("id, task_id, author_id, deleted_at").eq("id", input.id).maybeSingle();
    throwIfDbError(loadError);
    if (!before || before.deleted_at) return fail("That comment no longer exists.", { code: "not_found" });
    if (before.author_id !== ctx.user.id && !isManagerOrPartner(ctx.user.role)) return fail("You can remove only your own comments.", { code: "forbidden" });
    const { error } = await ctx.supabase.from("task_comments").update({ deleted_at: new Date().toISOString() }).eq("id", input.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "task_comment", resourceId: input.id, details: { task_id: before.task_id, author_id: before.author_id } });
    return ok({ id: input.id });
  },
);

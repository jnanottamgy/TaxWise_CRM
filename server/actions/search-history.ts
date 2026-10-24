"use server";

import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { ok, type ActionResult } from "@/lib/result";
import { logEmployeeActivity } from "@/server/activity";
import { RememberSearchSchema, RemoveRecentSearchSchema } from "@/lib/schemas/search";

/**
 * Recent searches, per person (§7.18; recent_searches, RLS: each person's own rows only).
 *
 *   rememberSearch        keeps the query at the top of the list (the newest 10, no duplicates;
 *                         remember_search, 0210) and adds "search performed" to the person's own
 *                         activity (§5.2 employee_activities).
 *   removeRecentSearch    drops one query from the list.
 *   clearRecentSearches   empties the list.
 *
 * Like the shell's other per-person display settings (server/actions/preferences.ts), these are not
 * business records, so they write no audit rows; nothing here can reach another person's history.
 */

export const rememberSearch = defineAction(
  { name: "search.remember", schema: RememberSearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ query: string }>> => {
    const { error } = await ctx.supabase.rpc("remember_search", { p_query: input.query });
    throwIfDbError(error);
    ctx.after(
      "Record the search in your activity",
      () => logEmployeeActivity({ activityType: "search_performed", description: `Searched for “${input.query}”` }),
      "Your search wasn't added to your activity feed.",
    );
    return ok({ query: input.query });
  },
);

export const removeRecentSearch = defineAction(
  { name: "search.forget", schema: RemoveRecentSearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { error } = await ctx.supabase.from("recent_searches").delete().eq("id", input.id).eq("user_id", ctx.user.id);
    throwIfDbError(error);
    return ok({ id: input.id });
  },
);

export const clearRecentSearches = defineAction(
  { name: "search.clear_history", schema: z.object({}), roles: STAFF_ROLES },
  async (_input, ctx): Promise<ActionResult<{ cleared: number }>> => {
    const { data, error } = await ctx.supabase.from("recent_searches").delete().eq("user_id", ctx.user.id).select("id");
    throwIfDbError(error);
    return ok({ cleared: (data ?? []).length });
  },
);

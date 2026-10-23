"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ok, type ActionResult } from "@/lib/result";
import { EmptySchema, MarkNotificationsSchema, NotificationIdsSchema, OpenEntitySchema, notificationActionResult } from "@/lib/schemas/inbox";

/**
 * The Inbox's actions on notifications (§7.17): mark read / unread, archive / move back, delete,
 * "Mark all read", and "opened from Needs your action" (marks that record's notifications read).
 * Everyone works only on their own notifications: the functions run as the caller (0171) and RLS on
 * notifications (0039) refuses anything else, so these need no role list beyond being signed in.
 * Each change is audited with what it did and how many it touched.
 */

const sample = (ids: readonly string[]) => ids.slice(0, 20);

export const markNotifications = defineAction(
  { name: "inbox.mark", schema: MarkNotificationsSchema },
  async (input, ctx): Promise<ActionResult<{ count: number; message: string }>> => {
    const ids = Array.from(new Set(input.ids));
    const { data, error } = await ctx.supabase.rpc("mark_notifications", { p_ids: ids, p_action: input.action });
    throwIfDbError(error);
    const count = typeof data === "number" ? data : 0;
    if (count > 0) {
      await ctx.audit({ event: "data_update", resourceType: "notification", action: `inbox.mark_${input.action}`, details: { action: input.action, count, ids: sample(ids) } });
    }
    return ok({ count, message: notificationActionResult(input.action, count) });
  },
);

export const deleteNotifications = defineAction(
  { name: "inbox.delete", schema: NotificationIdsSchema },
  async (input, ctx): Promise<ActionResult<{ count: number }>> => {
    const ids = Array.from(new Set(input.ids));
    const { data, error } = await ctx.supabase.from("notifications").delete().in("id", ids).eq("user_id", ctx.user.id).select("id");
    throwIfDbError(error);
    const count = data?.length ?? 0;
    if (count > 0) {
      await ctx.audit({ event: "data_delete", resourceType: "notification", action: "inbox.delete", details: { count, ids: sample(ids) } });
    }
    return ok({ count });
  },
);

export const markAllNotificationsRead = defineAction(
  { name: "inbox.mark_all_read", schema: EmptySchema },
  async (_input, ctx): Promise<ActionResult<{ count: number }>> => {
    const { data, error } = await ctx.supabase.rpc("mark_all_notifications_read");
    throwIfDbError(error);
    const count = typeof data === "number" ? data : 0;
    if (count > 0) await ctx.audit({ event: "data_update", resourceType: "notification", action: "inbox.mark_all_read", details: { count } });
    return ok({ count });
  },
);

/** Opening an item from "Needs your action": its unread notifications are read now. */
export const openActionItem = defineAction(
  { name: "inbox.open_item", schema: OpenEntitySchema },
  async (input, ctx): Promise<ActionResult<{ count: number }>> => {
    const { data, error } = await ctx.supabase.rpc("mark_entity_notifications_read", { p_entity_type: input.entityType, p_entity_id: input.entityId });
    throwIfDbError(error);
    const count = typeof data === "number" ? data : 0;
    if (count > 0) {
      await ctx.audit({ event: "data_update", resourceType: "notification", action: "inbox.open_item", details: { entity_type: input.entityType, entity_id: input.entityId, count } });
    }
    return ok({ count });
  },
);

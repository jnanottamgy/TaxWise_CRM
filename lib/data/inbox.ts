import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { NotificationType } from "@/lib/domain/enums";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import {
  ACTION_KINDS,
  isActionKind,
  notificationGroupsFor,
  notificationTypesInGroup,
  type ActionItem,
  type InboxShow,
  type NotificationGroupSlug,
} from "@/lib/schemas/inbox";

/**
 * The Inbox (§7.17), read under the caller's own session: inbox_action_items for "Needs your
 * action" and inbox_notifications for "Updates" (0172). Both views run as the caller, so RLS on the
 * records and on notifications ("each user sees their own only") holds for every row.
 */

/** Action items are few by nature; this is a guard, not a page size. */
const ACTION_CAP = 500;

export async function getActionItems(supabase: ServerSupabase): Promise<{ items: ActionItem[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from("inbox_action_items")
    .select("kind, entity_type, entity_id, client_id, client_name, reference, title, person_name, amount, due_date, since, reason, note, item_count, link_url")
    .in("kind", ACTION_KINDS as unknown as string[])
    .order("since", { ascending: false })
    .limit(ACTION_CAP + 1);
  if (error) throw error;
  const rows = (data ?? []).filter((r) => isActionKind(r.kind) && r.entity_id && r.entity_type && r.link_url && r.since) as ActionItem[];
  return { items: rows.slice(0, ACTION_CAP), truncated: rows.length > ACTION_CAP };
}

/** The caller's unread notifications about records still on their action list, by "type:id". */
export async function getUnreadActionNotifications(supabase: ServerSupabase): Promise<Map<string, string[]>> {
  const { data, error } = await supabase
    .from("inbox_notifications")
    .select("id, entity_type, entity_id")
    .eq("needs_action", true)
    .is("read_at", null)
    .is("archived_at", null)
    .limit(1000);
  if (error) throw error;
  const out = new Map<string, string[]>();
  for (const n of data ?? []) {
    if (!n.id || !n.entity_type || !n.entity_id) continue;
    const key = `${n.entity_type}:${n.entity_id}`;
    out.set(key, [...(out.get(key) ?? []), n.id]);
  }
  return out;
}

export type UpdateRow = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link_url: string;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  archived_at: string | null;
  emailed_at: string | null;
  created_at: string;
};

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Updates: the caller's notifications that aren't about an open action item (those show on the
 * item itself), newest first. `inbox` is everything not archived; `unread` narrows it; `archived`
 * is the archive (every archived notification, whatever it was about).
 */
export async function listUpdates(
  supabase: ServerSupabase,
  user: Pick<CurrentUser, "role">,
  t: TableParams<string, string>,
  show: InboxShow,
): Promise<{ rows: UpdateRow[]; total: number }> {
  let q = supabase.from("inbox_notifications").select("id, type, title, body, link_url, entity_type, entity_id, read_at, archived_at, emailed_at, created_at", { count: "exact" });
  if (show === "archived") q = q.not("archived_at", "is", null);
  else {
    q = q.is("archived_at", null).eq("needs_action", false);
    if (show === "unread") q = q.is("read_at", null);
  }
  const allowed = new Set(notificationGroupsFor(user.role));
  const groups = (t.filters.group ?? []).filter((g): g is NotificationGroupSlug => allowed.has(g as NotificationGroupSlug));
  if (t.filters.group?.length && groups.length === 0) return { rows: [], total: 0 };
  if (groups.length) q = q.in("type", groups.flatMap((g) => notificationTypesInGroup(g)));
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(`title.ilike.${like},body.ilike.${like}`);
  }
  q = q.order(show === "archived" ? "archived_at" : "created_at", { ascending: t.dir === "asc" }).order("id", { ascending: true });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  const rows = (data ?? []).filter((r) => r.id && r.type && r.created_at) as UpdateRow[];
  return { rows, total: count ?? 0 };
}

/** The tallies on the Inbox's tabs. */
export async function getInboxCounts(supabase: ServerSupabase): Promise<{ unreadUpdates: number; unreadAll: number; archived: number }> {
  const [unreadUpdates, unreadAll, archived] = await Promise.all([
    supabase.from("inbox_notifications").select("id", { count: "exact", head: true }).is("archived_at", null).is("read_at", null).eq("needs_action", false),
    supabase.from("inbox_notifications").select("id", { count: "exact", head: true }).is("archived_at", null).is("read_at", null),
    supabase.from("inbox_notifications").select("id", { count: "exact", head: true }).not("archived_at", "is", null),
  ]);
  for (const r of [unreadUpdates, unreadAll, archived]) if (r.error) throw r.error;
  return { unreadUpdates: unreadUpdates.count ?? 0, unreadAll: unreadAll.count ?? 0, archived: archived.count ?? 0 };
}

import "server-only";

import type { Enums } from "@/lib/database.types";
import { createAdminClient } from "@/server/admin";
import { sessionActor } from "@/server/activity";
import { log } from "@/lib/log";

/**
 * In-app notifications (§9, §7.17): the Inbox and the bell. The app sends no email; anything that
 * has to reach a client is put in front of someone here, linked to the page where the WhatsApp
 * message is ready to send.
 *
 *   ctx.after("Tell the assignee", () => notify({
 *     to: { employeeIds: [task.assigned_employee_id] },
 *     type: "task_assigned",
 *     title: "Task assigned to you",
 *     body: `${task.title} for ${client.display_name}, due ${formatDate(task.due_date)}.`,
 *     linkUrl: `/work/${task.id}`,
 *     entity: { type: "task", id: task.id },
 *     clientId: client.id,
 *   }));
 *
 * Recipients are resolved by the database (insert_notifications, 0101), so the rules hold for every
 * caller:
 *   - `to.userIds` (profile ids), `to.roles` (every active Partner and/or Manager) and
 *     `to.employeeIds` (employees.id) are merged; each person gets one row;
 *   - a notice about a client (`clientId`) that goes to the absent person of a cover in force also
 *     goes to the cover person (§4.7);
 *   - a notice about money (invoice / payment / quotation types, a money-side entity, or a link to
 *     /invoices, /quotations, /leads …) never reaches an Employee, cover persons included (§4.1);
 *   - disabled people get nothing, and neither does the person who did the thing;
 *   - `dedupeKey` makes a job that runs twice notify once (e.g. `invoice_overdue:<id>:<date>`).
 *
 * Never throws: failures are logged, and the caller's save stands (§0.1 rule 5).
 */

export type NotificationType = Enums<"notification_type">;

export interface NotifyInput {
  to: { userIds?: readonly string[]; roles?: ReadonlyArray<"partner" | "manager">; employeeIds?: readonly string[] };
  type: NotificationType;
  title: string;
  body: string;
  /** An in-app path to the exact record: "/work/<id>", "/clients/<id>?tab=documents". */
  linkUrl: string;
  entity?: { type: string; id: string } | null;
  /** The client the notice is about: enables cover forwarding (§4.7). */
  clientId?: string | null;
  dedupeKey?: string | null;
}

const uniq = (ids: readonly string[] | undefined) => [...new Set((ids ?? []).filter((v) => typeof v === "string" && v.length > 0))];

export async function notify(input: NotifyInput): Promise<void> {
  const actor = await sessionActor();
  try {
    const userIds = uniq(input.to.userIds);
    const employeeIds = uniq(input.to.employeeIds);
    const roles = [...new Set((input.to.roles ?? []).filter((r) => r === "partner" || r === "manager"))];
    if (!userIds.length && !employeeIds.length && !roles.length) return;

    const client = actor ? actor.supabase : createAdminClient();
    const { error } = await client.rpc("insert_notifications", {
      p_type: input.type,
      p_title: input.title,
      p_body: input.body,
      p_link_url: input.linkUrl,
      p_user_ids: userIds.length ? userIds : null,
      p_roles: roles.length ? roles : null,
      p_employee_ids: employeeIds.length ? employeeIds : null,
      p_entity_type: input.entity?.type ?? null,
      p_entity_id: input.entity?.id ?? null,
      p_client_id: input.clientId ?? null,
      p_dedupe_key: input.dedupeKey ?? null,
      p_exclude_user_id: actor?.userId ?? null,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "notification failed", {
      source: "server:notify",
      userId: actor?.userId,
      role: actor?.role,
      type: input.type,
      linkUrl: input.linkUrl,
      err,
    });
  }
}

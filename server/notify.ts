import "server-only";

import { after } from "next/server";
import type { Enums } from "@/lib/database.types";
import { env } from "@/lib/env";
import { isAppRole } from "@/lib/auth/roles";
import { readEmailPreferences } from "@/lib/schemas/profile";
import { createAdminClient } from "@/server/admin";
import { sessionActor } from "@/server/activity";
import { sendEmail } from "@/server/email/send";
import { notificationEmail } from "@/server/email/templates/notification";
import { emailFirm } from "@/server/email/templates/layout";
import { getFirmProfile } from "@/server/firm";
import { log } from "@/lib/log";

/**
 * In-app notifications, with email for those who asked for it (§9, §7.17).
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
 * Then, for each recipient whose Profile → Notifications says "email" for this type
 * (lib/schemas/profile.ts readEmailPreferences), the same notice goes out by email once the
 * sending domain is verified; `emailed_at` records it. Email runs after the response where the
 * platform allows (next/server `after`), so it never slows the save.
 *
 * Never throws: failures are logged with a Ref, and the caller's save stands (§0.1 rule 5).
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
    const { data, error } = await client.rpc("insert_notifications", {
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

    const created = (data ?? [])
      .filter((r): r is { notification_id: string; recipient_id: string; forwarded: boolean | null } => Boolean(r.notification_id && r.recipient_id))
      .map((r) => ({ id: r.notification_id, userId: r.recipient_id }));
    if (!created.length) return;

    const job = () => emailNotifications(created, input);
    try {
      after(job);
    } catch {
      // Not inside a request (a script): send now.
      await job();
    }
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

/** Emails the notice to each recipient who chose email for this type. Never throws. */
async function emailNotifications(created: Array<{ id: string; userId: string }>, input: NotifyInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: people, error } = await admin
      .from("profiles")
      .select("id, email, full_name, role, is_active, preferences")
      .in(
        "id",
        created.map((c) => c.userId),
      );
    if (error) throw error;
    const wanting = (people ?? []).filter((p) => {
      if (!p.is_active || !p.email || !isAppRole(p.role) || p.role === "client") return false;
      return readEmailPreferences(p.preferences, p.role)[input.type] === true;
    });
    if (!wanting.length) return;

    const firm = emailFirm(await getFirmProfile(admin));
    const link = `${env.appUrl().replace(/\/+$/, "")}${input.linkUrl}`;
    for (const person of wanting) {
      const n = created.find((c) => c.userId === person.id);
      if (!n) continue;
      const mail = notificationEmail({ recipientName: person.full_name, title: input.title, body: input.body, linkUrl: link }, firm);
      const res = await sendEmail({
        to: person.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        kind: "notification",
        related: input.entity ?? null,
        idempotencyKey: `notification:${n.id}`,
      });
      if (res.status === "sent") {
        const { error: stampError } = await admin.from("notifications").update({ emailed_at: new Date().toISOString() }).eq("id", n.id);
        if (stampError) log("warn", "notification emailed_at not stamped", { source: "server:notify", notificationId: n.id, err: stampError });
      } else if (res.status === "failed") {
        log("warn", "notification email failed", { source: "server:notify", notificationId: n.id, error: res.error });
      }
    }
  } catch (err) {
    log("error", "notification email step failed", { source: "server:notify", type: input.type, err });
  }
}

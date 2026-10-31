import "server-only";

import type { Json } from "@/lib/database.types";
import { getSession } from "@/lib/auth/current-user";
import type { AppRole } from "@/lib/auth/roles";
import type { ServerSupabase } from "@/lib/supabase/server";
import { createAdminClient, type AdminSupabase } from "@/server/admin";
import { isMoneySideKind } from "@/lib/handoff";
import { log } from "@/lib/log";

/**
 * Who did it, and the history rows that record it (§5.2 employee_activities, §5.11 activity_logs).
 *
 *   ctx.after("Log the change", () => logActivity({ entityType: "task", entityId: id, action: "task_updated",
 *     description: "Due date moved to 25 Oct 2026" }));
 *   ctx.after("Log the activity", () => logEmployeeActivity({ activityType: "client_updated", description: "Updated Sharma Traders",
 *     entityType: "client", entityId: clientId, entityName: "Sharma Traders" }));
 *
 * Both run after the main write and never throw (§0.1 rule 5): a failure is logged with its Ref
 * and the save stands. Under a signed-in user they write through that user's session (RLS applies:
 * an Employee can't write money-side history, §4.1); in a scheduled job or webhook there is no
 * user and they write as the system (server/admin.ts).
 *
 * Employees never receive fee data through history (§4.1): for an action that isn't on the money
 * side (money_side_kind, 0043: lead*, quotation*, invoice*, payment*, receipt*, credit_note*,
 * engagement_letter*, fee*, tds_credit*), metadata keys that name money (fee, amount, total, rate,
 * outstanding, TDS, GST amounts …) are dropped before writing. Log fee changes with a money-side
 * action ("fee_changed") instead.
 */

export interface Actor {
  userId: string;
  role: AppRole;
  fullName: string;
  email: string;
  /** employees.id for staff; null for portal users. */
  employeeId: string | null;
  /** The user's own session client. */
  supabase: ServerSupabase;
}

/** The signed-in user behind this request, or null in a job, a webhook or a public page. Never throws. */
export async function sessionActor(): Promise<Actor | null> {
  try {
    const s = await getSession();
    if (s.status !== "ok") return null;
    return {
      userId: s.user.id,
      role: s.user.role,
      fullName: s.user.fullName,
      email: s.user.email,
      employeeId: s.user.employeeId,
      supabase: s.supabase,
    };
  } catch {
    // Outside a request (no cookies): a job or a script.
    return null;
  }
}

/** The client to write a side record with: the actor's session, or the system without one. */
export function writerFor(actor: Actor | null): ServerSupabase | AdminSupabase {
  return actor ? actor.supabase : createAdminClient();
}

const MONEY_KEY = /(^|_)(fee|fees|amount|amounts|subtotal|total|totals|price|rate|outstanding|receivable|receivables|tds|cgst|sgst|igst|gst_amount|tax_amount|billing)(_|$)/i;

/**
 * Drops money-named keys from metadata for a history row that isn't on the money side (§4.1).
 * Returns the cleaned metadata and the keys it dropped. Exported for tests.
 */
export function scrubMoneyMetadata(
  metadata: Record<string, unknown> | null | undefined,
  moneySide: boolean,
): { metadata: Record<string, unknown> | null; dropped: string[] } {
  if (!metadata) return { metadata: null, dropped: [] };
  if (moneySide) return { metadata, dropped: [] };
  const dropped: string[] = [];
  const clean = (value: unknown, path: string, depth: number): unknown => {
    if (depth > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v, i) => clean(v, `${path}[${i}]`, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (MONEY_KEY.test(k)) {
        dropped.push(path ? `${path}.${k}` : k);
        continue;
      }
      out[k] = clean(v, path ? `${path}.${k}` : k, depth + 1);
    }
    return out;
  };
  return { metadata: clean(metadata, "", 0) as Record<string, unknown>, dropped };
}

export interface ActivityInput {
  entityType: string;
  entityId: string;
  /** e.g. task_updated, status_changed, fee_changed (money side). */
  action: string;
  /** One plain sentence shown in the record's history. */
  description: string;
  metadata?: Record<string, unknown> | null;
}

/** Writes an activity_logs row for a record's history (§5.11). Never throws. */
export async function logActivity(input: ActivityInput): Promise<void> {
  const actor = await sessionActor();
  try {
    const { metadata, dropped } = scrubMoneyMetadata(input.metadata, isMoneySideKind(input.action));
    if (dropped.length) {
      log("warn", "money keys dropped from activity metadata", { source: "server:activity", action: input.action, dropped, userId: actor?.userId });
    }
    // Portal users don't write the firm's activity history themselves; the system records it for them.
    const writer = actor && actor.role !== "client" ? actor.supabase : createAdminClient();
    const { error } = await writer.from("activity_logs").insert({
      entity_type: input.entityType.slice(0, 60),
      entity_id: input.entityId,
      action: input.action.slice(0, 80),
      description: input.description.slice(0, 1000),
      user_id: actor?.userId ?? null,
      user_name: actor?.fullName ?? null,
      metadata: (metadata ?? null) as Json,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "activity log write failed", { source: "server:activity", userId: actor?.userId, role: actor?.role, action: input.action, err });
  }
}

export interface EmployeeActivityInput {
  /** login, logout, client_created … settings_changed (§5.2). */
  activityType: string;
  description: string;
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Adds to the signed-in staff member's own activity feed (§5.2 employee_activities: People →
 * person, performance). Nothing is written without a staff session (jobs, portal users). Never throws.
 */
export async function logEmployeeActivity(input: EmployeeActivityInput): Promise<void> {
  const actor = await sessionActor();
  if (!actor || !actor.employeeId || actor.role === "client") return;
  try {
    const { metadata, dropped } = scrubMoneyMetadata(input.metadata, isMoneySideKind(input.activityType) || isMoneySideKind(input.entityType));
    if (dropped.length) {
      log("warn", "money keys dropped from employee activity metadata", { source: "server:activity", activityType: input.activityType, dropped, userId: actor.userId });
    }
    const { error } = await actor.supabase.from("employee_activities").insert({
      employee_id: actor.employeeId,
      user_id: actor.userId,
      activity_type: input.activityType.slice(0, 60),
      description: input.description.slice(0, 1000),
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      entity_name: input.entityName ? input.entityName.slice(0, 200) : null,
      metadata: (metadata ?? null) as Json,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "employee activity write failed", { source: "server:activity", userId: actor.userId, role: actor.role, activityType: input.activityType, err });
  }
}

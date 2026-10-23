import "server-only";

import type { Json } from "@/lib/database.types";
import type { AdminSupabase } from "@/server/admin";
import { endsTomorrow, formatCoverUntil, needsExpiryLog, type CoverRecord } from "@/lib/domain/cover";
import { istDateOf } from "@/lib/domain/fy";
import { coverWindowText } from "@/lib/schemas/covers";
import { log } from "@/lib/log";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { closeStaleSessions } from "@/server/presence";

/**
 * Cover lifecycle, hourly (§8, §4.7):
 *   - "Cover ends tomorrow" to the granter, once (client_covers.ending_notified_at);
 *   - for covers that ended at their Until: tells the cover person (with the prompt for a note
 *     back) and the absent person ("See what changed": the client timeline for the cover window),
 *     adds the end to each client's timeline, and records the automatic end (expiry_logged_at and an
 *     audit row). Access itself needs no job: RLS compares the window with now().
 * Covers that ended more than a week before this job first saw them (a deploy gap) are recorded
 * without notifications. Also closes presence sessions silent past the stale threshold (§7.12).
 * Idempotent: the markers and the notification dedupe keys make a second run send nothing.
 */

const QUIET_AFTER_DAYS = 7;

type Raw = {
  id: string;
  kind: "client" | "person";
  client_id: string | null;
  absent_employee_id: string | null;
  cover_employee_id: string;
  starts_at: string;
  ends_at: string;
  revoked_at: string | null;
  expiry_logged_at: string | null;
  granted_by: string;
};

const COLS = "id, kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, revoked_at, expiry_logged_at, granted_by";

function asRecord(c: Raw): CoverRecord {
  return {
    id: c.id,
    kind: c.kind,
    clientId: c.client_id,
    absentEmployeeId: c.absent_employee_id,
    coverEmployeeId: c.cover_employee_id,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    revokedAt: c.revoked_at,
    expiryLoggedAt: c.expiry_logged_at,
  };
}

async function names(admin: AdminSupabase, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data, error } = await admin.from("employees").select("id, full_name").in("id", unique);
  if (error) throw error;
  return new Map((data ?? []).map((e) => [e.id, e.full_name]));
}

/** The clients a cover reaches now: its client, or every client the absent person owns or is on the team of. */
async function reached(admin: AdminSupabase, c: Raw): Promise<Array<{ id: string; display_name: string }>> {
  if (c.kind === "client") {
    if (!c.client_id) return [];
    const { data } = await admin.from("clients").select("id, display_name").eq("id", c.client_id).maybeSingle();
    return data ? [data] : [];
  }
  if (!c.absent_employee_id) return [];
  const [owned, team] = await Promise.all([
    admin.from("clients").select("id, display_name").eq("owner_employee_id", c.absent_employee_id).is("deleted_at", null).limit(2000),
    admin.from("client_team_members").select("clients(id, display_name, deleted_at)").eq("employee_id", c.absent_employee_id).limit(2000),
  ]);
  const out = new Map<string, { id: string; display_name: string }>();
  for (const r of owned.data ?? []) out.set(r.id, r);
  for (const m of team.data ?? []) {
    const cl = m.clients as { id: string; display_name: string; deleted_at: string | null } | null;
    if (cl && !cl.deleted_at) out.set(cl.id, { id: cl.id, display_name: cl.display_name });
  }
  return Array.from(out.values());
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts = { ending_notified: 0, ended_recorded: 0, ended_quietly: 0, failed: 0, stale_sessions_closed: 0 };

  // 1. "Cover ends tomorrow" (once).
  const soon = new Date(now.getTime() + 48 * 3_600_000).toISOString();
  const { data: ending, error: endingError } = await admin
    .from("client_covers")
    .select(COLS)
    .is("revoked_at", null)
    .is("ending_notified_at", null)
    .gt("ends_at", now.toISOString())
    .lte("ends_at", soon)
    .limit(1000);
  if (endingError) throw endingError;
  const endingRows = ((ending ?? []) as Raw[]).filter((c) => endsTomorrow(asRecord(c), now));
  const endingNames = await names(admin, endingRows.flatMap((c) => [c.cover_employee_id, c.absent_employee_id ?? ""]));
  for (const c of endingRows) {
    try {
      const cover = endingNames.get(c.cover_employee_id) ?? "A colleague";
      const absent = c.absent_employee_id ? endingNames.get(c.absent_employee_id) : null;
      await notify({
        to: { userIds: [c.granted_by] },
        type: "cover_ending",
        title: `${cover}'s cover${absent ? ` for ${absent}` : ""} ends tomorrow`,
        body: `It ends ${formatCoverUntil(c.ends_at)}. Extend it if they still need it.`,
        linkUrl: c.client_id ? `/clients/${c.client_id}?tab=profile` : `/people/${c.absent_employee_id ?? c.cover_employee_id}?tab=work`,
        entity: { type: "client_cover", id: c.id },
        dedupeKey: `cover-ending:${c.id}`,
      });
      const { error } = await admin.from("client_covers").update({ ending_notified_at: now.toISOString() }).eq("id", c.id).is("ending_notified_at", null);
      if (error) throw error;
      counts.ending_notified++;
    } catch (err) {
      counts.failed++;
      log("error", "cover-ending notice failed", { source: "jobs:cover-lifecycle", err });
    }
  }

  // 2. Covers that ended at their Until.
  const { data: ended, error: endedError } = await admin
    .from("client_covers")
    .select(COLS)
    .is("revoked_at", null)
    .is("expiry_logged_at", null)
    .lte("ends_at", now.toISOString())
    .limit(1000);
  if (endedError) throw endedError;
  const endedRows = ((ended ?? []) as Raw[]).filter((c) => needsExpiryLog(asRecord(c), now));
  const endedNames = await names(admin, endedRows.flatMap((c) => [c.cover_employee_id, c.absent_employee_id ?? ""]));
  for (const c of endedRows) {
    try {
      const quiet = now.getTime() - Date.parse(c.ends_at) > QUIET_AFTER_DAYS * 86_400_000;
      const cover = endedNames.get(c.cover_employee_id) ?? "A colleague";
      const absent = c.absent_employee_id ? endedNames.get(c.absent_employee_id) : null;
      const clients = await reached(admin, c);
      const window = coverWindowText(c.starts_at, c.ends_at);
      const from = istDateOf(c.starts_at);
      const to = istDateOf(new Date(Date.parse(c.ends_at) - 1));

      if (!quiet) {
        await notify({
          to: { employeeIds: [c.cover_employee_id] },
          type: "cover_ended",
          title: `Your cover${absent ? ` for ${absent}` : ""} has ended`,
          body: "Leave a note about what you did, if there's anything they should know.",
          linkUrl: `/people/${c.cover_employee_id}?tab=work&return_note=${c.id}`,
          entity: { type: "client_cover", id: c.id },
          dedupeKey: `cover-ended:${c.id}:cover`,
        });
        if (c.absent_employee_id) {
          const what = c.kind === "client" ? (clients[0]?.display_name ?? "a client") : "your clients";
          await notify({
            to: { employeeIds: [c.absent_employee_id] },
            type: "cover_ended",
            title: `${cover} covered ${what} for you, ${window}`,
            body: "See what changed while you were away.",
            linkUrl: c.kind === "client" && c.client_id ? `/clients/${c.client_id}?tab=timeline&from=${from}&to=${to}` : `/people/${c.absent_employee_id}?tab=work&changes=${c.id}`,
            entity: { type: "client_cover", id: c.id },
            dedupeKey: `cover-ended:${c.id}:absent`,
          });
        }
        for (const client of clients) {
          await addTimelineEvent({
            clientId: client.id,
            eventType: "cover_ended",
            title: `${cover}'s cover${absent ? ` for ${absent}` : ""} ended (${window})`,
            metadata: { cover_id: c.id, ended_at: c.ends_at, automatic: true },
          });
        }
      }

      const { error: auditError } = await admin.from("audit_logs").insert({
        event: "permission_change",
        resource_type: "client_covers",
        resource_id: c.id,
        action: "cover.expired",
        details: { kind: c.kind, client_id: c.client_id, absent_employee_id: c.absent_employee_id, cover_employee_id: c.cover_employee_id, ended_at: c.ends_at, notified: !quiet } as Json,
        success: true,
      });
      if (auditError) throw auditError;
      const { error } = await admin.from("client_covers").update({ expiry_logged_at: now.toISOString() }).eq("id", c.id).is("expiry_logged_at", null);
      if (error) throw error;
      if (quiet) counts.ended_quietly++;
      else counts.ended_recorded++;
    } catch (err) {
      counts.failed++;
      log("error", "cover end not recorded", { source: "jobs:cover-lifecycle", err });
    }
  }

  try {
    counts.stale_sessions_closed = (await closeStaleSessions(admin, now)).closed;
  } catch (err) {
    counts.failed++;
    log("error", "stale session sweep failed", { source: "jobs:cover-lifecycle", err });
  }
  return { counts };
}

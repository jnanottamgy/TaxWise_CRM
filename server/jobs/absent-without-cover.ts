import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { COVER_DEFAULTS, isAbsentWithoutCover } from "@/lib/domain/cover";
import { addDays, istDayBounds, isWorkingDay, todayIST } from "@/lib/domain/fy";
import { formatDayMonth } from "@/lib/domain/leave";
import { log } from "@/lib/log";
import { notify } from "@/server/notify";
import { loadAttendanceSettings } from "@/server/presence";

/**
 * Absent without cover, daily (§8, §7.2, §4.7): tells Managers who is on leave today, or hasn't
 * signed in by the start of the day + grace + 30 minutes, where that person's clients have open
 * tasks due within 2 days and no cover in force reaches them. One notice per person per day
 * (dedupe key), each with a link to set up cover. With the default day (09:30 + 15 minutes' grace)
 * the no-show cutoff is 10:15 IST; a run before it reports only people on leave.
 */
export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts = { checked: 0, flagged: 0, notified: 0, failed: 0 };
  const today = todayIST(now);
  const settings = await loadAttendanceSettings(admin, today);
  const working = isWorkingDay(today, { weekdays: settings.weekdays, holidays: settings.holidays });
  if (!working) return { counts };

  const { start, end } = istDayBounds(today);
  const dueBy = addDays(today, COVER_DEFAULTS.tasksDueWithinDays);
  const [staff, leave, sessions, covers] = await Promise.all([
    admin.from("employees").select("id, full_name, profiles!inner(is_active, role)").eq("is_active", true).is("deleted_at", null).not("profile_id", "is", null).limit(5000),
    admin.from("employee_leave").select("employee_id").eq("status", "approved").lte("start_date", today).gte("end_date", today).limit(5000),
    admin.from("employee_sessions").select("employee_id, login_at").gte("login_at", start.toISOString()).lt("login_at", end.toISOString()).limit(50000),
    admin
      .from("client_covers")
      .select("kind, client_id, absent_employee_id")
      .is("revoked_at", null)
      .lte("starts_at", end.toISOString())
      .gt("ends_at", now.toISOString())
      .limit(5000),
  ]);
  for (const r of [staff, leave, sessions, covers]) if (r.error) throw r.error;

  const onLeave = new Set((leave.data ?? []).map((l) => l.employee_id));
  const signedIn = new Map<string, string>();
  for (const s of sessions.data ?? []) {
    const prev = signedIn.get(s.employee_id);
    if (!prev || s.login_at < prev) signedIn.set(s.employee_id, s.login_at);
  }
  const personCovered = new Set((covers.data ?? []).filter((c) => c.kind === "person" && c.absent_employee_id).map((c) => c.absent_employee_id as string));
  const clientCovered = new Set((covers.data ?? []).filter((c) => c.kind === "client" && c.client_id).map((c) => c.client_id as string));

  for (const e of staff.data ?? []) {
    const profile = e.profiles as { is_active: boolean; role: string } | null;
    if (!profile?.is_active || profile.role === "client") continue;
    if (!onLeave.has(e.id) && signedIn.has(e.id)) continue;
    counts.checked++;
    try {
      // Their clients without a cover in force, and the open tasks due on them within 2 days.
      const [owned, team] = await Promise.all([
        admin.from("clients").select("id").eq("owner_employee_id", e.id).is("deleted_at", null).limit(2000),
        admin.from("client_team_members").select("client_id").eq("employee_id", e.id).limit(2000),
      ]);
      if (owned.error) throw owned.error;
      if (team.error) throw team.error;
      const clientIds = Array.from(new Set([...(owned.data ?? []).map((c) => c.id), ...(team.data ?? []).map((t) => t.client_id)])).filter(
        (id) => !clientCovered.has(id),
      );
      const hasCover = personCovered.has(e.id) || clientIds.length === 0;
      let due: Array<{ client_id: string; due_date: string | null }> = [];
      if (!hasCover) {
        const { data, error } = await admin
          .from("tasks")
          .select("client_id, due_date")
          .in("client_id", clientIds)
          .is("deleted_at", null)
          .neq("status", "filed_done")
          .lte("due_date", dueBy)
          .limit(2000);
        if (error) throw error;
        due = data ?? [];
      }
      const flagged = isAbsentWithoutCover({
        now,
        isWorkingDay: true,
        onLeaveToday: onLeave.has(e.id),
        signedInAt: signedIn.get(e.id) ?? null,
        workDayStart: settings.params.workDayStart,
        lateGraceMinutes: settings.params.lateGraceMinutes,
        hasTasksDueSoon: due.length > 0,
        hasCoverInForce: hasCover,
      });
      if (!flagged) continue;
      counts.flagged++;
      const clientCount = new Set(due.map((d) => d.client_id)).size;
      await notify({
        to: { roles: ["manager"] },
        type: "warning",
        title: `${e.full_name} is ${onLeave.has(e.id) ? "on leave" : "not signed in"} today, with no cover`,
        body: `${due.length} open task${due.length === 1 ? "" : "s"} due by ${formatDayMonth(dueBy)} on ${clientCount} client${clientCount === 1 ? "" : "s"}. Set up cover so the work doesn't slip.`,
        linkUrl: `/people/${e.id}?tab=work&cover=new`,
        entity: { type: "employee", id: e.id },
        dedupeKey: `absent-without-cover:${today}:${e.id}`,
      });
      counts.notified++;
    } catch (err) {
      counts.failed++;
      log("error", "absent-without-cover check failed for one person", { source: "jobs:absent-without-cover", err });
    }
  }
  return { counts };
}

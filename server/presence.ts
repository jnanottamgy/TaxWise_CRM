import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { createAdminClient } from "@/server/admin";
import {
  PRESENCE_PARAM_KEYS,
  applyHeartbeat,
  closeAllAtDayEnd,
  closeOnSignOut,
  resolvePresenceParams,
  sweepStaleSessions,
  type OpenSession,
  type PresenceParams,
  type SessionClose,
} from "@/lib/domain/presence";
import { istDateOf, istDayBounds, isWorkingDay, todayIST, type DateString } from "@/lib/domain/fy";
import { ATTENDANCE_DEFAULTS, deriveAttendance, summariseDay, type AttendanceParams, type DaySession } from "@/lib/domain/attendance";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { log } from "@/lib/log";

/**
 * Presence sessions (§7.12, §5.2 employee_sessions). The rules are lib/domain/presence.ts; this
 * applies them to the table, which only the server writes (0032: no API writes). Callers have
 * already established who the person is from their own session (the heartbeat route, sign-in and
 * sign-out); the writes go through the service role.
 *
 * Concurrency: one open session per person (unique index, 0106). A beat reads the open session,
 * works out the outcome, and writes it only if `last_active_at` is still what it read (compare and
 * swap); a lost race reads again, so two tabs beating at once never double-credit.
 */

export interface PresenceIdentity {
  employeeId: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type BeatResult = { outcome: "opened" | "credited" | "reopened"; activeMinutes: number; lastActiveAt: string };

type OpenRow = { id: string; login_at: string; last_active_at: string; active_minutes: number };

const MAX_ATTEMPTS = 4;

/** The presence thresholds in force (§5.12 `presence.thresholds`), falling back to §7.12's values. */
export async function loadPresenceParams(admin: AdminSupabase, now: Date = new Date()): Promise<PresenceParams> {
  try {
    const { data, error } = await admin
      .from("statutory_parameters")
      .select("key, value, effective_from, effective_to")
      .eq("key", PRESENCE_PARAM_KEYS.thresholds);
    if (error) throw error;
    const rows: StatutoryParameterRow[] = (data ?? []).map((r) => ({
      key: r.key,
      value: r.value,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    }));
    return resolvePresenceParams(rows, todayIST(now));
  } catch (err) {
    log("warn", "presence thresholds unavailable; using the defaults", { source: "presence:params", err });
    return resolvePresenceParams([], todayIST(now));
  }
}

async function readOpen(admin: AdminSupabase, employeeId: string): Promise<OpenRow | null> {
  const { data, error } = await admin
    .from("employee_sessions")
    .select("id, login_at, last_active_at, active_minutes")
    .eq("employee_id", employeeId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function asOpen(row: OpenRow): OpenSession {
  return { loginAt: row.login_at, lastActiveAt: row.last_active_at, activeMinutes: row.active_minutes };
}

/** Closes the row if it is still the open session as read. True when this call closed it. */
async function writeClose(admin: AdminSupabase, row: OpenRow, close: SessionClose): Promise<boolean> {
  const { data, error } = await admin
    .from("employee_sessions")
    .update({
      is_active: false,
      logout_at: close.logoutAt.toISOString(),
      active_minutes: close.activeMinutes,
      duration_minutes: close.durationMinutes,
      closed_reason: close.closedReason,
    })
    .eq("id", row.id)
    .eq("is_active", true)
    .eq("last_active_at", row.last_active_at)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Opens a session (login_at = last_active_at = now). False when another request opened one first. */
async function writeOpen(admin: AdminSupabase, who: PresenceIdentity, at: Date): Promise<boolean> {
  const { error } = await admin.from("employee_sessions").insert({
    employee_id: who.employeeId,
    user_id: who.userId,
    login_at: at.toISOString(),
    last_active_at: at.toISOString(),
    active_minutes: 0,
    is_active: true,
    ip: who.ip ? who.ip.slice(0, 100) : null,
    user_agent: who.userAgent ? who.userAgent.slice(0, 500) : null,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

/**
 * One heartbeat (§7.12): no open session → open one; a live one → credit
 * `min(now − last_active_at, cap)`; a stale one (the sweep hasn't closed it yet) → close it at its
 * last activity and open a new one, so the silent gap is never credited.
 */
export async function recordBeat(who: PresenceIdentity, now: Date = new Date(), admin: AdminSupabase = createAdminClient()): Promise<BeatResult> {
  const params = await loadPresenceParams(admin, now);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const open = await readOpen(admin, who.employeeId);
    const outcome = applyHeartbeat(open ? asOpen(open) : null, now, params);

    if (outcome.kind === "open") {
      if (await writeOpen(admin, who, outcome.open.loginAt)) {
        return { outcome: "opened", activeMinutes: 0, lastActiveAt: outcome.open.lastActiveAt.toISOString() };
      }
      continue;
    }

    if (outcome.kind === "credit") {
      if (!open) continue;
      const { data, error } = await admin
        .from("employee_sessions")
        .update({ last_active_at: outcome.lastActiveAt.toISOString(), active_minutes: outcome.activeMinutes })
        .eq("id", open.id)
        .eq("is_active", true)
        .eq("last_active_at", open.last_active_at)
        .select("id");
      if (error) throw error;
      if ((data ?? []).length > 0) {
        return { outcome: "credited", activeMinutes: outcome.activeMinutes, lastActiveAt: outcome.lastActiveAt.toISOString() };
      }
      continue;
    }

    // reopen
    if (!open) continue;
    if (!(await writeClose(admin, open, outcome.close))) continue;
    if (await writeOpen(admin, who, outcome.open.loginAt)) {
      return { outcome: "reopened", activeMinutes: 0, lastActiveAt: outcome.open.lastActiveAt.toISOString() };
    }
  }
  throw new Error("presence heartbeat lost every race; giving up");
}

/** Sign-in opens a session (or keeps the one another tab has open), like a beat (§7.12). */
export async function openOnSignIn(who: PresenceIdentity, now: Date = new Date()): Promise<BeatResult> {
  return recordBeat(who, now);
}

/**
 * Explicit sign-out (§7.12): credits the last stretch (capped) and closes at now; a session already
 * stale closes at its last activity instead. Nothing to do when no session is open.
 */
export async function closeOnLogout(employeeId: string, now: Date = new Date(), admin: AdminSupabase = createAdminClient()): Promise<boolean> {
  const params = await loadPresenceParams(admin, now);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const open = await readOpen(admin, employeeId);
    if (!open) return false;
    if (await writeClose(admin, open, closeOnSignOut(asOpen(open), now, params))) return true;
  }
  return false;
}

/** Closes every open session silent for the stale threshold, at its last activity (§7.12). */
export async function closeStaleSessions(admin: AdminSupabase, now: Date = new Date()): Promise<{ closed: number; failed: number }> {
  const params = await loadPresenceParams(admin, now);
  const cutoff = new Date(now.getTime() - params.staleAfterMinutes * 60_000).toISOString();
  const { data, error } = await admin
    .from("employee_sessions")
    .select("id, login_at, last_active_at, active_minutes")
    .eq("is_active", true)
    .lte("last_active_at", cutoff)
    .limit(5000);
  if (error) throw error;
  let closed = 0;
  let failed = 0;
  for (const { session, close } of sweepStaleSessions((data ?? []).map((r) => ({ ...asOpen(r), row: r })), now, params)) {
    try {
      if (await writeClose(admin, session.row, close)) closed += 1;
    } catch (err) {
      failed += 1;
      log("error", "could not close a stale session", { source: "presence:sweep", err });
    }
  }
  return { closed, failed };
}

/** The staff record of a login, read with the service role (sign-in and sign-out, before the session cookie settles). */
export async function employeeIdForUser(userId: string, admin: AdminSupabase = createAdminClient()): Promise<string | null> {
  const { data, error } = await admin.from("employees").select("id").eq("profile_id", userId).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Sign-in hook (§7.12 "A beat with no open session opens one"): opens the presence session for a
 * staff login, unless the person still has to set a password or pass two-step sign-in (the first
 * heartbeat after that opens it). Never throws: presence must not block anyone from signing in.
 */
export async function presenceOnSignIn(p: { userId: string; role: string; ready: boolean; ip: string | null; userAgent: string | null }): Promise<void> {
  if (!p.ready || (p.role !== "partner" && p.role !== "manager" && p.role !== "employee")) return;
  try {
    const employeeId = await employeeIdForUser(p.userId);
    if (!employeeId) return;
    await openOnSignIn({ employeeId, userId: p.userId, ip: p.ip, userAgent: p.userAgent });
  } catch (err) {
    log("warn", "presence session not opened at sign-in", { source: "presence:sign-in", userId: p.userId, err });
  }
}

/** Sign-out hook (§7.12 "Explicit sign-out closes it too"). Never throws. */
export async function presenceOnSignOut(userId: string): Promise<void> {
  try {
    const employeeId = await employeeIdForUser(userId);
    if (employeeId) await closeOnLogout(employeeId);
  } catch (err) {
    log("warn", "presence session not closed at sign-out", { source: "presence:sign-out", userId, err });
  }
}

// -------------------------------------------------------------------------------------------------
// Attendance per working day (§7.12), for the 00:15 sweep and the 11:30 job
// -------------------------------------------------------------------------------------------------

export interface AttendanceSettings {
  weekdays: number[];
  holidays: Set<string>;
  params: AttendanceParams;
}

export async function loadAttendanceSettings(admin: AdminSupabase, date: DateString): Promise<AttendanceSettings> {
  const [settings, holidays] = await Promise.all([
    admin.from("firm_settings").select("working_weekdays, work_day_start, late_grace_minutes, half_day_minutes").eq("id", 1).maybeSingle(),
    admin.from("holidays").select("date").eq("date", date),
  ]);
  if (settings.error) throw settings.error;
  if (holidays.error) throw holidays.error;
  const s = settings.data;
  return {
    weekdays: s?.working_weekdays?.length ? s.working_weekdays.map(Number) : [1, 2, 3, 4, 5, 6],
    holidays: new Set((holidays.data ?? []).map((h) => h.date)),
    params: {
      workDayStart: s?.work_day_start ?? ATTENDANCE_DEFAULTS.workDayStart,
      lateGraceMinutes: s?.late_grace_minutes ?? ATTENDANCE_DEFAULTS.lateGraceMinutes,
      halfDayMinutes: s?.half_day_minutes ?? ATTENDANCE_DEFAULTS.halfDayMinutes,
    },
  };
}

export interface FinaliseCounts {
  present: number;
  late_login: number;
  half_day: number;
  absent: number;
  on_leave: number;
  kept: number;
  skipped: number;
  failed: number;
}

/**
 * Writes the attendance of one finished working day (§7.12). For every active staff member with a
 * login who had joined by that day: approved leave → On leave (wins over everything); sessions that
 * began that day → Present / Late login / Half day with first login, last activity and minutes;
 * nothing → Absent, but only when `markAbsent` (the 11:30 job; the 00:15 sweep leaves no-shows to
 * it). A record someone corrected, or an On leave day, is never overwritten. A non-working day or
 * holiday writes nothing. Safe to run twice.
 */
export async function finaliseAttendanceDay(admin: AdminSupabase, date: DateString, opts: { markAbsent: boolean }): Promise<FinaliseCounts> {
  const counts: FinaliseCounts = { present: 0, late_login: 0, half_day: 0, absent: 0, on_leave: 0, kept: 0, skipped: 0, failed: 0 };
  const settings = await loadAttendanceSettings(admin, date);
  if (!isWorkingDay(date, { weekdays: settings.weekdays, holidays: settings.holidays })) return counts;

  const { start, end } = istDayBounds(date);
  const [staff, sessions, leave, existing] = await Promise.all([
    admin
      .from("employees")
      .select("id, profile_id, date_of_joining, created_at, profiles!inner(is_active, role)")
      .eq("is_active", true)
      .is("deleted_at", null)
      .not("profile_id", "is", null)
      .limit(5000),
    admin.from("employee_sessions").select("employee_id, login_at, last_active_at, active_minutes").gte("login_at", start.toISOString()).lt("login_at", end.toISOString()).limit(50000),
    admin.from("employee_leave").select("employee_id, half_day").eq("status", "approved").lte("start_date", date).gte("end_date", date).limit(5000),
    admin.from("attendance_records").select("employee_id, status, corrected_by").eq("date", date).limit(5000),
  ]);
  for (const r of [staff, sessions, leave, existing]) if (r.error) throw r.error;

  const sessionsBy = new Map<string, DaySession[]>();
  for (const s of sessions.data ?? []) {
    const list = sessionsBy.get(s.employee_id) ?? [];
    list.push({ loginAt: s.login_at, lastActiveAt: s.last_active_at, activeMinutes: s.active_minutes });
    sessionsBy.set(s.employee_id, list);
  }
  const onLeave = new Map((leave.data ?? []).map((l) => [l.employee_id, l.half_day]));
  const recordOf = new Map((existing.data ?? []).map((r) => [r.employee_id, r]));

  for (const e of staff.data ?? []) {
    try {
      const profile = e.profiles as { is_active: boolean; role: string } | null;
      if (!profile?.is_active || profile.role === "client") {
        counts.skipped++;
        continue;
      }
      if ((e.date_of_joining && e.date_of_joining > date) || istDateOf(e.created_at) > date) {
        counts.skipped++;
        continue;
      }
      const record = recordOf.get(e.id);
      if (record && (record.corrected_by || record.status === "on_leave")) {
        counts.kept++;
        continue;
      }
      const day = summariseDay(sessionsBy.get(e.id) ?? [], date);
      const status = deriveAttendance({
        ...settings.params,
        firstActivity: day.firstActivity,
        totalActiveMinutes: day.totalActiveMinutes,
        isWorkingDay: true,
        onApprovedLeave: onLeave.has(e.id),
        dayComplete: true,
      });
      if (!status) {
        counts.skipped++;
        continue;
      }
      if (status === "absent" && !opts.markAbsent) {
        counts.skipped++;
        continue;
      }
      if (record && record.status === status && status === "absent") {
        counts.kept++;
        continue;
      }
      const { error } = await admin.from("attendance_records").upsert(
        {
          employee_id: e.id,
          date,
          status,
          first_login_at: day.firstActivity?.toISOString() ?? null,
          last_activity_at: day.lastActivity?.toISOString() ?? null,
          work_minutes: status === "on_leave" || status === "absent" ? null : day.totalActiveMinutes,
          notes: status === "on_leave" ? (onLeave.get(e.id) ? "Half-day leave" : "Approved leave") : null,
        },
        { onConflict: "employee_id,date" },
      );
      if (error) throw error;
      counts[status]++;
    } catch (err) {
      counts.failed++;
      log("error", "attendance not written for one person", { source: "jobs:attendance", err });
    }
  }
  return counts;
}

/** The nightly close (00:15 IST, §7.12): every session still open, at its last activity. */
export async function closeAllOpenSessions(admin: AdminSupabase, now: Date = new Date()): Promise<{ closed: number; failed: number }> {
  const params = await loadPresenceParams(admin, now);
  const { data, error } = await admin.from("employee_sessions").select("id, login_at, last_active_at, active_minutes").eq("is_active", true).limit(5000);
  if (error) throw error;
  let closed = 0;
  let failed = 0;
  for (const { session, close } of closeAllAtDayEnd((data ?? []).map((r) => ({ ...asOpen(r), row: r })), now, params)) {
    try {
      if (await writeClose(admin, session.row, close)) closed += 1;
    } catch (err) {
      failed += 1;
      log("error", "could not close an open session at day end", { source: "presence:day-end", err });
    }
  }
  return { closed, failed };
}

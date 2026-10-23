import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, todayIST } from "@/lib/domain/fy";
import { closeAllOpenSessions, finaliseAttendanceDay } from "@/server/presence";

/**
 * Workforce sweep, 00:15 IST daily (§8, §7.12):
 *   1. closes every presence session still open, at its last activity (never at "now", so a tab
 *      left open overnight earns nothing);
 *   2. finalises yesterday's attendance for everyone who was active: Present, Late login or Half
 *      day, with first login, last activity and minutes. No-shows are left to the 11:30 job, which
 *      marks them Absent. On leave and corrected days are kept.
 * Idempotent: a second run finds nothing open and writes the same statuses.
 */
export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const sessions = await closeAllOpenSessions(admin, now);
  const yesterday = addDays(todayIST(now), -1);
  const day = await finaliseAttendanceDay(admin, yesterday, { markAbsent: false });
  return {
    counts: {
      sessions_closed: sessions.closed,
      sessions_failed: sessions.failed,
      present: day.present,
      late_login: day.late_login,
      half_day: day.half_day,
      on_leave: day.on_leave,
      kept: day.kept,
      failed: day.failed,
    },
  };
}

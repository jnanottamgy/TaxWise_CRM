import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, todayIST } from "@/lib/domain/fy";
import { closeStaleSessions, finaliseAttendanceDay } from "@/server/presence";

/**
 * Attendance, 11:30 IST daily (§8, §7.12): yesterday, on a working day, everyone with no record
 * and no activity is marked Absent; approved leave is On leave (leave wins); anyone the night's
 * sweep missed gets their Present / Late login / Half day now. Non-working days and holidays create
 * no record. Also closes sessions gone silent past the stale threshold (§7.12), as every run does.
 * Idempotent.
 */
export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const stale = await closeStaleSessions(admin, now);
  const yesterday = addDays(todayIST(now), -1);
  const day = await finaliseAttendanceDay(admin, yesterday, { markAbsent: true });
  return {
    counts: {
      absent: day.absent,
      on_leave: day.on_leave,
      present: day.present,
      late_login: day.late_login,
      half_day: day.half_day,
      kept: day.kept,
      skipped: day.skipped,
      failed: day.failed,
      stale_sessions_closed: stale.closed,
    },
  };
}

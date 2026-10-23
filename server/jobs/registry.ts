import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { purgeAbandonedUploads } from "@/server/files";
import { run as absentWithoutCover } from "@/server/jobs/absent-without-cover";
import { run as attendance } from "@/server/jobs/attendance";
import { run as complianceTopUp } from "@/server/jobs/compliance-topup";
import { run as coverLifecycle } from "@/server/jobs/cover-lifecycle";
import { run as escalation } from "@/server/jobs/escalation";
import { run as partnerDigest } from "@/server/jobs/partner-digest";
import { run as recurringTasks } from "@/server/jobs/recurring-tasks";
import { run as reminders } from "@/server/jobs/reminders";
import { run as workforceSweep } from "@/server/jobs/workforce-sweep";
import type { ScheduledJobName } from "@/server/jobs/schedule";

/**
 * The scheduled jobs' bodies (§8), by the name app/api/cron/[job] is called with and job_runs
 * records (the names and times: server/jobs/schedule.ts; vercel.json holds the same schedule in
 * UTC, IST − 5:30). Every job is idempotent
 * and returns `{ counts }` (a `failed` count marks a partial run). Jobs of modules not built yet
 * (receivables, retainer billing, invoice reminders, quotations, team health, WhatsApp
 * housekeeping, access review, new FY) join this list with their modules.
 */
export type JobRun = (admin: AdminSupabase, now: Date) => Promise<{ counts: Record<string, number> }>;

/** Every name in SCHEDULED_JOBS (server/jobs/schedule.ts) has its body here, and nothing else. */
export const JOBS: Record<ScheduledJobName, JobRun> = {
  "cover-lifecycle": coverLifecycle,
  "workforce-sweep": workforceSweep,
  "recurring-tasks": recurringTasks,
  escalation,
  digest: partnerDigest,
  "compliance-top-up": complianceTopUp,
  reminders,
  "absent-without-cover": absentWithoutCover,
  attendance,
  "upload-cleanup": async () => {
    const r = await purgeAbandonedUploads();
    return { counts: { checked: r.checked, removed: r.removed } };
  },
};

export type JobName = ScheduledJobName;

export function isJobName(name: string): name is JobName {
  return Object.prototype.hasOwnProperty.call(JOBS, name);
}

/** succeeded · partial (some records failed and were logged) — a throw is `failed`, recorded by the caller. */
export function runStatus(counts: Record<string, number>): "succeeded" | "partial" {
  return (counts.failed ?? 0) > 0 ? "partial" : "succeeded";
}

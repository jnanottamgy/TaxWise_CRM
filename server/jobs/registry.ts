import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { purgeAbandonedUploads } from "@/server/files";
import { run as absentWithoutCover } from "@/server/jobs/absent-without-cover";
import { run as accessReview } from "@/server/jobs/access-review";
import { run as attendance } from "@/server/jobs/attendance";
import { run as complianceTopUp } from "@/server/jobs/compliance-topup";
import { run as coverLifecycle } from "@/server/jobs/cover-lifecycle";
import { run as escalation } from "@/server/jobs/escalation";
import { run as invoiceReminders } from "@/server/jobs/invoice-reminders";
import { run as leadFollowUps } from "@/server/jobs/lead-follow-ups";
import { run as newFy } from "@/server/jobs/new-fy";
import { run as noticeReminders } from "@/server/jobs/notice-reminders";
import { run as practiceReminders } from "@/server/jobs/practice-reminders";
import { run as quotations } from "@/server/jobs/quotations";
import { run as receivablesSweep } from "@/server/jobs/receivables-sweep";
import { run as recurringTasks } from "@/server/jobs/recurring-tasks";
import { run as registerExpiries } from "@/server/jobs/register-expiries";
import { run as reminders } from "@/server/jobs/reminders";
import { run as retainerBilling } from "@/server/jobs/retainer-billing";
import { run as teamHealth } from "@/server/jobs/team-health";
import { run as whatsappHousekeeping } from "@/server/jobs/whatsapp-housekeeping";
import { run as workforceSweep } from "@/server/jobs/workforce-sweep";
import type { JobContext, JobResult } from "@/server/jobs/context";
import type { ScheduledJobName } from "@/server/jobs/schedule";

/**
 * The scheduled jobs' bodies (§8), by the name app/api/cron/[job] is called with and job_runs
 * records (the names and times: server/jobs/schedule.ts). Every job is idempotent and returns
 * `{ counts }` (a `failed` count marks a partial run). A job that may outlast one request takes the
 * context's deadline and returns `next` to be continued (server/jobs/context.ts); the rest ignore it.
 */
export type JobRun = (admin: AdminSupabase, now: Date, ctx: JobContext) => Promise<JobResult>;

/** Every name in SCHEDULED_JOBS (server/jobs/schedule.ts) has its body here, and nothing else. */
export const JOBS: Record<ScheduledJobName, JobRun> = {
  "cover-lifecycle": coverLifecycle,
  "lead-follow-ups": leadFollowUps,
  "workforce-sweep": workforceSweep,
  "recurring-tasks": recurringTasks,
  "receivables-sweep": receivablesSweep,
  escalation,
  "compliance-top-up": complianceTopUp,
  reminders,
  "register-expiries": registerExpiries,
  "notice-reminders": noticeReminders,
  "practice-reminders": practiceReminders,
  "retainer-billing": retainerBilling,
  "invoice-reminders": invoiceReminders,
  "absent-without-cover": absentWithoutCover,
  attendance,
  quotations,
  "team-health": teamHealth,
  "whatsapp-housekeeping": whatsappHousekeeping,
  "access-review": accessReview,
  "new-fy": newFy,
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

/**
 * The scheduled jobs that exist today (§8), by the name app/api/cron/[job] is called with and that
 * job_runs records, with when each runs (IST). JOB_SCHEDULE below carries the same times in UTC.
 * Import-free, so Settings → Diagnostics can list the jobs that have never run without loading them.
 */
export const SCHEDULED_JOBS = {
  "cover-lifecycle": "Hourly",
  "lead-follow-ups": "Hourly, on the hour",
  "workforce-sweep": "00:15 daily",
  "recurring-tasks": "07:00 daily",
  "receivables-sweep": "07:30 daily",
  escalation: "08:00 daily",
  digest: "08:00 daily",
  "compliance-top-up": "08:30 on the 1st of each month",
  reminders: "09:00 daily",
  "register-expiries": "09:00 daily, with the reminders",
  "notice-reminders": "09:00 daily, with the reminders",
  "practice-reminders": "09:00 daily, with the reminders",
  "retainer-billing": "09:30 daily",
  "invoice-reminders": "10:00 daily",
  "absent-without-cover": "10:00 daily, again at 10:30 after the no-show cut-off",
  attendance: "11:30 daily",
  quotations: "14:30 daily",
  "team-health": "Mon 08:30 weekly",
  "whatsapp-housekeeping": "Mon 08:45 weekly",
  "access-review": "09:05 on 1 Jan, Apr, Jul and Oct",
  "new-fy": "06:30 on 1 April",
  "upload-cleanup": "03:00 daily",
} as const;

export type ScheduledJobName = keyof typeof SCHEDULED_JOBS;

/**
 * When each job runs, as UTC cron expressions (IST − 5:30; lib/domain/cron.ts reads them). The
 * scheduler checks every 15 minutes (netlify/functions/scheduler.mts calls /api/cron/tick) and runs
 * whatever has come due since its last check, oldest first and in this order when several are due
 * together, so a job starts within 15 minutes of its time. absent-without-cover runs twice: at
 * 10:00 IST and again after the 10:30 no-show cut-off.
 */
export const JOB_SCHEDULE: ReadonlyArray<{ job: ScheduledJobName; cron: string }> = [
  { job: "cover-lifecycle", cron: "7 * * * *" },
  { job: "lead-follow-ups", cron: "30 * * * *" },
  { job: "workforce-sweep", cron: "45 18 * * *" },
  { job: "recurring-tasks", cron: "30 1 * * *" },
  { job: "receivables-sweep", cron: "0 2 * * *" },
  { job: "escalation", cron: "30 2 * * *" },
  { job: "digest", cron: "31 2 * * *" },
  { job: "compliance-top-up", cron: "0 3 1 * *" },
  { job: "reminders", cron: "30 3 * * *" },
  { job: "register-expiries", cron: "32 3 * * *" },
  { job: "notice-reminders", cron: "34 3 * * *" },
  { job: "practice-reminders", cron: "36 3 * * *" },
  { job: "retainer-billing", cron: "0 4 * * *" },
  { job: "invoice-reminders", cron: "30 4 * * *" },
  { job: "absent-without-cover", cron: "30 4 * * *" },
  { job: "absent-without-cover", cron: "0 5 * * *" },
  { job: "attendance", cron: "0 6 * * *" },
  { job: "quotations", cron: "0 9 * * *" },
  { job: "team-health", cron: "0 3 * * 1" },
  { job: "whatsapp-housekeeping", cron: "15 3 * * 1" },
  { job: "access-review", cron: "35 3 1 1,4,7,10 *" },
  { job: "new-fy", cron: "0 1 1 4 *" },
  { job: "upload-cleanup", cron: "30 21 * * *" },
];

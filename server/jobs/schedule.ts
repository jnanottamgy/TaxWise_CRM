/**
 * The scheduled jobs that exist today (§8), by the name app/api/cron/[job] is called with and that
 * job_runs records, with when each runs (IST). vercel.json carries the same schedule in UTC.
 * Import-free, so Settings → Diagnostics can list the jobs that have never run without loading them.
 */
export const SCHEDULED_JOBS = {
  "cover-lifecycle": "Hourly",
  "workforce-sweep": "00:15 daily",
  "recurring-tasks": "07:00 daily",
  escalation: "08:00 daily",
  digest: "08:00 daily",
  "compliance-top-up": "08:30 on the 1st of each month",
  reminders: "09:00 daily",
  "absent-without-cover": "10:00 daily, again at 10:30 after the no-show cut-off",
  attendance: "11:30 daily",
  "upload-cleanup": "03:00 daily",
} as const;

export type ScheduledJobName = keyof typeof SCHEDULED_JOBS;

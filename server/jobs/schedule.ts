/**
 * The scheduled jobs that exist today (§8), by the name app/api/cron/[job] is called with and that
 * job_runs records, with when each runs (IST). vercel.json carries the same schedule in UTC.
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

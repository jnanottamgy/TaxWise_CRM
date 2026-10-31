import { lastFireTime, parseCron, runsLessThanDaily, type CronSpec } from "@/lib/domain/cron";
import { JOB_SCHEDULE, type ScheduledJobName } from "@/server/jobs/schedule";

/**
 * Which scheduled jobs to run now (§8), worked out from the schedule and the recent job_runs rows,
 * so a missed or cut-short run is caught up on the next check instead of waiting a day:
 *
 * - A job is due when its time has come (within the look-back window) and no run since then has
 *   finished (succeeded, or partial: some records failed and were logged).
 * - A run that stopped early with work left (`resume_cursor`) is continued from that cursor.
 * - A failed run is retried, from the last cursor if it was a continuation, up to MAX_ATTEMPTS
 *   times in a row per scheduled time; after that Diagnostics shows it failed until the next time.
 * - A run still marked running is left alone for STALE_RUN_MINUTES (it may be going on elsewhere);
 *   after that the host has stopped it, and it counts as a failed attempt.
 * - Look back 12 hours for daily and hourly jobs, 3 days for weekly, monthly and yearly ones: a
 *   scheduler that was down for longer skips that run (Diagnostics shows it overdue).
 *
 * Pure: the tick route (app/api/cron/tick) reads the rows and runs the answer.
 */

export const STALE_RUN_MINUTES = 10;
export const MAX_ATTEMPTS = 3;
const LOOKBACK_DAILY_MINUTES = 12 * 60;
const LOOKBACK_RARE_MINUTES = 3 * 24 * 60;
/** The rows the tick reads: enough history for the longest look-back. */
export const RUN_HISTORY_MINUTES = LOOKBACK_RARE_MINUTES + 60;

export interface RecentRun {
  name: string;
  started_at: string;
  status: string;
  resume_cursor: string | null;
}

export interface DueRun {
  job: ScheduledJobName;
  /** The scheduled time this run is for. */
  scheduledFor: Date;
  /** Resume from here (a continuation), or null for a fresh run. */
  cursor: string | null;
  /** 1 for the first try at this scheduled time, 2 and 3 for retries. */
  attempt: number;
}

const FINISHED = new Set(["succeeded", "partial"]);

const specs = new Map<string, CronSpec>();
function specOf(cron: string): CronSpec {
  let spec = specs.get(cron);
  if (!spec) {
    spec = parseCron(cron);
    specs.set(cron, spec);
  }
  return spec;
}

/** True for a run still marked running after the stale limit: the host stopped it mid-way. */
export function isStale(run: Pick<RecentRun, "status" | "started_at">, now: Date): boolean {
  return run.status === "running" && now.getTime() - Date.parse(run.started_at) > STALE_RUN_MINUTES * 60_000;
}

export function dueRuns(now: Date, runs: readonly RecentRun[], schedule: ReadonlyArray<{ job: ScheduledJobName; cron: string }> = JOB_SCHEDULE): DueRun[] {
  const due: Array<DueRun & { order: number }> = [];
  schedule.forEach((entry, order) => {
    const spec = specOf(entry.cron);
    const scheduledFor = lastFireTime(spec, now, runsLessThanDaily(spec) ? LOOKBACK_RARE_MINUTES : LOOKBACK_DAILY_MINUTES);
    if (!scheduledFor) return;

    const since = runs
      .filter((r) => r.name === entry.job && Date.parse(r.started_at) >= scheduledFor.getTime())
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    const latest = since[0];
    if (latest && latest.status === "running" && !isStale(latest, now)) return;

    // Walk back from the newest run: failures in a row, then the last finished run's cursor.
    let failures = 0;
    let cursor: string | null = null;
    let finished = false;
    for (const r of since) {
      if (FINISHED.has(r.status)) {
        finished = true;
        cursor = r.resume_cursor;
        break;
      }
      failures++;
    }
    if (finished && !cursor) return; // done for this scheduled time
    if (failures >= MAX_ATTEMPTS) return;
    due.push({ job: entry.job, scheduledFor, cursor, attempt: failures + 1, order });
  });

  // Oldest scheduled time first, then schedule order; one run per job (it covers both times).
  due.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime() || a.order - b.order);
  const seen = new Set<string>();
  return due.filter((d) => (seen.has(d.job) ? false : (seen.add(d.job), true))).map(({ job, scheduledFor, cursor, attempt }) => ({ job, scheduledFor, cursor, attempt }));
}

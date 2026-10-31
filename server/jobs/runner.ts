import "server-only";

import { log, logUnexpected } from "@/lib/log";
import type { AdminSupabase } from "@/server/admin";
import { STALE_RUN_MINUTES } from "@/server/jobs/due";
import { JOBS, runStatus } from "@/server/jobs/registry";
import type { ScheduledJobName } from "@/server/jobs/schedule";

/**
 * Runs one scheduled job and records it (§8): a job_runs row goes running → succeeded / partial /
 * failed, with its counts, its error and Ref, and `resume_cursor` when the job stopped at its time
 * budget with work left (server/jobs/context.ts). Used by /api/cron/tick and /api/cron/[job].
 */

/**
 * How long one call may spend on jobs. Hosts stop a request after a fixed time (Netlify: about
 * 10 seconds), so a call stops starting new work after this and the next check carries on.
 */
export const JOB_TIME_BUDGET_MS = 8_000;

export interface JobOutcome {
  job: ScheduledJobName;
  status: "succeeded" | "partial" | "failed";
  counts: Record<string, number>;
  /** Set when the job stopped early with work left; the next check resumes from it. */
  next: string | null;
  ms: number;
  ref?: string;
}

export async function runJob(admin: AdminSupabase, job: ScheduledJobName, opts: { deadline: number; cursor: string | null }): Promise<JobOutcome> {
  const source = `job:${job}`;
  const started = new Date();
  const { data: runRow, error: startError } = await admin.from("job_runs").insert({ name: job, started_at: started.toISOString(), status: "running" }).select("id").single();
  if (startError) throw startError;

  try {
    const { counts, next = null } = await JOBS[job](admin, started, { deadline: opts.deadline, cursor: opts.cursor });
    const status = runStatus(counts);
    const { error: endError } = await admin.from("job_runs").update({ finished_at: new Date().toISOString(), status, counts, resume_cursor: next }).eq("id", runRow.id);
    if (endError) throw endError;
    log("info", `job ${job} ${status}${next ? ", continues on the next check" : ""}`, { source, counts });
    return { job, status, counts, next, ms: Date.now() - started.getTime() };
  } catch (err) {
    const ref = logUnexpected(err, { source });
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("job_runs")
      .update({ finished_at: new Date().toISOString(), status: "failed", error: `${message.slice(0, 500)} (Ref ${ref})` })
      .eq("id", runRow.id)
      .then(({ error }) => {
        if (error) log("error", "job_runs row not closed", { source, ref, err: error });
      });
    return { job, status: "failed", counts: {}, next: null, ms: Date.now() - started.getTime(), ref };
  }
}

/**
 * Closes runs the host stopped mid-way (still "running" after STALE_RUN_MINUTES), so Diagnostics
 * shows what happened and the scheduler counts them as failed attempts. Returns how many.
 */
export async function closeStaleRuns(admin: AdminSupabase, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("job_runs")
    .update({ status: "failed", finished_at: now.toISOString(), error: "Stopped before it finished (the host's time limit for a request). The scheduler tries again on its next check." })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

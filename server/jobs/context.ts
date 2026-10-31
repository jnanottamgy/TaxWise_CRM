/**
 * What a scheduled job is told when it runs (§8). A call has a time budget, because hosts cap how
 * long a request may run (Netlify: about 10 seconds). A job that loops over many records checks
 * `outOfTime` between records and, when it runs short, stops and returns `next`: a cursor the next
 * call resumes from. The scheduler stores it on the job_runs row and calls again on its next check.
 * Jobs that finish quickly ignore all of this. Import-free, so jobs and tests can use it.
 */
export interface JobContext {
  /** Epoch milliseconds after which the job should stop starting new records. */
  deadline: number;
  /** Where the previous call stopped (its `next`), or null on a fresh run. */
  cursor: string | null;
}

/** What a job returns: its counts, and `next` when it stopped early with work left. */
export interface JobResult {
  counts: Record<string, number>;
  next?: string | null;
}

/** For a job run outside the scheduler (a test, a script): no deadline, no cursor. */
export const UNLIMITED: JobContext = { deadline: Number.POSITIVE_INFINITY, cursor: null };

/** Time to keep in hand for writing the last record and the job_runs row. */
const MARGIN_MS = 1_000;

export function outOfTime(ctx: JobContext, now: number = Date.now()): boolean {
  return now > ctx.deadline - MARGIN_MS;
}

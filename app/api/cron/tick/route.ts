import type { NextResponse } from "next/server";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { createAdminClient } from "@/server/admin";
import { RUN_HISTORY_MINUTES, dueRuns } from "@/server/jobs/due";
import { refuseUnlessCron, respond } from "@/server/jobs/http";
import { JOB_TIME_BUDGET_MS, closeStaleRuns, runJob, type JobOutcome } from "@/server/jobs/runner";

/**
 * The scheduler's check (§8): `GET` or `POST /api/cron/tick` every 15 minutes, from the Netlify
 * scheduled function (netlify/functions/scheduler.mts) or any service that can call a URL on a
 * timer. It closes runs the host stopped mid-way, works out what is due (server/jobs/due.ts: jobs
 * whose time has come, continuations, retries) and runs them one after another within one time
 * budget; whatever doesn't fit waits for the next check. Trusted only with
 * `Authorization: Bearer <CRON_SECRET>`, like every /api/cron route.
 *
 * Answers `{ ok, data: { at, closed, ran, waiting } }`: `ran` lists each job's outcome (a `next`
 * means it continues on the next check), `waiting` the due jobs left for the next check.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Don't start another job with less time than this left in the budget. */
const MIN_START_MS = 2_500;

async function handle(request: Request): Promise<NextResponse> {
  const source = "route:/api/cron/tick";
  try {
    const refused = refuseUnlessCron(request, source);
    if (refused) return refused;

    const now = new Date();
    const deadline = now.getTime() + JOB_TIME_BUDGET_MS;
    const admin = createAdminClient();
    const closed = await closeStaleRuns(admin, now);
    const { data, error } = await admin
      .from("job_runs")
      .select("name, started_at, status, resume_cursor")
      .gte("started_at", new Date(now.getTime() - RUN_HISTORY_MINUTES * 60_000).toISOString())
      .order("started_at", { ascending: false })
      .limit(5000);
    if (error) throw error;

    const ran: JobOutcome[] = [];
    const waiting: string[] = [];
    for (const due of dueRuns(now, data ?? [])) {
      if (deadline - Date.now() < MIN_START_MS) waiting.push(due.job);
      else ran.push(await runJob(admin, due.job, { deadline, cursor: due.cursor }));
    }
    if (ran.length || waiting.length || closed) {
      log("info", "scheduler check", { source, ran: ran.map((r) => `${r.job}:${r.status}${r.next ? "+" : ""}`), waiting, closed });
    }
    return respond({ ok: true, data: { at: now.toISOString(), closed, ran, waiting } }, 200);
  } catch (err) {
    const ref = logUnexpected(err, { source });
    return respond({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}

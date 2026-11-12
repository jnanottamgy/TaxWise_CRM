import { after, type NextResponse } from "next/server";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { createAdminClient } from "@/server/admin";
import { ensureApiGate } from "@/server/api-gate";
import { RUN_HISTORY_MINUTES, dueRuns } from "@/server/jobs/due";
import { refuseUnlessCron, respond } from "@/server/jobs/http";
import { BACKGROUND_TIME_BUDGET_MS, JOB_TIME_BUDGET_MS, closeStaleRuns, runJob, type JobOutcome } from "@/server/jobs/runner";

/**
 * The scheduler's check (§8): `GET` or `POST /api/cron/tick` every 15 minutes, from Supabase Cron
 * (README → Scheduled jobs), Vercel Cron on a Pro plan, or anything that can call a URL on a timer.
 * It closes runs the host stopped mid-way, works out what is due (server/jobs/due.ts: jobs whose
 * time has come, continuations, retries) and runs them one after another within one time budget;
 * whatever doesn't fit waits for the next check. Trusted only with `Authorization: Bearer
 * <CRON_SECRET>`, like every /api/cron route.
 *
 * Answers `{ ok, data: { at, closed, ran, waiting } }`: `ran` lists each job's outcome (a `next`
 * means it continues on the next check), `waiting` the due jobs left for the next check.
 *
 * With `?background=1` (how Supabase Cron calls it) it answers 202 at once and runs the check after
 * the answer (`after`, which the host keeps alive until it ends, up to maxDuration) with a longer
 * budget, so a caller's short HTTP timeout never cuts a check short. Outcomes then go to the log and
 * job_runs (Settings → Diagnostics).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Don't start another job with less time than this left in the budget. */
const MIN_START_MS = 2_500;

interface CheckResult {
  at: string;
  closed: number;
  ran: JobOutcome[];
  waiting: string[];
}

/** One check: close stale runs, then run what is due until the budget runs out. */
async function check(budgetMs: number, source: string): Promise<CheckResult> {
  const now = new Date();
  const deadline = now.getTime() + budgetMs;
  const admin = createAdminClient();
  // Keep the database API gate registered and on (migration 0243); never a reason to skip the jobs.
  try {
    await ensureApiGate(admin);
  } catch (err) {
    logUnexpected(err, { source: `${source}:api-gate` });
  }
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
  return { at: now.toISOString(), closed, ran, waiting };
}

async function handle(request: Request): Promise<NextResponse> {
  const source = "route:/api/cron/tick";
  try {
    const refused = refuseUnlessCron(request, source);
    if (refused) return refused;

    if (new URL(request.url).searchParams.get("background") === "1") {
      after(async () => {
        try {
          await check(BACKGROUND_TIME_BUDGET_MS, `${source}?background`);
        } catch (err) {
          logUnexpected(err, { source: `${source}?background` });
        }
      });
      return respond({ ok: true, data: { at: new Date().toISOString(), background: true } }, 202);
    }

    return respond({ ok: true, data: await check(JOB_TIME_BUDGET_MS, source) }, 200);
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

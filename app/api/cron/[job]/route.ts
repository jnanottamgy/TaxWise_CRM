import type { NextResponse } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { createAdminClient } from "@/server/admin";
import { refuseUnlessCron, respond } from "@/server/jobs/http";
import { isJobName } from "@/server/jobs/registry";
import { JOB_TIME_BUDGET_MS, runJob } from "@/server/jobs/runner";

/**
 * One scheduled job on demand (§8): `GET` or `POST /api/cron/<job>`, optionally `?cursor=` to
 * continue a run that stopped at its time budget. The scheduler itself calls /api/cron/tick; this is
 * for running a job by hand or from another scheduler. Trusted only with
 * `Authorization: Bearer <CRON_SECRET>`; the proxy lets /api/cron/* through without a session
 * (lib/supabase/proxy.ts MACHINE_PREFIXES). Each call writes a job_runs row (server/jobs/runner.ts),
 * which Settings → Diagnostics shows (§7.24). Jobs are idempotent, so a retried or doubled call is
 * harmless.
 *
 * Answers `{ ok, data | error, ref }` (CONVENTIONS §3.5): 200 with the counts (and `next` when the
 * job has more to do), 401 for a missing or wrong secret, 404 for an unknown job, 503 when
 * CRON_SECRET isn't set, 500 with a Ref when the job failed.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request, params: Promise<{ job: string }>): Promise<NextResponse> {
  const { job } = await params;
  const source = `route:/api/cron/${job.slice(0, 40)}`;
  try {
    const refused = refuseUnlessCron(request, source);
    if (refused) return refused;
    if (!isJobName(job)) return respond({ ok: false, error: `No scheduled job called "${job.slice(0, 40)}".`, code: "not_found" }, 404);

    const cursor = new URL(request.url).searchParams.get("cursor")?.slice(0, 200) || null;
    const outcome = await runJob(createAdminClient(), job, { deadline: Date.now() + JOB_TIME_BUDGET_MS, cursor });
    if (outcome.status === "failed" && outcome.ref) return respond({ ok: false, error: unexpectedMessage(outcome.ref), ref: outcome.ref }, 500);
    return respond({ ok: true, data: outcome }, 200);
  } catch (err) {
    const ref = logUnexpected(err, { source });
    return respond({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}

export function GET(request: Request, ctx: { params: Promise<{ job: string }> }) {
  return handle(request, ctx.params);
}

export function POST(request: Request, ctx: { params: Promise<{ job: string }> }) {
  return handle(request, ctx.params);
}

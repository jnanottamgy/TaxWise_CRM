import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { createAdminClient } from "@/server/admin";
import { JOBS, isJobName, runStatus } from "@/server/jobs/registry";

/**
 * Scheduled jobs (§8): `GET /api/cron/<job>` from Vercel Cron (vercel.json), or POST from another
 * scheduler. Trusted only with `Authorization: Bearer <CRON_SECRET>`; the proxy lets /api/cron/*
 * through without a session (lib/supabase/proxy.ts MACHINE_PREFIXES). Each run writes a job_runs row
 * (running → succeeded / partial / failed, with its counts and error), which Settings → Diagnostics
 * shows (§7.24). Jobs are idempotent, so a retried or doubled call is harmless.
 *
 * Answers `{ ok, data | error, ref }` (CONVENTIONS §3.5): 200 with the counts, 401 for a missing or
 * wrong secret, 404 for an unknown job, 503 when CRON_SECRET isn't set, 500 with a Ref when the job
 * failed.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function respond(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function authorised(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function handle(request: Request, params: Promise<{ job: string }>): Promise<NextResponse> {
  const { job } = await params;
  const source = `route:/api/cron/${job.slice(0, 40)}`;
  try {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) {
      log("warn", "cron call received but CRON_SECRET isn't set", { source });
      return respond({ ok: false, error: "CRON_SECRET isn't configured.", code: "not_configured" }, 503);
    }
    if (!authorised(request, secret)) {
      log("warn", "cron call refused: bad or missing secret", { source });
      return respond({ ok: false, error: "Not authorised.", code: "forbidden" }, 401);
    }
    if (!isJobName(job)) return respond({ ok: false, error: `No scheduled job called "${job.slice(0, 40)}".`, code: "not_found" }, 404);

    const admin = createAdminClient();
    const started = new Date();
    const { data: runRow, error: startError } = await admin.from("job_runs").insert({ name: job, started_at: started.toISOString(), status: "running" }).select("id").single();
    if (startError) throw startError;

    try {
      const { counts } = await JOBS[job](admin, started);
      const status = runStatus(counts);
      const { error: endError } = await admin.from("job_runs").update({ finished_at: new Date().toISOString(), status, counts }).eq("id", runRow.id);
      if (endError) throw endError;
      log("info", `job ${job} ${status}`, { source, counts });
      return respond({ ok: true, data: { job, status, counts, ms: Date.now() - started.getTime() } }, 200);
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
      return respond({ ok: false, error: unexpectedMessage(ref), ref }, 500);
    }
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

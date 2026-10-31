/**
 * Netlify Scheduled Function (§8): every 15 minutes it asks the app to run the scheduled jobs that
 * are due. The app works out what is due and runs it within one request's time limit
 * (app/api/cron/tick, server/jobs/due.ts); this only knocks, with the CRON_SECRET. When a check
 * leaves work over (a long job continues, or due jobs had to wait), it knocks once more while there
 * is time. Netlify runs scheduled functions on the published production deploy only, in UTC, and
 * stops them after 30 seconds.
 *
 * Needs CRON_SECRET in the site's environment variables (the same value the app checks).
 */

type ScheduledContext = { site?: { url?: string } };
type TickAnswer = {
  ok: boolean;
  data?: { ran?: Array<{ job: string; status: string; next: string | null }>; waiting?: string[] };
  ref?: string;
};

const LIMIT_MS = 30_000;
/** Don't knock again with less time than one check needs (Netlify stops a request at about 10 seconds). */
const KNOCK_MS = 12_000;

export default async function scheduler(_req: Request, context: ScheduledContext): Promise<Response> {
  const started = Date.now();
  const base = (context.site?.url || process.env.URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET?.trim();
  if (!base || !secret) {
    console.error("scheduler: CRON_SECRET or the site URL isn't set, so no scheduled job runs. Add CRON_SECRET in Site configuration → Environment variables.");
    return new Response(null, { status: 500 });
  }

  for (let knock = 1; knock <= 2; knock++) {
    const left = LIMIT_MS - (Date.now() - started) - 2_000;
    if (left < KNOCK_MS) break;
    let res: Response;
    try {
      res = await fetch(`${base}/api/cron/tick`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(left) });
    } catch (err) {
      console.error(`scheduler: ${base}/api/cron/tick didn't answer (${err instanceof Error ? err.message : String(err)}).`);
      break;
    }
    const body = (await res.json().catch(() => null)) as TickAnswer | null;
    if (!res.ok || !body?.ok) {
      console.error(`scheduler: the check failed with HTTP ${res.status}${body?.ref ? ` (Ref ${body.ref})` : ""}. Settings → Diagnostics shows each job's last run.`);
      break;
    }
    const ran = body.data?.ran ?? [];
    const waiting = body.data?.waiting ?? [];
    if (ran.length || waiting.length) {
      const done = ran.map((r) => `${r.job} ${r.status}${r.next ? " (continues)" : ""}`).join(", ");
      console.log(`scheduler: ran ${done || "nothing"}${waiting.length ? `; waiting: ${waiting.join(", ")}` : ""}.`);
    }
    if (waiting.length === 0 && !ran.some((r) => r.next)) break;
  }
  return new Response(null, { status: 204 });
}

export const config = { schedule: "*/15 * * * *" };

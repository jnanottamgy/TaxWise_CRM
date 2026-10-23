import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { todayIST } from "@/lib/domain/fy";
import { formatINR, toPaise } from "@/lib/domain/money";
import { RETAINER_DEFAULTS, RETAINER_SKIP_REASONS } from "@/lib/domain/invoice";
import { formatDate } from "@/lib/format";
import { log } from "@/lib/log";
import { notify } from "@/server/notify";

/**
 * Retainer billing, 09:30 IST daily (§7.9.6, §8): generate_retainer_drafts (0162) creates DRAFT
 * invoices (never sent) for every auto-invoiced engagement whose next billing date has come,
 * catching up at most 3 periods per engagement per run, advancing next_billing_date one cycle per
 * period, and counting every skipped engagement by its §7.9.6 reason (not enabled · service
 * inactive · client inactive or on hold · no agreed fee · one-time service · not yet due). It runs
 * in the database, one engagement at a time; an engagement that fails is rolled back on its own,
 * recorded in the run, counted as failed, and the rest go on.
 *
 * Then the Partners are told about the batch (§8 "notifies Partners of the batch"), deep-linked to
 * the Retainer drafts queue, including any engagement that hit the catch-up cap. Idempotent: a
 * second run the same day finds nothing due, and the notice's dedupe key names the run.
 */

type RunResult = {
  run_id: string;
  run_date: string;
  counts: Record<string, number>;
  capped: Array<{ client_name: string; service: string; periods_left: number }>;
  errors: Array<{ client_name: string; error: string }>;
  drafts_created: number;
  drafts_total: string;
};

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const { data, error } = await admin.rpc("generate_retainer_drafts", { p_today: today, p_max: RETAINER_DEFAULTS.maxPeriodsPerRun });
  if (error) throw error;
  const r = data as unknown as RunResult;
  const counts: Record<string, number> = { ...r.counts };
  // Every §7.9.6 reason is reported, zero included.
  for (const reason of RETAINER_SKIP_REASONS) counts[`skipped_${reason}`] = counts[`skipped_${reason}`] ?? 0;

  for (const e of r.errors ?? []) log("error", "retainer draft failed for an engagement", { source: "job:retainer-billing", runId: r.run_id, client: e.client_name, err: e.error });

  const drafts = r.drafts_created ?? 0;
  const capped = r.capped ?? [];
  if (drafts > 0 || capped.length > 0) {
    const parts: string[] = [];
    if (drafts > 0) parts.push(`${drafts} draft ${drafts === 1 ? "invoice" : "invoices"} for ${formatINR(toPaise(r.drafts_total ?? "0"))} ${drafts === 1 ? "is" : "are"} ready to check and issue. Nothing has been sent.`);
    if (capped.length > 0) {
      const names = capped.slice(0, 3).map((c) => `${c.client_name} (${c.service})`).join(", ");
      parts.push(`${capped.length} ${capped.length === 1 ? "engagement is" : "engagements are"} still behind after catching up 3 periods: ${names}${capped.length > 3 ? " and more" : ""}.`);
    }
    if ((r.errors ?? []).length > 0) parts.push(`${r.errors.length} couldn't be drafted; see the run on the queue.`);
    await notify({
      to: { roles: ["partner"] },
      type: "info",
      title: drafts > 0 ? `Retainer billing for ${formatDate(today)}: ${drafts} ${drafts === 1 ? "draft" : "drafts"} to issue` : `Retainer billing for ${formatDate(today)}: engagements behind`,
      body: parts.join(" "),
      linkUrl: `/retainer-drafts?run=${r.run_id}`,
      dedupeKey: `retainer_batch:${r.run_id}`,
    });
    counts.partners_notified = 1;
  }
  return { counts };
}

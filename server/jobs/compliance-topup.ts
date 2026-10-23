import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { todayIST } from "@/lib/domain/fy";
import { log, logUnexpected } from "@/lib/log";
import { fetchAll, loadComplianceEngine } from "@/server/compliance/engine";
import { generateForClient, loadClientCalendarFacts } from "@/server/compliance/generate";
import { firmCoverageGaps } from "@/server/compliance/coverage-gaps";
import { notify } from "@/server/notify";

/**
 * Compliance top-up, 08:30 IST on the 1st of each month (§8, §7.7): extends every client's planned
 * deadlines to 13 months ahead (annual ones to the end of next FY) through the same engine and
 * idempotent upsert as "Generate deadlines" (server/compliance/generate.ts), then reports coverage
 * gaps to Partners and Managers. Clients that are inactive or in the recycle bin are skipped. A
 * client that fails is logged with its Ref and the run continues (§8). Running it twice plans
 * nothing new and notifies once (the dedupe key names the month).
 */
export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const engine = await loadComplianceEngine(admin, today);
  const clients = await fetchAll((a, b) =>
    admin.from("clients").select("id").is("deleted_at", null).neq("status", "inactive").order("created_at").range(a, b),
  );

  const counts = { clients: 0, created: 0, updated: 0, locked: 0, retired: 0, failed: 0, gaps: 0, gapClients: 0, skippedRules: engine.skipped.length };
  for (const c of clients) {
    try {
      const facts = await loadClientCalendarFacts(admin, c.id, { system: true });
      if (!facts) continue;
      const r = await generateForClient(admin, c.id, { today, engine, facts, system: true, retire: true });
      if (!r) continue;
      counts.clients++;
      counts.created += r.created;
      counts.updated += r.updated;
      counts.locked += r.locked;
      counts.retired += r.retired;
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "job:compliance-topup:client", clientId: c.id });
    }
  }

  try {
    const gaps = await firmCoverageGaps(admin, engine, today, { classifyMax: 0, system: true });
    counts.gapClients = gaps.length;
    counts.gaps = gaps.reduce((n, g) => n + g.gaps.length, 0);
    if (gaps.length > 0) {
      const names = gaps.slice(0, 3).map((g) => g.clientName);
      const more = gaps.length > 3 ? ` and ${gaps.length - 3} more` : "";
      await notify({
        to: { roles: ["partner", "manager"] },
        type: "warning",
        title: `Coverage gaps: ${gaps.length} ${gaps.length === 1 ? "client has" : "clients have"} active services with nothing planned ahead`,
        body: `${names.join(", ")}${more}. Open the report to plan their deadlines in one click.`,
        linkUrl: "/filings?view=gaps",
        dedupeKey: `compliance_gaps:${today.slice(0, 7)}`,
      });
    }
  } catch (err) {
    logUnexpected(err, { source: "job:compliance-topup:gaps" });
  }

  if (engine.skipped.length) log("warn", "compliance top-up skipped unreadable law rows", { source: "job:compliance-topup", skipped: engine.skipped });
  return { counts };
}

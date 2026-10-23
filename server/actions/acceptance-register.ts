"use server";

import { z } from "zod";
import { defineAction } from "@/lib/action";
import { ok, type ActionResult } from "@/lib/result";
import { formatDateTime } from "@/lib/format";
import { todayIST } from "@/lib/domain/fy";
import { parseTableParams } from "@/components/app/data-table/params";
import { toCsv } from "@/lib/schemas/clients";
import { ACCEPTANCE_EXPORT_MAX, ACCEPTANCE_FILTERS, ACCEPTANCE_SORTABLE, listAcceptances } from "@/lib/data/acceptance";

/**
 * The client acceptance register (§7.5.4): Partner/Manager only (§4.1 "client acceptance
 * register"). Conflict checks are run and decided with server/actions/acceptance.ts (shared with
 * the onboarding wizard and the lead page); this module exports the register as it is filtered on
 * screen, with every decision, its matches, rationale and decider, and writes the export_run audit
 * row (§12 "Audit: every … export").
 */

const PM = ["partner", "manager"] as const;

const OUTCOME_WORDS = { pending: "Pending", accepted: "Accepted", declined: "Declined" } as const;

export type RegisterExport = { fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean };

export const exportAcceptanceRegister = defineAction(
  { name: "acceptance_register.export", schema: z.object({ query: z.string().max(2000).default("") }), roles: PM },
  async (input, ctx): Promise<ActionResult<RegisterExport>> => {
    const t = parseTableParams(new URLSearchParams(input.query), {
      sortable: ACCEPTANCE_SORTABLE,
      defaultSort: { sort: "created_at", dir: "desc" },
      filters: ACCEPTANCE_FILTERS,
    });
    const { rows, total } = await listAcceptances(ctx.supabase, { ...t, from: 0, to: ACCEPTANCE_EXPORT_MAX - 1 });
    const header = [
      "Checked on",
      "Prospect",
      "PAN",
      "GSTIN",
      "Related parties",
      "Matches found",
      "Matches",
      "Independence threat",
      "Decision",
      "Rationale",
      "Decided by",
      "Decided on",
      "Lead",
      "Client",
      "Checked by",
    ];
    const body = rows.map((r) => [
      formatDateTime(r.created_at),
      r.prospect_name,
      r.pan ?? "",
      r.gstin ?? "",
      r.related_parties.join("; "),
      r.conflict_count,
      r.conflicts.map((c) => `${c.title} (${c.reasons.join(" ")})`).join(" | "),
      r.independence_answers ? (r.independence_threat ? "Yes" : "No") : "",
      OUTCOME_WORDS[r.outcome],
      r.rationale ?? "",
      r.decided_by_name ?? "",
      r.decided_at ? formatDateTime(r.decided_at) : "",
      r.lead_number ? `${r.lead_number} ${r.lead_name ?? ""}`.trim() : "",
      r.client_code ? `${r.client_code} ${r.client_display_name ?? ""}`.trim() : "",
      r.created_by_name ?? "",
    ]);
    const truncated = total > rows.length;
    await ctx.audit({ event: "export_run", resourceType: "client_acceptances", details: { rows: rows.length, truncated, query: input.query } });
    return ok({
      fileName: `taxwise-acceptance-register-${todayIST()}.csv`,
      mimeType: "text/csv;charset=utf-8",
      base64: Buffer.from(toCsv(header, body), "utf8").toString("base64"),
      rows: rows.length,
      truncated,
    });
  },
);

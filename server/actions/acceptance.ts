"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import type { Json } from "@/lib/database.types";
import { freezeConflicts, parseRelatedParties, rationaleProblem, type ConflictHit } from "@/lib/domain/conflict";
import { AcceptanceCheckSchema, AcceptanceDecisionSchema, independenceThreat } from "@/lib/schemas/onboarding";
import { runConflictCheck } from "@/server/acceptance";
import { addTimelineEvent } from "@/server/timeline";

/**
 * Client acceptance (§7.5.4): run the conflict check (a pending `client_acceptances` row holding the
 * inputs and the latest hits), then decide Accept / Decline / Pending. A decision re-runs the check,
 * freezes `conflicts_found` with the decider (the 0112 trigger refuses any later change), and needs
 * a rationale when declining, when accepting despite a conflict, or when accepting attest work with
 * an independence threat (§6.8). Partner/Manager only (the register is theirs, §4.1).
 *
 * Used by the onboarding wizard (step 1) and by the lead page's "Run conflict check" (§7.5.1).
 */

const PM = ["partner", "manager"] as const;

export type AcceptanceCheck = {
  acceptanceId: string;
  updatedAt: string;
  hits: ConflictHit[];
  summary: string;
  checkedAt: string;
};

export const runAcceptanceCheck = defineAction(
  { name: "acceptance.check", schema: AcceptanceCheckSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<AcceptanceCheck>> => {
    const related = parseRelatedParties(input.relatedParties);
    const result = await runConflictCheck(ctx.supabase, {
      prospectName: input.prospectName,
      pan: input.pan,
      gstin: input.gstin,
      relatedParties: related,
      excludeClientId: input.clientId,
      excludeLeadId: input.leadId,
    });
    const row = {
      prospect_name: input.prospectName,
      pan: input.pan || null,
      gstin: input.gstin || null,
      related_parties: related,
      conflicts_found: freezeConflicts(result.hits) as unknown as Json,
      lead_id: input.leadId,
      client_id: input.clientId,
    };
    let id: string;
    let updatedAt: string;
    if (input.acceptanceId) {
      const { data, error } = await ctx.supabase
        .from("client_acceptances")
        .update(row)
        .eq("id", input.acceptanceId)
        .eq("outcome", "pending")
        .select("id, updated_at")
        .maybeSingle();
      throwIfDbError(error);
      if (!data) throw new ActionError("This conflict check is already decided. Start a new one to check again.", { code: "conflict" });
      id = data.id;
      updatedAt = data.updated_at;
    } else {
      const { data, error } = await ctx.supabase.from("client_acceptances").insert({ ...row, created_by: ctx.user.id }).select("id, updated_at").single();
      throwIfDbError(error);
      id = data!.id;
      updatedAt = data!.updated_at;
    }
    await ctx.audit({
      event: input.acceptanceId ? "data_update" : "data_create",
      resourceType: "client_acceptance",
      resourceId: id,
      action: "acceptance.check",
      details: { prospect_name: input.prospectName, hits: result.hits.length, related_parties: related.length },
    });
    return ok({ acceptanceId: id, updatedAt, hits: result.hits, summary: result.summary, checkedAt: result.checkedAt });
  },
);

export type AcceptanceDecision = {
  acceptanceId: string;
  outcome: "accepted" | "declined" | "pending";
  decidedAt: string | null;
  updatedAt: string;
  hits: ConflictHit[];
  summary: string;
};

export const decideAcceptance = defineAction(
  { name: "acceptance.decide", schema: AcceptanceDecisionSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<AcceptanceDecision>> => {
    const { data: acc, error } = await ctx.supabase
      .from("client_acceptances")
      .select("id, prospect_name, pan, gstin, related_parties, outcome, lead_id, client_id, updated_at")
      .eq("id", input.acceptanceId)
      .maybeSingle();
    throwIfDbError(error);
    if (!acc) return fail("That conflict check no longer exists. Run it again.", { code: "not_found" });
    if (acc.outcome !== "pending") return fail("This decision is already recorded and can't be changed. Run a new conflict check.", { code: "conflict" });
    if (acc.updated_at !== input.updatedAt) return fail("The check was run again since you opened it. Review the latest results, then decide.", { code: "conflict" });

    // The decision is taken on the check as it stands now (§7.5.4 "Frozen with conflicts_found").
    const fresh = await runConflictCheck(ctx.supabase, {
      prospectName: acc.prospect_name,
      pan: acc.pan,
      gstin: acc.gstin,
      relatedParties: acc.related_parties,
      excludeClientId: acc.client_id,
      excludeLeadId: acc.lead_id,
    });
    if (input.attest && input.outcome === "accepted" && !input.independence) {
      return fail("Answer the independence questions before accepting audit work.", { code: "validation", fieldErrors: { independence: ["Answer each question."] } });
    }
    const problem =
      rationaleProblem(input.outcome, fresh.hits.length, input.rationale) ??
      (input.outcome === "accepted" && independenceThreat(input.independence) && !input.rationale
        ? "Explain how the independence threat is addressed before accepting."
        : null);
    if (problem) return fail(problem, { code: "validation", fieldErrors: { rationale: [problem] } });

    const { data: saved, error: saveErr } = await ctx.supabase
      .from("client_acceptances")
      .update({
        outcome: input.outcome,
        rationale: input.rationale || null,
        conflicts_found: freezeConflicts(fresh.hits) as unknown as Json,
        independence_answers: (input.independence ?? null) as unknown as Json,
      })
      .eq("id", acc.id)
      .eq("updated_at", acc.updated_at)
      .select("id, outcome, decided_at, updated_at")
      .maybeSingle();
    throwIfDbError(saveErr);
    if (!saved) return fail("Someone else decided this check a moment ago. Reload to see it.", { code: "conflict" });

    await ctx.audit({
      event: "data_update",
      resourceType: "client_acceptance",
      resourceId: acc.id,
      action: "acceptance.decide",
      details: { outcome: input.outcome, hits: fresh.hits.length, rationale: input.rationale || null, independence: input.independence },
    });
    if (acc.lead_id && input.outcome !== "pending") {
      const word = input.outcome === "accepted" ? "Accept" : "Decline";
      ctx.after("Add to the lead's timeline", () =>
        addTimelineEvent({
          leadId: acc.lead_id,
          clientId: acc.client_id,
          eventType: "lead_conflict_check",
          title: `Conflict check decided: ${word}`,
          description: fresh.summary,
        }),
      );
    }
    return ok({
      acceptanceId: acc.id,
      outcome: saved.outcome,
      decidedAt: saved.decided_at,
      updatedAt: saved.updated_at,
      hits: fresh.hits,
      summary: fresh.summary,
    });
  },
);

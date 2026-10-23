import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import {
  CONFLICT_KINDS,
  classifyConflicts,
  parseRelatedParties,
  summariseConflicts,
  type ConflictCandidate,
  type ConflictHit,
  type ConflictKind,
} from "@/lib/domain/conflict";

/**
 * The conflict check service (§7.5.4), shared by the onboarding wizard (§7.3.2 step 1) and the
 * lead's "Run conflict check" (§7.5.1). It searches existing clients (the recycle bin too), leads,
 * every client's contacts, KYC principal persons, earlier related parties and client groups through
 * `conflict_candidates` (0112) under the caller's session (Partner/Manager: RLS and the function
 * both refuse anyone else), then classifies the candidates with lib/domain/conflict.ts so each hit
 * says why it matched.
 *
 *   const { hits, summary } = await runConflictCheck(ctx.supabase, {
 *     prospectName: "Gupta Foods", pan: "AAECG1234K", relatedParties: ["Ramesh Gupta"], excludeLeadId: lead.id,
 *   });
 */

export type ConflictCheckInput = {
  prospectName: string;
  pan?: string | null;
  gstin?: string | null;
  relatedParties?: readonly string[];
  /** Leave out the client being edited / the lead being checked (it would match itself). */
  excludeClientId?: string | null;
  excludeLeadId?: string | null;
};

export type ConflictCheckResult = {
  hits: ConflictHit[];
  summary: string;
  /** ISO timestamp of the check. */
  checkedAt: string;
};

export async function runConflictCheck(supabase: ServerSupabase, input: ConflictCheckInput): Promise<ConflictCheckResult> {
  const related = parseRelatedParties(input.relatedParties);
  const { data, error } = await supabase.rpc("conflict_candidates", {
    p_name: input.prospectName.trim(),
    p_pan: input.pan?.trim() || null,
    p_gstin: input.gstin?.trim() || null,
    p_related: related,
    p_exclude_client: input.excludeClientId ?? null,
    p_exclude_lead: input.excludeLeadId ?? null,
  });
  if (error) throw error;
  const candidates: ConflictCandidate[] = (data ?? [])
    .filter((r) => r.kind && (CONFLICT_KINDS as readonly string[]).includes(r.kind) && r.record_id)
    .map((r) => ({
      kind: r.kind as ConflictKind,
      recordId: r.record_id as string,
      clientId: r.client_id,
      leadId: r.lead_id,
      label: r.label ?? "",
      code: r.code,
      pan: r.pan,
      gstin: r.gstin,
      din: r.din,
      candidateName: r.candidate_name,
      inRecycleBin: Boolean(r.in_recycle_bin),
    }));
  const hits = classifyConflicts({ prospectName: input.prospectName, pan: input.pan, gstin: input.gstin, relatedParties: related }, candidates);
  return { hits, summary: summariseConflicts(hits), checkedAt: new Date().toISOString() };
}

import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Enums, Json } from "@/lib/database.types";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { isDateString } from "@/lib/domain/fy";

/**
 * The client acceptance register (§7.5.4): every conflict check and its decision, with the
 * matches frozen at decision time, the decider, and the lead or client it belongs to. Partner /
 * Manager only (RLS on client_acceptances, 0034/0112; §4.1 "client acceptance register").
 */

export const ACCEPTANCE_SORTABLE = ["created_at", "decided_at", "prospect_name", "outcome", "conflict_count"] as const;
export type AcceptanceSort = (typeof ACCEPTANCE_SORTABLE)[number];

export const ACCEPTANCE_FILTERS = {
  outcome: ["pending", "accepted", "declined"],
  conflicts: ["with", "none"],
  from: null,
  to: null,
} as const;
export type AcceptanceFilter = keyof typeof ACCEPTANCE_FILTERS;

export type FrozenHit = { kind: string; title: string; strength: string; reasons: string[]; client_id: string | null; lead_id: string | null };

export type AcceptanceRow = {
  id: string;
  prospect_name: string;
  pan: string | null;
  gstin: string | null;
  related_parties: string[];
  conflict_count: number;
  conflicts: FrozenHit[];
  independence_answers: Record<string, string> | null;
  independence_threat: boolean;
  outcome: Enums<"acceptance_outcome">;
  rationale: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  lead_id: string | null;
  lead_number: string | null;
  lead_name: string | null;
  client_id: string | null;
  client_code: string | null;
  client_display_name: string | null;
  created_by_name: string | null;
  created_at: string;
};

const COLUMNS =
  "id, prospect_name, pan, gstin, related_parties, conflict_count, conflicts_found, independence_answers, independence_threat, outcome, rationale, decided_by_name, decided_at, lead_id, lead_number, lead_name, client_id, client_code, client_display_name, created_by_name, created_at";

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

function hits(raw: Json | null): FrozenHit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((h) => {
    if (!h || typeof h !== "object" || Array.isArray(h)) return [];
    const o = h as Record<string, unknown>;
    return [
      {
        kind: String(o.kind ?? ""),
        title: String(o.title ?? ""),
        strength: String(o.strength ?? "possible"),
        reasons: Array.isArray(o.reasons) ? o.reasons.map(String) : [],
        client_id: typeof o.client_id === "string" ? o.client_id : null,
        lead_id: typeof o.lead_id === "string" ? o.lead_id : null,
      },
    ];
  });
}

function answers(raw: Json | null): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

/** IST day bounds for the date filter: `from` at 00:00 IST, `to` through 23:59 IST. */
function istStart(date: string): string {
  return new Date(`${date}T00:00:00+05:30`).toISOString();
}
function istEnd(date: string): string {
  return new Date(new Date(`${date}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();
}

/** Most rows an export of the register carries. */
export const ACCEPTANCE_EXPORT_MAX = 5000;

export async function listAcceptances(
  supabase: ServerSupabase,
  t: Pick<TableParams<AcceptanceSort, AcceptanceFilter>, "q" | "filters" | "sort" | "dir" | "from" | "to">,
): Promise<{ rows: AcceptanceRow[]; total: number }> {
  let q = supabase.from("client_acceptances_list").select(COLUMNS, { count: "exact" });
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(["prospect_name", "pan", "gstin", "lead_number", "lead_name", "client_code", "client_display_name", "rationale"].map((c) => `${c}.ilike.${like}`).join(","));
  }
  const f = t.filters;
  if (f.outcome) q = q.in("outcome", f.outcome as Array<Enums<"acceptance_outcome">>);
  if (f.conflicts?.length === 1) q = f.conflicts[0] === "with" ? q.gt("conflict_count", 0) : q.eq("conflict_count", 0);
  const from = f.from?.[0];
  const to = f.to?.[0];
  if (from && isDateString(from)) q = q.gte("created_at", istStart(from));
  if (to && isDateString(to)) q = q.lt("created_at", istEnd(to));
  const sort = t.sort ?? "created_at";
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false });
  if (sort !== "created_at") q = q.order("created_at", { ascending: false });
  const { data, error, count } = await q.order("id").range(t.from, t.to);
  if (error) throw error;
  return {
    rows: (data ?? []).map((r) => ({
      id: r.id as string,
      prospect_name: r.prospect_name ?? "",
      pan: r.pan ? String(r.pan) : null,
      gstin: r.gstin ? String(r.gstin) : null,
      related_parties: r.related_parties ?? [],
      conflict_count: Number(r.conflict_count ?? 0),
      conflicts: hits(r.conflicts_found),
      independence_answers: answers(r.independence_answers),
      independence_threat: Boolean(r.independence_threat),
      outcome: r.outcome as Enums<"acceptance_outcome">,
      rationale: r.rationale,
      decided_by_name: r.decided_by_name,
      decided_at: r.decided_at,
      lead_id: r.lead_id,
      lead_number: r.lead_number,
      lead_name: r.lead_name,
      client_id: r.client_id,
      client_code: r.client_code,
      client_display_name: r.client_display_name,
      created_by_name: r.created_by_name,
      created_at: r.created_at as string,
    })),
    total: count ?? 0,
  };
}

export type AcceptanceSummary = { total: number; pending: number; accepted: number; declined: number; withConflicts: number };

export async function getAcceptanceSummary(supabase: ServerSupabase): Promise<AcceptanceSummary> {
  const base = () => supabase.from("client_acceptances_list").select("id", { count: "exact", head: true });
  const [all, pending, accepted, declined, conflicts] = await Promise.all([
    base(),
    base().eq("outcome", "pending"),
    base().eq("outcome", "accepted"),
    base().eq("outcome", "declined"),
    base().gt("conflict_count", 0),
  ]);
  for (const r of [all, pending, accepted, declined, conflicts]) if (r.error) throw r.error;
  return { total: all.count ?? 0, pending: pending.count ?? 0, accepted: accepted.count ?? 0, declined: declined.count ?? 0, withConflicts: conflicts.count ?? 0 };
}

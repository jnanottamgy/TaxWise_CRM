import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";
import type { TableParams } from "@/components/app/data-table/params";
import { AUDIT_EVENTS } from "@/lib/domain/enums";
import { addDays, isDateString, type DateString } from "@/lib/domain/fy";

/**
 * Reads for the audit log (§7.20), under the caller's session: audit_log_page and audit_log_facets
 * (0212) answer Partners only, and the audit_logs RLS (0039) says the same for a direct read.
 * Filters, search, sort and the page run in SQL (§2.3). Nothing here writes; the log is insert-only.
 */

export type AuditRow = {
  id: string;
  at: string;
  event: string;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  user_name: string | null;
  ip: string | null;
  user_agent: string | null;
  resource_type: string | null;
  resource_id: string | null;
  action: string | null;
  success: boolean;
  error: string | null;
  details: Json | null;
};

export const AUDIT_PERIODS = ["today", "7", "30", "90"] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];
export const AUDIT_PERIOD_LABEL: Readonly<Record<AuditPeriod, string>> = { today: "Today", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" };

export const AUDIT_FILTERS = {
  event: AUDIT_EVENTS,
  user: null,
  resource: null,
  outcome: ["success", "failure"],
  period: AUDIT_PERIODS,
  from: null,
  to: null,
  resource_id: null,
} as const;
export type AuditFilter = keyof typeof AUDIT_FILTERS;

export const AUDIT_SORTABLE = ["at"] as const;
export type AuditSort = (typeof AUDIT_SORTABLE)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The audit_log_page parameters for the page's URL state (also used by the CSV export). */
export function auditQueryParams(t: Pick<TableParams<AuditSort, AuditFilter>, "q" | "filters" | "dir">, today: DateString): Record<string, unknown> {
  const one = (k: AuditFilter) => t.filters[k]?.[0] ?? null;
  const user = one("user");
  const period = one("period") as AuditPeriod | null;
  let from = one("from");
  let to = one("to");
  if (!isDateString(from)) from = null;
  if (!isDateString(to)) to = null;
  if (!from && !to && period) {
    to = today;
    from = period === "today" ? today : addDays(today, -(Number(period) - 1));
  }
  const outcome = one("outcome");
  const resourceId = one("resource_id");
  return {
    user_id: user && UUID.test(user) ? user : null,
    system: user === "system",
    events: t.filters.event ?? [],
    resource_type: one("resource"),
    resource_id: resourceId ? resourceId.slice(0, 200) : null,
    success: outcome === "success" ? true : outcome === "failure" ? false : null,
    from,
    to,
    q: t.q || null,
    dir: t.dir === "asc" ? "asc" : "desc",
  };
}

export async function listAuditLog(
  supabase: ServerSupabase,
  params: Record<string, unknown>,
  page: { offset: number; limit: number },
): Promise<{ rows: AuditRow[]; total: number }> {
  const { data, error } = await supabase.rpc("audit_log_page", { p_params: { ...params, offset: page.offset, limit: page.limit } as unknown as Json });
  if (error) throw error;
  const r = (data ?? {}) as { total?: number; rows?: AuditRow[] };
  return { rows: r.rows ?? [], total: Number(r.total ?? 0) };
}

export type AuditFacets = {
  users: Array<{ value: string; label: string }>;
  resourceTypes: string[];
  hasSystem: boolean;
};

export async function getAuditFacets(supabase: ServerSupabase): Promise<AuditFacets> {
  const { data, error } = await supabase.rpc("audit_log_facets");
  if (error) throw error;
  const r = (data ?? {}) as {
    users?: Array<{ id: string; email: string | null; role: string | null; name: string | null }>;
    resource_types?: Array<{ value: string }>;
    has_system?: boolean;
  };
  return {
    users: (r.users ?? []).map((u) => ({ value: u.id, label: u.name ? `${u.name}${u.email ? ` (${u.email})` : ""}` : (u.email ?? "Someone whose account was removed") })),
    resourceTypes: (r.resource_types ?? []).map((x) => x.value).filter(Boolean),
    hasSystem: Boolean(r.has_system),
  };
}

/** One entry, for the drawer opened from a link (`?entry=`). */
export async function getAuditEntry(supabase: ServerSupabase, id: string): Promise<AuditRow | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, at, event, user_id, user_email, user_role, ip, user_agent, resource_type, resource_id, action, success, error, details")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let name: string | null = null;
  if (data.user_id) {
    const { data: p } = await supabase.from("profiles").select("full_name").eq("id", data.user_id).maybeSingle();
    name = p?.full_name ?? null;
  }
  return { ...(data as Omit<AuditRow, "user_name">), user_name: name };
}

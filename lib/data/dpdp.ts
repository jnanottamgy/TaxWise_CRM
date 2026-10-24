import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Tables } from "@/lib/database.types";
import type { TableParams } from "@/components/app/data-table/params";
import { escapeLike } from "@/components/app/data-table/params";
import type { DateString } from "@/lib/domain/fy";
import { DATA_REQUEST_SORTABLE } from "@/lib/schemas/dpdp";

/**
 * Reads for data protection (§6.10): privacy notice versions, consent records, data requests and
 * incidents, under the caller's session. Partners and Managers read them (0039); Partners write
 * (0197). Consent records name who gave them; for a lead or a client contact that name comes from
 * tables only Partners and Managers read, so nothing here reaches an Employee.
 */

// =================================================================================================
// Privacy notices
// =================================================================================================

export type NoticeRow = Tables<"privacy_notices"> & { created_by_name: string | null; published_by_name: string | null; acknowledgements: number };

export async function listNotices(supabase: ServerSupabase): Promise<NoticeRow[]> {
  const { data, error } = await supabase
    .from("privacy_notices")
    .select("*, creator:created_by(full_name), publisher:published_by(full_name)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<Tables<"privacy_notices"> & { creator: { full_name: string } | null; publisher: { full_name: string } | null }>;
  const versions = rows.filter((r) => r.published_at).map((r) => r.version);
  const counts = new Map<string, number>();
  if (versions.length) {
    const results = await Promise.all(
      versions.map((v) => supabase.from("consent_records").select("id", { count: "exact", head: true }).eq("notice_version", v).is("withdrawn_at", null)),
    );
    results.forEach((r, i) => {
      if (r.error) throw r.error;
      counts.set(versions[i], r.count ?? 0);
    });
  }
  return rows.map(({ creator, publisher, ...r }) => ({ ...r, created_by_name: creator?.full_name ?? null, published_by_name: publisher?.full_name ?? null, acknowledgements: counts.get(r.version) ?? 0 }));
}

// =================================================================================================
// Consent records
// =================================================================================================

export type ConsentRow = Tables<"consent_records"> & { subject_name: string | null };

const CONSENT_SORTABLE = ["given_at", "withdrawn_at", "notice_version"] as const;

export async function listConsents(supabase: ServerSupabase, t: TableParams<string, "subject" | "state" | "version">): Promise<{ rows: ConsentRow[]; total: number }> {
  let q = supabase.from("consent_records").select("*", { count: "exact" });
  if (t.filters.subject?.length) q = q.in("subject_type", t.filters.subject);
  if (t.filters.version?.[0]) q = q.eq("notice_version", t.filters.version[0]);
  if (t.filters.state?.[0] === "live") q = q.is("withdrawn_at", null);
  if (t.filters.state?.[0] === "withdrawn") q = q.not("withdrawn_at", "is", null);
  const sort = t.sort && (CONSENT_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "given_at";
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("id");
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  const rows = data ?? [];

  // Who each record is about, by type.
  const byType = new Map<string, string[]>();
  for (const r of rows) byType.set(r.subject_type, [...(byType.get(r.subject_type) ?? []), r.subject_id]);
  const names = new Map<string, string>();
  const lookups: Array<PromiseLike<void>> = [];
  const add = (ids: string[] | undefined, load: (ids: string[]) => PromiseLike<{ data: Array<{ id: string; name: string }> | null; error: unknown }>) => {
    if (!ids?.length) return;
    lookups.push(
      load(ids).then((r) => {
        if (r.error) throw r.error;
        for (const x of r.data ?? []) names.set(x.id, x.name);
      }),
    );
  };
  add(byType.get("portal_user"), (ids) =>
    supabase.from("profiles").select("id, full_name").in("id", ids).then((r) => ({ data: (r.data ?? []).map((p) => ({ id: p.id, name: p.full_name })), error: r.error })),
  );
  add(byType.get("employee"), (ids) =>
    supabase.from("employees").select("id, full_name").in("id", ids).then((r) => ({ data: (r.data ?? []).map((p) => ({ id: p.id, name: p.full_name })), error: r.error })),
  );
  add(byType.get("client_contact"), (ids) =>
    supabase.from("client_contacts").select("id, name").in("id", ids).then((r) => ({ data: (r.data ?? []).map((p) => ({ id: p.id, name: p.name })), error: r.error })),
  );
  add(byType.get("lead"), (ids) =>
    supabase.from("leads").select("id, name").in("id", ids).then((r) => ({ data: (r.data ?? []).map((p) => ({ id: p.id as string, name: String(p.name) })), error: r.error })),
  );
  await Promise.all(lookups);
  return { rows: rows.map((r) => ({ ...r, subject_name: names.get(r.subject_id) ?? null })), total: count ?? 0 };
}

/** The notice versions (for the consent filter). */
export async function listNoticeVersions(supabase: ServerSupabase): Promise<string[]> {
  const { data, error } = await supabase.from("privacy_notices").select("version, published_at").not("published_at", "is", null).order("published_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).map((r) => r.version);
}

// =================================================================================================
// Data requests
// =================================================================================================

export type DataRequestRow = Tables<"data_requests_view">;

export async function listDataRequests(supabase: ServerSupabase, t: TableParams<(typeof DATA_REQUEST_SORTABLE)[number], "status" | "type">, today: DateString): Promise<{ rows: DataRequestRow[]; total: number }> {
  void today;
  const sort = t.sort && (DATA_REQUEST_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "due_by";
  let q = supabase.from("data_requests_view").select("*", { count: "exact" });
  if (t.q) {
    const like = `%${escapeLike(t.q)}%`;
    q = q.or(`subject.ilike.${like},contact.ilike.${like},details.ilike.${like}`);
  }
  const statuses = t.filters.status ?? [];
  if (statuses.includes("overdue")) q = q.eq("is_overdue", true);
  else if (statuses.includes("open_all")) q = q.eq("is_open", true);
  else if (statuses.length) q = q.in("status", statuses);
  if (t.filters.type?.length) q = q.in("type", t.filters.type);
  q = q.order(sort, { ascending: t.dir === "asc", nullsFirst: false }).order("id");
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

export async function getDataRequest(supabase: ServerSupabase, id: string): Promise<DataRequestRow | null> {
  const { data, error } = await supabase.from("data_requests_view").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// =================================================================================================
// Incidents
// =================================================================================================

export type IncidentRow = Tables<"data_incidents_view">;

export async function listIncidents(supabase: ServerSupabase, opts: { open?: boolean } = {}): Promise<IncidentRow[]> {
  let q = supabase.from("data_incidents_view").select("*");
  if (opts.open) q = q.eq("is_open", true);
  const { data, error } = await q.order("detected_at", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

/** Active Partners by profile id: who can handle a data request (data_requests.handled_by). */
export async function listPartnerProfiles(supabase: ServerSupabase): Promise<Array<{ value: string; label: string }>> {
  const { data, error } = await supabase.from("profiles").select("id, full_name").eq("role", "partner").eq("is_active", true).order("full_name").limit(50);
  if (error) throw error;
  return (data ?? []).map((p) => ({ value: p.id, label: p.full_name }));
}

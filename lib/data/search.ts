import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";
import { documentsHref } from "@/components/documents/doc-urls";
import { SEARCH_MIN_LENGTH, SEARCH_TYPE_LABEL, isSearchType, normaliseQuery, searchTypesFor, type SearchType } from "@/lib/schemas/search";

/**
 * Reads for global search (§7.18), under the caller's session: search_everything (0210) runs as the
 * caller, so RLS decides what each person finds, and leads, invoices and quotations are searched for
 * Partners and Managers only. Each hit gets the link to the exact record.
 */

export type SearchHit = {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  clientId: string | null;
};

export type SearchGroupResult = {
  type: SearchType;
  /** Plural, sentence case: "Clients". */
  label: string;
  total: number;
  items: SearchHit[];
};

type RawItem = { id: string; title: string; subtitle: string | null; client_id: string | null };
type RawGroup = { type: string; total: number; items: RawItem[] };

/** The link to one result (§7.18 "deep link to the exact record"). */
export function searchHref(type: SearchType, item: { id: string; client_id: string | null }, role: AppRole): string {
  switch (type) {
    case "client":
      return `/clients/${item.id}`;
    case "contact":
      return item.client_id ? `/clients/${item.client_id}?tab=profile` : "/clients";
    case "task":
      return `/work/${item.id}`;
    case "document":
      return item.client_id ? documentsHref(item.client_id, { doc: item.id }) : "/clients";
    case "employee":
      // An Employee finds only their own record (RLS), which lives on their profile.
      return role === "employee" ? "/profile" : `/people/${item.id}`;
    case "lead":
      return `/leads/${item.id}`;
    case "invoice":
      return `/invoices/${item.id}`;
    case "quotation":
      return `/quotations/${item.id}`;
  }
}

export async function searchEverything(
  supabase: ServerSupabase,
  role: AppRole,
  rawQuery: string,
  opts: { limit?: number; types?: readonly SearchType[] | null; offset?: number } = {},
): Promise<{ query: string; groups: SearchGroupResult[] }> {
  const query = normaliseQuery(rawQuery);
  const allowed = searchTypesFor(role);
  const types = (opts.types && opts.types.length ? opts.types : allowed).filter((t) => allowed.includes(t));
  if (query.length < SEARCH_MIN_LENGTH || types.length === 0) return { query, groups: [] };

  const { data, error } = await supabase.rpc("search_everything", {
    p_q: query,
    p_limit_per_type: opts.limit ?? 5,
    p_types: types,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw error;
  const raw = ((data ?? {}) as { groups?: RawGroup[] }).groups ?? [];
  const groups: SearchGroupResult[] = [];
  for (const g of raw) {
    if (!isSearchType(g.type) || !allowed.includes(g.type)) continue;
    groups.push({
      type: g.type,
      label: SEARCH_TYPE_LABEL[g.type].many,
      total: Number(g.total ?? 0),
      items: (g.items ?? []).map((i) => ({
        id: i.id,
        title: i.title,
        subtitle: i.subtitle ?? null,
        href: searchHref(g.type as SearchType, i, role),
        clientId: i.client_id ?? null,
      })),
    });
  }
  return { query, groups };
}

export type RecentSearch = { id: string; query: string; searchedAt: string };

/** The signed-in person's recent searches, newest first (recent_searches, RLS: own rows only). */
export async function listRecentSearches(supabase: ServerSupabase, userId: string, limit = 8): Promise<RecentSearch[]> {
  const { data, error } = await supabase
    .from("recent_searches")
    .select("id, query, searched_at")
    .eq("user_id", userId)
    .order("searched_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, query: r.query, searchedAt: r.searched_at }));
}

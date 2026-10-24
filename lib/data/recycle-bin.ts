import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { TableParams } from "@/components/app/data-table/params";
import { escapeLike } from "@/components/app/data-table/params";
import { addDays, istDayBounds, type DateString } from "@/lib/domain/fy";
import { BIN_PERIODS, BIN_SORTABLE, isBinEntity, type BinEntity, type BinPeriod, type BinSort } from "@/components/recycle-bin/entities";

/**
 * Reads for the recycle bin (§7.19), under the caller's session: recycle_bin_items (0211) shows
 * Partners and Managers every soft-deleted client, task, document, invoice, lead and quotation, and
 * nobody else anything. What went into the bin with its client is counted on the client's row and
 * not listed on its own. Search, filters, sort and the page run in SQL (§2.3).
 */

export type BinRow = {
  entity: BinEntity;
  id: string;
  title: string;
  reference: string | null;
  client_id: string | null;
  client_name: string | null;
  lead_id: string | null;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_name: string | null;
  updated_at: string;
  retention_until: DateString | null;
  parent_in_bin: boolean;
  tasks_with: number;
  documents_with: number;
  invoices_with: number;
};

export type BinBlocker = { code: string; message: string; until?: DateString | null };

export type BinFilter = "entity" | "deleted_by" | "period";

export const BIN_FILTERS = { entity: null, deleted_by: null, period: BIN_PERIODS } as const;

const COLUMNS =
  "entity, id, title, reference, client_id, client_name, lead_id, deleted_at, deleted_by, deleted_by_name, updated_at, retention_until, parent_in_bin, tasks_with, documents_with, invoices_with";

/** An ilike pattern for PostgREST's `or()` (quoted, so commas and brackets in the search are text). */
function orIlike(columns: readonly string[], q: string): string {
  const like = `%${escapeLike(q)}%`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return columns.map((c) => `${c}.ilike."${like}"`).join(",");
}

export async function listRecycleBin(
  supabase: ServerSupabase,
  t: TableParams<BinSort, BinFilter>,
  today: DateString,
): Promise<{ rows: BinRow[]; total: number }> {
  let query = supabase.from("recycle_bin_items").select(COLUMNS, { count: "exact" }).eq("with_client", false);
  const entities = (t.filters.entity ?? []).filter(isBinEntity);
  if (entities.length) query = query.in("entity", entities);
  const by = t.filters.deleted_by?.[0];
  if (by && /^[0-9a-f-]{36}$/i.test(by)) query = query.eq("deleted_by", by);
  const period = t.filters.period?.[0] as BinPeriod | undefined;
  if (period && (BIN_PERIODS as readonly string[]).includes(period)) {
    query = query.gte("deleted_at", istDayBounds(addDays(today, -(Number(period) - 1))).start.toISOString());
  }
  if (t.q) query = query.or(orIlike(["title", "reference", "client_name"], t.q));

  const sort: BinSort = t.sort && (BIN_SORTABLE as readonly string[]).includes(t.sort) ? t.sort : "deleted_at";
  query = query.order(sort, { ascending: t.dir === "asc" });
  if (sort !== "deleted_at") query = query.order("deleted_at", { ascending: false });
  query = query.order("id", { ascending: true }).range(t.from, t.to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as BinRow[], total: count ?? 0 };
}

/** How many items each kind has in the bin (for the filter's labels and the header). */
export async function getRecycleBinCounts(supabase: ServerSupabase): Promise<Record<BinEntity, number>> {
  const { data, error } = await supabase.from("recycle_bin_items").select("entity").eq("with_client", false).limit(10000);
  if (error) throw error;
  const out: Record<BinEntity, number> = { client: 0, task: 0, document: 0, invoice: 0, lead: 0, quotation: 0 };
  for (const r of data ?? []) if (isBinEntity(r.entity)) out[r.entity] += 1;
  return out;
}

/** The people who deleted what is in the bin, for the "Deleted by" filter. */
export async function listBinDeleters(supabase: ServerSupabase): Promise<Array<{ value: string; label: string }>> {
  const { data, error } = await supabase.from("recycle_bin_items").select("deleted_by, deleted_by_name").eq("with_client", false).not("deleted_by", "is", null).limit(10000);
  if (error) throw error;
  const seen = new Map<string, string>();
  for (const r of data ?? []) if (r.deleted_by && !seen.has(r.deleted_by)) seen.set(r.deleted_by, r.deleted_by_name ?? "Someone no longer with the firm");
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Why each row can't be purged yet (recycle_bin_blockers, 0211), for the rows on screen. Only a
 * Partner purges, so only a Partner's page asks.
 */
export async function getPurgeBlockers(supabase: ServerSupabase, rows: ReadonlyArray<Pick<BinRow, "entity" | "id">>): Promise<Map<string, BinBlocker[]>> {
  const out = new Map<string, BinBlocker[]>();
  await Promise.all(
    rows.map(async (r) => {
      const { data, error } = await supabase.rpc("recycle_bin_blockers", { p_entity: r.entity, p_id: r.id });
      if (error) throw error;
      out.set(`${r.entity}:${r.id}`, ((data ?? []) as unknown as BinBlocker[]).filter((b) => b && typeof b.message === "string"));
    }),
  );
  return out;
}

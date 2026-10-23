import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import { isManagerOrPartner } from "@/lib/auth/roles";
import { DOCUMENT_CATEGORIES, type DocumentCategory, type DocumentActivity, type EntityType } from "@/lib/domain/enums";
import { isFinancialYear } from "@/lib/domain/fy";
import { escapeLike, parseTableParams, readParam, type SearchParamsInput, type SortDir } from "@/components/app/data-table/params";
import { EXPIRING_WITHIN_DAYS, VAULT_PARAM, VAULT_SORTS, type VaultSort } from "@/lib/schemas/documents";
import { addDays, todayIST } from "@/lib/domain/fy";

/**
 * Reads for the document vault (§7.14, Client 360 → Documents), under the caller's RLS (§4.6): staff
 * see the documents of clients they can see; confidential files follow the same rule (an Employee
 * sees a client only as its owner, a team member or a cover in force, i.e. its engagement team).
 * Recycle-bin documents are listed only for Partners and Managers (§7.19), only when asked.
 * Pagination, sort, filters and search happen in SQL (§2.3).
 */

export interface VaultRow {
  id: string;
  title: string;
  category: DocumentCategory;
  financial_year: string | null;
  period: string | null;
  description: string | null;
  file_name: string;
  file_size: number;
  mime_type: string;
  version: number;
  source: string;
  is_confidential: boolean;
  shareable_with_client: boolean;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  updated_at: string;
  expiry_date: string | null;
  renewal_date: string | null;
  retention_until: string | null;
  deleted_at: string | null;
  tags: string[];
}

export interface VaultParams {
  q: string;
  category: DocumentCategory | null;
  /** An FY label, "none" for documents without one, or null for all. */
  fy: string | null;
  layout: "list" | "grid";
  bin: boolean;
  /** Only documents whose expiry or renewal date is within EXPIRING_WITHIN_DAYS (or past). */
  expiring: boolean;
  page: number;
  pageSize: 25 | 50 | 100;
  sort: VaultSort;
  dir: SortDir;
  from: number;
  to: number;
}

/** Reads the vault's URL state (the kit's table params plus `dcat`, `dfy`, `dview`, `dbin`). Never throws. */
export function parseVaultParams(sp: SearchParamsInput, opts: { canSeeBin: boolean }): VaultParams {
  const t = parseTableParams(sp, { sortable: VAULT_SORTS, defaultSort: { sort: "created_at", dir: "desc" } });
  const cat = readParam(sp, VAULT_PARAM.category);
  const fy = readParam(sp, VAULT_PARAM.fy);
  return {
    q: t.q,
    category: cat && (DOCUMENT_CATEGORIES as readonly string[]).includes(cat) ? (cat as DocumentCategory) : null,
    fy: fy === "none" || (fy && isFinancialYear(fy)) ? fy : null,
    layout: readParam(sp, VAULT_PARAM.layout) === "grid" ? "grid" : "list",
    bin: opts.canSeeBin && readParam(sp, VAULT_PARAM.bin) === "1",
    expiring: readParam(sp, VAULT_PARAM.expiring) === "1",
    page: t.page,
    pageSize: t.pageSize,
    sort: (t.sort ?? "created_at") as VaultSort,
    dir: t.dir,
    from: t.from,
    to: t.to,
  };
}

/** Search text that is safe inside a PostgREST or() filter (its separators and quotes removed). */
function orSafe(q: string): string {
  return q.replace(/[,()"\\:*]/g, " ").replace(/\s+/g, " ").trim();
}

const VAULT_COLUMNS =
  "id, title, category, financial_year, period, description, file_name, file_size, mime_type, version, source, is_confidential, shareable_with_client, uploaded_by, created_at, updated_at, expiry_date, renewal_date, retention_until, deleted_at";

/** Names for profile ids from the staff directory; portal uploaders aren't in it (shown as "the client"). */
export async function profileNames(supabase: ServerSupabase, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((i): i is string => !!i)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await supabase.from("employee_directory").select("profile_id, full_name").in("profile_id", unique);
  if (error) throw error;
  for (const r of data ?? []) if (r.profile_id) out.set(r.profile_id, r.full_name ?? "");
  return out;
}

async function tagsFor(supabase: ServerSupabase, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase.from("document_tags").select("document_id, tag").in("document_id", ids as string[]).order("tag");
  if (error) throw error;
  for (const r of data ?? []) {
    const list = out.get(r.document_id) ?? [];
    list.push(String(r.tag));
    out.set(r.document_id, list);
  }
  return out;
}

/** One page of the client's vault for the current filters (§7.14 organisation and search). */
export async function listVault(supabase: ServerSupabase, clientId: string, p: VaultParams): Promise<{ rows: VaultRow[]; total: number }> {
  let query = supabase.from("documents").select(VAULT_COLUMNS, { count: "exact" }).eq("client_id", clientId);
  query = p.bin ? query.not("deleted_at", "is", null) : query.is("deleted_at", null);
  if (p.category) query = query.eq("category", p.category);
  if (p.fy === "none") query = query.is("financial_year", null);
  else if (p.fy) query = query.eq("financial_year", p.fy);
  if (p.expiring) {
    const until = addDays(todayIST(), EXPIRING_WITHIN_DAYS);
    query = query.or(`expiry_date.lte.${until},renewal_date.lte.${until}`);
  }

  const search = orSafe(p.q);
  if (search) {
    // Title, file name, period, description, or a tag (§7.14 "search by title, tag or text").
    const like = `%${escapeLike(search)}%`;
    const { data: tagged, error: tagError } = await supabase
      .from("document_tags")
      .select("document_id, documents!inner(client_id)")
      .eq("documents.client_id", clientId)
      .ilike("tag", like)
      .limit(500);
    if (tagError) throw tagError;
    const ids = Array.from(new Set((tagged ?? []).map((t) => t.document_id)));
    const ors = ["title", "file_name", "period", "description"].map((c) => `${c}.ilike.${like}`);
    if (ids.length) ors.push(`id.in.(${ids.join(",")})`);
    query = query.or(ors.join(","));
  }

  const ascending = p.dir === "asc";
  query = query.order(p.sort, { ascending, nullsFirst: false });
  if (p.sort !== "created_at") query = query.order("created_at", { ascending: false });
  const { data, error, count } = await query.range(p.from, p.to);
  if (error) throw error;
  const rows = (data ?? []) as Omit<VaultRow, "tags" | "uploaded_by_name">[];
  const [tags, names] = await Promise.all([
    tagsFor(
      supabase,
      rows.map((r) => r.id),
    ),
    profileNames(
      supabase,
      rows.map((r) => r.uploaded_by),
    ),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [], uploaded_by_name: names.get(r.uploaded_by) ?? null })),
    total: count ?? 0,
  };
}

export interface VaultFolders {
  total: number;
  confidential: number;
  categories: Array<{ category: DocumentCategory; count: number }>;
  years: Array<{ fy: string | null; count: number }>;
  /** Documents in the recycle bin (Partners/Managers only; 0 for others). */
  inBin: number;
  /** Expiring or due for renewal within 30 days, or already past (expiry/renewal reminders, §7.14). */
  expiringSoon: number;
}

/**
 * The folders beside the vault (§7.14 "folders by category and FY") with their counts. Reads only
 * two columns per document, so a large client stays fast.
 */
export async function getVaultFolders(supabase: ServerSupabase, user: CurrentUser, clientId: string, today: string): Promise<VaultFolders> {
  const soonDate = addDays(today, EXPIRING_WITHIN_DAYS);
  const [live, bin, expiring] = await Promise.all([
    supabase.from("documents").select("category, financial_year, is_confidential").eq("client_id", clientId).is("deleted_at", null).limit(10000),
    isManagerOrPartner(user.role)
      ? supabase.from("documents").select("id", { count: "exact", head: true }).eq("client_id", clientId).not("deleted_at", "is", null)
      : Promise.resolve({ count: 0, error: null }),
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .or(`expiry_date.lte.${soonDate},renewal_date.lte.${soonDate}`),
  ]);
  if (live.error) throw live.error;
  if (bin.error) throw bin.error;
  if (expiring.error) throw expiring.error;
  const rows = live.data ?? [];
  const byCat = new Map<DocumentCategory, number>();
  const byFy = new Map<string | null, number>();
  let confidential = 0;
  for (const r of rows) {
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
    byFy.set(r.financial_year, (byFy.get(r.financial_year) ?? 0) + 1);
    if (r.is_confidential) confidential++;
  }
  return {
    total: rows.length,
    confidential,
    categories: DOCUMENT_CATEGORIES.filter((c) => byCat.has(c)).map((c) => ({ category: c, count: byCat.get(c) ?? 0 })),
    years: [...byFy.entries()]
      .sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : b[0].localeCompare(a[0])))
      .map(([fy, count]) => ({ fy, count })),
    inBin: bin.count ?? 0,
    expiringSoon: expiring.count ?? 0,
  };
}

export interface DocumentVersionRow {
  version: number;
  file_name: string;
  file_size: number;
  mime_type: string | null;
  uploaded_by: string;
  uploaded_by_name: string | null;
  change_note: string | null;
  created_at: string;
  is_current: boolean;
}

export interface DocumentActivityRow {
  id: string;
  activity: DocumentActivity;
  user_id: string;
  user_name: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface DocumentDetail {
  document: VaultRow;
  versions: DocumentVersionRow[];
  activities: DocumentActivityRow[];
  /** Where it is used: request items and checklist items that point at it. */
  requestItems: Array<{ id: string; title: string; request_id: string; request_title: string; status: string }>;
  checklistItems: Array<{ id: string; label: string }>;
}

/**
 * One document with its versions (newest first), its last 30 activities and where it is linked.
 * Null when the caller can't see it (RLS), it isn't this client's, or it is in the recycle bin and
 * the caller isn't a Partner or Manager.
 */
export async function getDocumentDetail(supabase: ServerSupabase, clientId: string, id: string, opts: { includeDeleted: boolean }): Promise<DocumentDetail | null> {
  const { data, error } = await supabase.from("documents").select(VAULT_COLUMNS).eq("id", id).eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // The recycle bin is Partners' and Managers' (§7.19).
  if ((data as { deleted_at: string | null }).deleted_at && !opts.includeDeleted) return null;
  const doc = data as Omit<VaultRow, "tags" | "uploaded_by_name">;
  const [tags, versions, activities, items, checklist] = await Promise.all([
    tagsFor(supabase, [doc.id]),
    supabase.from("document_versions").select("version, file_name, file_size, mime_type, uploaded_by, change_note, created_at").eq("document_id", doc.id).order("version", { ascending: false }).limit(100),
    supabase.from("document_activities").select("id, activity, user_id, metadata, created_at").eq("document_id", doc.id).order("created_at", { ascending: false }).limit(30),
    supabase.from("document_request_items").select("id, title, status, request_id, document_requests!inner(title)").eq("document_id", doc.id).limit(20),
    supabase.from("client_document_checklist_items").select("id, label").eq("document_id", doc.id).limit(20),
  ]);
  for (const r of [versions, activities, items, checklist]) if (r.error) throw r.error;
  const versionRows = versions.data ?? [];
  const activityRows = activities.data ?? [];
  const names = await profileNames(supabase, [doc.uploaded_by, ...versionRows.map((v) => v.uploaded_by), ...activityRows.map((a) => a.user_id)]);

  // A document made before versions were kept has no row for its current file: show it anyway.
  const list: DocumentVersionRow[] = versionRows.map((v) => ({ ...v, uploaded_by_name: names.get(v.uploaded_by) ?? null, is_current: v.version === doc.version }));
  if (!list.some((v) => v.version === doc.version)) {
    list.unshift({
      version: doc.version,
      file_name: doc.file_name,
      file_size: doc.file_size,
      mime_type: doc.mime_type,
      uploaded_by: doc.uploaded_by,
      uploaded_by_name: names.get(doc.uploaded_by) ?? null,
      change_note: null,
      created_at: doc.updated_at,
      is_current: true,
    });
  }

  return {
    document: { ...doc, tags: tags.get(doc.id) ?? [], uploaded_by_name: names.get(doc.uploaded_by) ?? null },
    versions: list,
    activities: activityRows.map((a) => ({
      id: a.id,
      activity: a.activity,
      user_id: a.user_id,
      user_name: names.get(a.user_id) ?? null,
      metadata: (a.metadata as Record<string, unknown> | null) ?? null,
      created_at: a.created_at,
    })),
    requestItems: (items.data ?? []).map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      request_id: i.request_id,
      request_title: (i.document_requests as unknown as { title: string } | null)?.title ?? "",
    })),
    checklistItems: (checklist.data ?? []).map((c) => ({ id: c.id, label: c.label })),
  };
}

export interface DocumentOption {
  id: string;
  title: string;
  category: DocumentCategory;
  financial_year: string | null;
  file_name: string;
  created_at: string;
}

/** The client's documents to link to (a checklist item, a request item), newest first. */
export async function listDocumentOptions(supabase: ServerSupabase, clientId: string, limit = 200): Promise<DocumentOption[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, category, financial_year, file_name, created_at")
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as DocumentOption[];
}

export interface VaultClient {
  id: string;
  display_name: string;
  client_code: string;
  entity_type: EntityType | null;
}

/** The client the vault belongs to (null when the caller can't see it or it is in the recycle bin). */
export async function getVaultClient(supabase: ServerSupabase, clientId: string): Promise<VaultClient | null> {
  const { data, error } = await supabase.from("clients").select("id, display_name, client_code, entity_type, deleted_at").eq("id", clientId).maybeSingle();
  if (error) throw error;
  if (!data || data.deleted_at) return null;
  return { id: data.id, display_name: data.display_name, client_code: String(data.client_code), entity_type: data.entity_type };
}

export interface ChecklistRow {
  id: string;
  label: string;
  is_required: boolean;
  collected: boolean;
  collected_at: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  document_id: string | null;
  document_title: string | null;
  sort_order: number;
  updated_at: string;
}

/** The client's onboarding checklist (§7.3.2 step 4, §7.14), in its order, with the linked documents. */
export async function listChecklist(supabase: ServerSupabase, clientId: string): Promise<ChecklistRow[]> {
  const { data, error } = await supabase
    .from("client_document_checklist_items")
    .select("id, label, is_required, collected, collected_at, collected_by, document_id, sort_order, updated_at")
    .eq("client_id", clientId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;
  const rows = data ?? [];
  const docIds = Array.from(new Set(rows.map((r) => r.document_id).filter((d): d is string => !!d)));
  const [names, docs] = await Promise.all([
    profileNames(
      supabase,
      rows.map((r) => r.collected_by),
    ),
    docIds.length
      ? supabase.from("documents").select("id, title, deleted_at").in("id", docIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string; deleted_at: string | null }>, error: null }),
  ]);
  if (docs.error) throw docs.error;
  const titles = new Map((docs.data ?? []).filter((d) => !d.deleted_at).map((d) => [d.id, d.title] as const));
  return rows.map((r) => ({
    ...r,
    collected_by_name: r.collected_by ? (names.get(r.collected_by) ?? null) : null,
    document_title: r.document_id ? (titles.get(r.document_id) ?? null) : null,
  }));
}

import "server-only";

import type { CurrentUser } from "@/lib/auth/current-user";
import { isManagerOrPartner } from "@/lib/auth/roles";
import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { formatWhatsAppNumber, MESSAGING_DEFAULTS } from "@/lib/domain/messaging";
import {
  DEFAULT_GROUP_NAME_FORMAT,
  DEFAULT_WELCOME_TEMPLATE,
  WELCOME_TEMPLATE_NAME,
  compareFirmNumbers,
  checklistProgress,
  parseChecklist,
  shortClientName,
  type ChecklistState,
  type ContactLike,
  type FirmNumberLike,
  type RegisterStatus,
} from "@/lib/domain/whatsapp";
import { getEmployeeNames, getNamesByProfile } from "@/lib/data/people";
import type { RegisterSort } from "@/lib/schemas/whatsapp";

/**
 * Reads for client WhatsApp groups, the WhatsApp groups page and Settings → WhatsApp (§7.25, §7.21).
 * Every function runs under the caller's session, so RLS applies (§4.6): staff read groups only for
 * clients they may open (can_open_whatsapp); Employees through client_whatsapp_groups_public, never
 * the invite link. Invite links are never returned to a page: Partners and Managers reveal one on
 * demand (server/actions/whatsapp-groups.ts). Functions throw on a database error; the page catches
 * it and shows the block's error with its Ref.
 */

// -------------------------------------------------------------------------------------------------
// Shared rows
// -------------------------------------------------------------------------------------------------

/** Search text that can't break out of a PostgREST `or()` filter (commas, brackets, quotes, backslashes). */
function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

export interface FirmNumberRow extends FirmNumberLike {
  custodian_employee_id: string | null;
  shared: boolean;
  two_step_verification_on: boolean;
  devices_reviewed_at: string | null;
  updated_at: string;
  /** Names for display (the directory every staff member may read). */
  owner_name: string | null;
  custodian_name: string | null;
}

const NUMBER_COLUMNS =
  "id, label, number, kind, employee_id, custodian_employee_id, in_every_client_group, group_admin, shared, two_step_verification_on, devices_reviewed_at, is_active, updated_at";

/** Every firm WhatsApp number (staff read them all, §4.6), in display order, with owner and custodian names. */
export async function listFirmNumbers(supabase: ServerSupabase): Promise<FirmNumberRow[]> {
  const { data, error } = await supabase.from("firm_whatsapp_numbers").select(NUMBER_COLUMNS).order("label").limit(100);
  if (error) throw error;
  const rows = (data ?? []) as Array<Omit<FirmNumberRow, "owner_name" | "custodian_name">>;
  const names = await getEmployeeNames(
    supabase,
    rows.flatMap((r) => [r.employee_id, r.custodian_employee_id]),
  );
  return rows
    .map((r) => ({
      ...r,
      owner_name: r.employee_id ? (names.get(r.employee_id) ?? null) : null,
      custodian_name: r.custodian_employee_id ? (names.get(r.custodian_employee_id) ?? null) : null,
    }))
    .sort(compareFirmNumbers);
}

export interface WhatsAppFirmSettings {
  firmName: string;
  firmPhone: string | null;
  countryCode: string;
  nameFormat: string;
  signature: string;
  browserForEmployees: boolean;
  houseRules: string | null;
}

/** The WhatsApp settings every staff member reads (firm_settings: SELECT for staff, §4.6). */
export async function getWhatsAppFirmSettings(supabase: ServerSupabase): Promise<WhatsAppFirmSettings> {
  const { data, error } = await supabase
    .from("firm_settings")
    .select("firm_name, phone, whatsapp_country_code, whatsapp_group_name_format, whatsapp_signature, whatsapp_employee_browser_window, whatsapp_house_rules")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return {
    firmName: data?.firm_name ?? "TaxWise Consultants",
    firmPhone: data?.phone ?? null,
    countryCode: data?.whatsapp_country_code ?? MESSAGING_DEFAULTS.countryCode,
    nameFormat: data?.whatsapp_group_name_format ?? DEFAULT_GROUP_NAME_FORMAT,
    signature: data?.whatsapp_signature ?? MESSAGING_DEFAULTS.whatsappSignature,
    browserForEmployees: data?.whatsapp_employee_browser_window ?? false,
    houseRules: data?.whatsapp_house_rules ?? null,
  };
}

/** The "WhatsApp group welcome" template (§16), or the §16 text when it is missing or switched off. */
export async function getWelcomeTemplate(supabase: ServerSupabase): Promise<{ id: string | null; body: string }> {
  const { data, error } = await supabase.from("message_templates").select("id, body, is_active").eq("name", WELCOME_TEMPLATE_NAME).maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active || !data.body?.trim()) return { id: data?.id ?? null, body: DEFAULT_WELCOME_TEMPLATE };
  return { id: data.id, body: data.body };
}

// -------------------------------------------------------------------------------------------------
// Client 360 → WhatsApp group (§7.25.1–§7.25.2)
// -------------------------------------------------------------------------------------------------

export interface MemberView {
  id: string;
  kind: string;
  firm_number_id: string | null;
  firm_kind: string | null;
  contact_id: string | null;
  display_name: string;
  number: string | null;
  display: string | null;
  is_admin: boolean;
  added_on: string | null;
  removed_on: string | null;
  source: string;
  updated_at: string;
}

export interface GroupView {
  id: string;
  name: string;
  purpose: string | null;
  is_primary: boolean;
  status: "to_create" | "active" | "closed";
  created_on: string | null;
  created_by_number_id: string | null;
  created_by_label: string | null;
  checklist: ChecklistState;
  progress: { done: number; total: number };
  last_opened_at: string | null;
  last_opened_by_name: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  notes: string | null;
  updated_at: string;
  /** Partners and Managers: whether an invite link is saved (the link itself is revealed on demand). */
  has_invite_link: boolean;
  members: MemberView[];
  /** Past members (removed_on set), newest first. */
  former: MemberView[];
}

export interface ClientWhatsApp {
  client: { id: string; client_code: string; display_name: string; short_name: string; status: string };
  groups: GroupView[];
  firmNumbers: FirmNumberRow[];
  contacts: ContactLike[];
  settings: WhatsAppFirmSettings;
  welcome: { id: string | null; body: string };
  /** profiles.id → name, for the checklist stamps. */
  names: Record<string, string>;
}

const GROUP_COLUMNS =
  "id, client_id, name, purpose, is_primary, status, created_on, created_by_number_id, checklist, last_opened_at, last_opened_by, closed_at, closed_reason, notes, deleted_at, created_at, updated_at";

type GroupDb = {
  id: string;
  client_id: string;
  name: string;
  purpose: string | null;
  is_primary: boolean;
  status: "to_create" | "active" | "closed";
  created_on: string | null;
  created_by_number_id: string | null;
  checklist: unknown;
  last_opened_at: string | null;
  last_opened_by: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const ORDER: Record<string, number> = { active: 0, to_create: 1, closed: 2 };

/** Everything the client's WhatsApp group tab shows. Null when the client isn't visible (RLS) or is deleted. */
export async function getClientWhatsApp(supabase: ServerSupabase, user: CurrentUser, clientId: string): Promise<ClientWhatsApp | null> {
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, client_code, display_name, status")
    .eq("id", clientId)
    .is("deleted_at", null)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!client) return null;

  const seesLinks = isManagerOrPartner(user.role);
  const [groupsRes, contactsRes, firmNumbers, settings, welcome] = await Promise.all([
    supabase.from("client_whatsapp_groups_public").select(GROUP_COLUMNS).eq("client_id", clientId).is("deleted_at", null).order("created_at").limit(50),
    supabase.from("client_contacts").select("id, name, role, whatsapp, phone, is_primary").eq("client_id", clientId).order("is_primary", { ascending: false }).order("name").limit(100),
    listFirmNumbers(supabase),
    getWhatsAppFirmSettings(supabase),
    getWelcomeTemplate(supabase),
  ]);
  if (groupsRes.error) throw groupsRes.error;
  if (contactsRes.error) throw contactsRes.error;
  const groups = (groupsRes.data ?? []) as unknown as GroupDb[];
  const ids = groups.map((g) => g.id);

  const [membersRes, linksRes] = await Promise.all([
    ids.length
      ? supabase
          .from("client_whatsapp_group_members")
          .select("id, group_id, kind, firm_number_id, contact_id, display_name, number, is_admin, added_on, removed_on, source, updated_at")
          .in("group_id", ids)
          .order("added_on", { ascending: true })
          .limit(1000)
      : Promise.resolve({ data: [], error: null }),
    seesLinks && ids.length ? supabase.from("client_whatsapp_groups").select("id, invite_link").in("id", ids) : Promise.resolve({ data: [], error: null }),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (linksRes.error) throw linksRes.error;
  const hasLink = new Set(((linksRes.data ?? []) as Array<{ id: string; invite_link: string | null }>).filter((r) => !!r.invite_link).map((r) => r.id));

  const kindOf = new Map(firmNumbers.map((n) => [n.id, n.kind]));
  const labelOf = new Map(firmNumbers.map((n) => [n.id, n.label]));
  type MemberDb = Omit<MemberView, "firm_kind" | "display"> & { group_id: string };
  const membersByGroup = new Map<string, MemberView[]>();
  for (const m of (membersRes.data ?? []) as MemberDb[]) {
    const view: MemberView = {
      ...m,
      firm_kind: m.firm_number_id ? (kindOf.get(m.firm_number_id) ?? null) : null,
      display: m.number ? formatWhatsAppNumber(m.number) : null,
    };
    const list = membersByGroup.get(m.group_id) ?? [];
    list.push(view);
    membersByGroup.set(m.group_id, list);
  }

  const parsed = groups.map((g) => ({ g, checklist: parseChecklist(g.checklist) }));
  const stampIds = parsed.flatMap(({ g, checklist }) => [g.last_opened_by, ...Object.values(checklist.steps).map((s) => s.by)]);
  const names = await getNamesByProfile(supabase, stampIds);

  const views: GroupView[] = parsed.map(({ g, checklist }) => {
    const all = membersByGroup.get(g.id) ?? [];
    const kindRank = (m: MemberView) => (m.kind === "firm_number" ? ({ partner: 0, managers_office: 1, staff_office: 2 }[m.firm_kind ?? ""] ?? 3) : m.kind === "client_contact" ? 4 : 5);
    return {
      id: g.id,
      name: g.name,
      purpose: g.purpose,
      is_primary: g.is_primary,
      status: g.status,
      created_on: g.created_on,
      created_by_number_id: g.created_by_number_id,
      created_by_label: g.created_by_number_id ? (labelOf.get(g.created_by_number_id) ?? null) : null,
      checklist,
      progress: checklistProgress(checklist),
      last_opened_at: g.last_opened_at,
      last_opened_by_name: g.last_opened_by ? (names.get(g.last_opened_by) ?? null) : null,
      closed_at: g.closed_at,
      closed_reason: g.closed_reason,
      notes: g.notes,
      updated_at: g.updated_at,
      has_invite_link: hasLink.has(g.id),
      members: all.filter((m) => !m.removed_on).sort((a, b) => kindRank(a) - kindRank(b) || a.display_name.localeCompare(b.display_name, "en-IN")),
      former: all.filter((m) => !!m.removed_on).sort((a, b) => (b.removed_on ?? "").localeCompare(a.removed_on ?? "")),
    };
  });
  views.sort((a, b) => ORDER[a.status] - ORDER[b.status] || Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name, "en-IN"));

  return {
    client: { id: client.id, client_code: String(client.client_code), display_name: client.display_name, short_name: shortClientName(client.display_name), status: client.status },
    groups: views,
    firmNumbers,
    contacts: (contactsRes.data ?? []) as ContactLike[],
    settings,
    welcome,
    names: Object.fromEntries(names),
  };
}

// -------------------------------------------------------------------------------------------------
// The WhatsApp groups page (§7.25.1)
// -------------------------------------------------------------------------------------------------

export interface RegisterRow {
  row_id: string;
  group_id: string | null;
  client_id: string;
  client_code: string;
  client_name: string;
  client_status: string;
  onboarded_at: string | null;
  engagement_partner_name: string | null;
  group_name: string | null;
  purpose: string | null;
  is_primary: boolean;
  status: RegisterStatus;
  created_on: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  last_opened_at: string | null;
  last_opened_by_name: string | null;
  member_count: number;
  admin_count: number;
  firm_number_ids: string[];
  member_names: string[];
  checklist_done: number;
}

const REGISTER_COLUMNS =
  "row_id, group_id, client_id, client_code, client_name, client_status, onboarded_at, engagement_partner_name, group_name, purpose, is_primary, status, created_on, closed_at, closed_reason, last_opened_at, last_opened_by_name, member_count, admin_count, firm_number_ids, member_names, checklist_done";

/** The register, paged, sorted and filtered in SQL (§2.3). Partners and Managers (the view says so). */
export async function listWhatsAppRegister(
  supabase: ServerSupabase,
  t: TableParams<RegisterSort, "status" | "number" | "primary">,
): Promise<{ rows: RegisterRow[]; total: number }> {
  let q = supabase.from("whatsapp_group_register").select(REGISTER_COLUMNS, { count: "exact" });
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(["client_name", "client_code", "group_name"].map((c) => `${c}.ilike.${like}`).join(","));
  }
  if (t.filters.status?.length) q = q.in("status", t.filters.status);
  if (t.filters.number?.length) {
    const ids = t.filters.number.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    if (ids.length) q = q.overlaps("firm_number_ids", ids);
  }
  if (t.filters.primary?.includes("1")) q = q.eq("is_primary", true);
  const dir = { ascending: t.dir === "asc", nullsFirst: false };
  const sort = t.sort ?? "status_rank";
  q = q.order(sort, dir);
  if (sort !== "client_name") q = q.order("client_name", { ascending: true });
  if (sort !== "status_rank") q = q.order("status_rank", { ascending: true });
  q = q.order("row_id", { ascending: true }).range(t.from, t.to);
  const { data, error, count } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as unknown as RegisterRow[]).map((r) => ({
    ...r,
    firm_number_ids: r.firm_number_ids ?? [],
    member_names: r.member_names ?? [],
    member_count: r.member_count ?? 0,
    admin_count: r.admin_count ?? 0,
    checklist_done: r.checklist_done ?? 0,
  }));
  return { rows, total: count ?? 0 };
}

/** How many rows of each register status there are (unfiltered), for the page header and filter hints. */
export async function getRegisterSummary(supabase: ServerSupabase): Promise<Record<RegisterStatus, number>> {
  const statuses: RegisterStatus[] = ["none", "to_create", "active", "closed"];
  const results = await Promise.all(statuses.map((s) => supabase.from("whatsapp_group_register").select("row_id", { count: "exact", head: true }).eq("status", s)));
  const out = { none: 0, to_create: 0, active: 0, closed: 0 } as Record<RegisterStatus, number>;
  results.forEach((r, i) => {
    if (r.error) throw r.error;
    out[statuses[i]] = r.count ?? 0;
  });
  return out;
}

export interface LinksPerNumber {
  number_id: string;
  label: string;
  kind: string;
  active_links: number;
  device_limit: number | null;
  at_limit: boolean;
  over_limit: boolean;
}

/**
 * PCs linked per active firm number against WhatsApp's limit (§7.25.7), from the desktop tables
 * (Partners and Managers, RLS). Only the dashboard's practice health reads it; nothing records new
 * links since TaxWise Desktop was removed.
 */
export async function getLinksPerNumber(supabase: ServerSupabase): Promise<LinksPerNumber[]> {
  const { data, error } = await supabase
    .from("whatsapp_links_per_number")
    .select("number_id, label, kind, active_links, device_limit, at_limit, over_limit, is_active")
    .eq("is_active", true)
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as Array<LinksPerNumber & { is_active: boolean | null }>)
    .map((r) => ({
      number_id: r.number_id,
      label: r.label,
      kind: r.kind,
      active_links: r.active_links ?? 0,
      device_limit: r.device_limit ?? null,
      at_limit: !!r.at_limit,
      over_limit: !!r.over_limit,
    }))
    .sort(compareFirmNumbers);
}

/**
 * Partners' numbers that are still in client groups after the Partner left (house rule 7): the
 * number is switched off, or its owner is no longer active. With how many groups still hold it.
 */
export async function getDepartedPartnerNumbers(supabase: ServerSupabase, numbers: readonly FirmNumberRow[]): Promise<Array<{ id: string; label: string; groups: number }>> {
  const candidates = numbers.filter((n) => n.kind === "partner" && (!n.is_active || !n.employee_id));
  const owned = numbers.filter((n) => n.kind === "partner" && n.is_active && n.employee_id);
  if (owned.length) {
    const { data, error } = await supabase.from("employee_directory").select("id, is_active").in("id", owned.map((n) => n.employee_id!));
    if (error) throw error;
    const inactive = new Set((data ?? []).filter((e) => e.is_active === false).map((e) => e.id));
    candidates.push(...owned.filter((n) => inactive.has(n.employee_id!)));
  }
  const out: Array<{ id: string; label: string; groups: number }> = [];
  for (const n of candidates) {
    const { count, error } = await supabase
      .from("whatsapp_group_register")
      .select("row_id", { count: "exact", head: true })
      .neq("status", "closed")
      .overlaps("firm_number_ids", [n.id]);
    if (error) throw error;
    if ((count ?? 0) > 0) out.push({ id: n.id, label: n.label, groups: count ?? 0 });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Settings → WhatsApp (§7.21)
// -------------------------------------------------------------------------------------------------

export interface WhatsAppSettingsRow {
  whatsapp_country_code: string;
  whatsapp_group_name_format: string;
  whatsapp_signature: string;
  whatsapp_employee_browser_window: boolean;
  whatsapp_house_rules: string | null;
  updated_at: string;
  updated_by: string | null;
}

export const WHATSAPP_SETTINGS_COLUMNS = [
  "whatsapp_country_code",
  "whatsapp_group_name_format",
  "whatsapp_signature",
  "whatsapp_employee_browser_window",
  "whatsapp_house_rules",
] as const;

export async function getWhatsAppSettingsRow(supabase: ServerSupabase): Promise<{ row: WhatsAppSettingsRow; lastChange: { at: string; byName: string | null } } | null> {
  const { data, error } = await supabase
    .from("firm_settings")
    .select([...WHATSAPP_SETTINGS_COLUMNS, "updated_at", "updated_by"].join(", "))
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as WhatsAppSettingsRow;
  const names = await getNamesByProfile(supabase, [row.updated_by]);
  return { row, lastChange: { at: row.updated_at, byName: row.updated_by ? (names.get(row.updated_by) ?? null) : null } };
}

export interface PersonOption {
  id: string;
  name: string;
  role: string;
}

/** Active Partners (owners of Partner numbers) and active staff (custodians). Partners only call this. */
export async function getNumberPeople(supabase: ServerSupabase): Promise<{ partners: PersonOption[]; staff: PersonOption[] }> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, full_name, staff_role, is_active, deleted_at")
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("full_name")
    .limit(500);
  if (error) throw error;
  const staff = (data ?? [])
    .filter((e) => ["partner", "manager", "employee"].includes(String(e.staff_role)))
    .map((e) => ({ id: e.id, name: e.full_name, role: String(e.staff_role) }));
  return { partners: staff.filter((s) => s.role === "partner"), staff };
}

import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/roles";
import type { Enums, Json } from "@/lib/database.types";
import type {
  ClientPriority,
  ClientStatus,
  ComplianceStatus,
  EngagementStatus,
  EntityType,
  GstRegistration,
  GstScheme,
  MessageChannel,
  MessageDirection,
  MessageStatus,
  ServiceFrequency,
  ServiceType,
  TaskPriority,
  TaskStatus,
  TeamRole,
  WhatsappGroupStatus,
} from "@/lib/domain/enums";
import { kycCompleteness, type KycCheck, type KycCategory } from "@/lib/domain/ceiling";
import { fyStart, isFinancialYear, todayIST, type DateString } from "@/lib/domain/fy";
import { sumPaise, toPaise, type Paise } from "@/lib/domain/money";
import type { SacMap } from "@/lib/domain/gst";
import { getEmployeeNames, getNamesByProfile } from "@/lib/data/people";
import { loadScaleParameterRows } from "@/lib/data/clients";
import { readPrincipalPersons } from "@/lib/schemas/client-kyc";
import { clientWarnings, type ClientWarning } from "@/components/client360/logic/warnings";
import { teamSignature } from "@/components/client360/logic/team";
import { groupOrFilter, istRangeBounds, type TimelineFilters } from "@/components/client360/logic/timeline";
import type { StatutoryParameterRow } from "@/lib/domain/gst";

/**
 * Client 360 reads (§7.3.3), all under the viewer's RLS (CONVENTIONS §3.1): a client the viewer
 * can't see (can_see_client) comes back as null and the page answers 404. Money is loaded only for
 * Partners and Managers (§4.1): the services tab, outstanding and the engagement letter check never
 * run for an Employee, and Employees read services through client_services_public.
 */

// =================================================================================================
// The client and its header
// =================================================================================================

const CLIENT_COLUMNS =
  "id, client_code, display_name, legal_name, entity_type, entity_type_other, is_incorporated, date_of_birth_or_incorporation, pan, tan, gst_registration, gstin, state_code, email, phone, whatsapp, address, city, pincode, notes, status, priority, owner_employee_id, group_id, fy_end_month, annual_turnover, turnover_fy, gst_scheme, tax_audit_applicable, tax_audit_note, tax_audit_decided_by, tax_audit_decided_at, reminder_days, notify_channels, portal_user_id, portal_invited_at, portal_last_seen_at, portal_revoked_at, portal_revoked_by, portal_revoked_user_id, onboarded_at, onboarded_by, source_lead_id, created_at, created_by, updated_at, updated_by, deleted_at";

export interface ClientRecord {
  id: string;
  client_code: string;
  display_name: string;
  legal_name: string | null;
  entity_type: EntityType | null;
  entity_type_other: string | null;
  is_incorporated: boolean;
  date_of_birth_or_incorporation: string | null;
  pan: string | null;
  tan: string | null;
  gst_registration: GstRegistration;
  gstin: string | null;
  state_code: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  notes: string | null;
  status: ClientStatus;
  priority: ClientPriority;
  owner_employee_id: string | null;
  group_id: string | null;
  fy_end_month: number;
  annual_turnover: number | null;
  turnover_fy: string | null;
  gst_scheme: GstScheme | null;
  tax_audit_applicable: "yes" | "no" | "review" | null;
  tax_audit_note: string | null;
  tax_audit_decided_by: string | null;
  tax_audit_decided_at: string | null;
  reminder_days: number | null;
  notify_channels: string[];
  portal_user_id: string | null;
  portal_invited_at: string | null;
  portal_last_seen_at: string | null;
  portal_revoked_at: string | null;
  portal_revoked_by: string | null;
  portal_revoked_user_id: string | null;
  onboarded_at: string | null;
  onboarded_by: string | null;
  source_lead_id: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  // Resolved names
  owner_name: string | null;
  group_name: string | null;
  updated_by_name: string | null;
}

export interface ContactRow {
  id: string;
  client_id: string;
  name: string;
  role: string | null;
  email: string | null;
  email_bounced: boolean;
  phone: string | null;
  whatsapp: string | null;
  is_primary: boolean;
  handles: ServiceType[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  employee_id: string;
  team_role: TeamRole;
  name: string;
}

export interface CoverBadge {
  cover_id: string;
  kind: Enums<"cover_kind">;
  cover_employee_id: string;
  cover_name: string;
  absent_employee_id: string | null;
  absent_name: string | null;
  starts_at: string;
  ends_at: string;
  handover_note: string | null;
}

export interface Client360 {
  client: ClientRecord;
  contacts: ContactRow[];
  team: TeamMember[];
  teamSignature: string;
  covers: CoverBadge[];
  activeServices: ServiceType[];
  warnings: ClientWarning[];
  kyc: KycRecordRow | null;
  kycCheck: KycCheck | null;
}

export interface KycRecordRow {
  id: string;
  client_id: string;
  entity_category: KycCategory;
  pan: string | null;
  cin_llpin: string | null;
  business_description: string | null;
  registered_address: string | null;
  principal_persons: Json | null;
  last_audited_fs_document_id: string | null;
  engagement_types: string[] | null;
  verified_by: string | null;
  verified_on: string | null;
  next_review_on: string | null;
  updated_at: string;
}

const KYC_COLUMNS =
  "id, client_id, entity_category, pan, cin_llpin, business_description, registered_address, principal_persons, last_audited_fs_document_id, engagement_types, verified_by, verified_on, next_review_on, updated_at";

const CONTACT_COLUMNS = "id, client_id, name, role, email, email_bounced, phone, whatsapp, is_primary, handles, notes, created_at, updated_at";

/** The client row (not in the recycle bin) with owner, group and last editor names, or null. */
export async function getClientRecord(supabase: ServerSupabase, id: string): Promise<ClientRecord | null> {
  const { data, error } = await supabase.from("clients").select(CLIENT_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as Omit<ClientRecord, "owner_name" | "group_name" | "updated_by_name">;
  const [owners, editors, group] = await Promise.all([
    getEmployeeNames(supabase, [row.owner_employee_id]),
    getNamesByProfile(supabase, [row.updated_by]),
    row.group_id ? supabase.from("client_groups").select("name").eq("id", row.group_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (group.error) throw group.error;
  return {
    ...row,
    client_code: String(row.client_code),
    email: row.email ? String(row.email) : null,
    pan: row.pan ? String(row.pan) : null,
    gstin: row.gstin ? String(row.gstin) : null,
    tan: row.tan ? String(row.tan) : null,
    notify_channels: row.notify_channels ?? [],
    owner_name: row.owner_employee_id ? (owners.get(row.owner_employee_id) ?? null) : null,
    group_name: group.data ? String((group.data as { name: string }).name) : null,
    updated_by_name: row.updated_by ? (editors.get(row.updated_by) ?? null) : null,
  };
}

export async function getContacts(supabase: ServerSupabase, clientId: string): Promise<ContactRow[]> {
  const { data, error } = await supabase
    .from("client_contacts")
    .select(CONTACT_COLUMNS)
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((c) => ({ ...c, email: c.email ? String(c.email) : null, handles: (c.handles ?? []) as ServiceType[] }));
}

export async function getTeam(supabase: ServerSupabase, clientId: string): Promise<TeamMember[]> {
  const { data, error } = await supabase.from("client_team_members").select("id, employee_id, team_role").eq("client_id", clientId);
  if (error) throw error;
  const names = await getEmployeeNames(supabase, (data ?? []).map((t) => t.employee_id));
  const order: Record<TeamRole, number> = { engagement_partner: 0, review_manager: 1, preparer: 2 };
  return (data ?? [])
    .map((t) => ({ id: t.id, employee_id: t.employee_id, team_role: t.team_role as TeamRole, name: names.get(t.employee_id) ?? "Former team member" }))
    .sort((a, b) => order[a.team_role] - order[b.team_role] || a.name.localeCompare(b.name));
}

async function getCoverBadges(supabase: ServerSupabase, clientId: string): Promise<CoverBadge[]> {
  const { data, error } = await supabase.rpc("client_cover_badges", { p_client_id: clientId });
  if (error) throw error;
  return (data ?? [])
    .filter((b): b is typeof b & { cover_id: string; cover_employee_id: string; starts_at: string; ends_at: string } => !!b.cover_id && !!b.cover_employee_id && !!b.ends_at && !!b.starts_at)
    .map((b) => ({
      cover_id: b.cover_id,
      kind: (b.kind ?? "client") as Enums<"cover_kind">,
      cover_employee_id: b.cover_employee_id,
      cover_name: b.cover_name ?? "",
      absent_employee_id: b.absent_employee_id,
      absent_name: b.absent_name,
      starts_at: b.starts_at,
      ends_at: b.ends_at,
      handover_note: b.handover_note,
    }));
}

export async function getKyc(supabase: ServerSupabase, clientId: string): Promise<KycRecordRow | null> {
  const { data, error } = await supabase.from("client_kyc").select(KYC_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { ...(data as unknown as KycRecordRow), pan: data.pan ? String(data.pan) : null, entity_category: data.entity_category as KycCategory };
}

export function kycCheckFor(client: Pick<ClientRecord, "display_name" | "legal_name">, kyc: KycRecordRow | null, today: DateString): KycCheck {
  if (!kyc) return kycCompleteness(null, today);
  return kycCompleteness(
    {
      entityCategory: kyc.entity_category,
      name: client.legal_name ?? client.display_name,
      pan: kyc.pan,
      cinLlpin: kyc.cin_llpin,
      businessDescription: kyc.business_description,
      lastAuditedFsDocumentId: kyc.last_audited_fs_document_id,
      engagementTypes: kyc.engagement_types,
      principalPersons: readPrincipalPersons(kyc.principal_persons),
      verifiedOn: kyc.verified_on,
      nextReviewOn: kyc.next_review_on,
    },
    today,
  );
}

/**
 * Everything the header, the warnings strip and the tab row need, or null when the viewer can't see
 * the client (RLS) or it is in the recycle bin. `fy` is the FY switcher's year, for the engagement
 * letter check (Partner/Manager only).
 */
export async function getClient360(supabase: ServerSupabase, user: CurrentUser, id: string, fy: string): Promise<Client360 | null> {
  const client = await getClientRecord(supabase, id);
  if (!client) return null;
  const today = todayIST();
  const seesMoney = can.seeMoney(user.role);

  const [contacts, team, covers, services, kyc, dsc, letter] = await Promise.all([
    getContacts(supabase, id),
    getTeam(supabase, id),
    getCoverBadges(supabase, id),
    supabase.from("client_services_public").select("service_type").eq("client_id", id).eq("is_active", true),
    getKyc(supabase, id),
    supabase.from("dsc_records").select("holder_name, expiry_date, status").eq("client_id", id).eq("status", "active").order("expiry_date").limit(20),
    seesMoney
      ? supabase.from("engagement_letters").select("status, updated_at").eq("client_id", id).eq("financial_year", fy).order("updated_at", { ascending: false }).limit(5)
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (services.error) throw services.error;
  if (dsc.error) throw dsc.error;
  if (letter.error) throw letter.error;

  const activeServices = Array.from(new Set((services.data ?? []).map((s) => s.service_type).filter((s): s is ServiceType => !!s)));
  const kycCheck = kycCheckFor(client, kyc, today);

  // The best letter for the FY: signed, then issued, then draft, then the rest.
  let letterStatus: EngagementStatus | null = null;
  if (seesMoney) {
    const rank: Record<EngagementStatus, number> = { signed: 0, issued: 1, draft: 2, expired: 3, declined: 4 };
    const statuses = ((letter.data ?? []) as Array<{ status: EngagementStatus }>).map((l) => l.status).sort((a, b) => rank[a] - rank[b]);
    letterStatus = statuses[0] ?? null;
  }

  const warnings = clientWarnings({
    clientId: id,
    client,
    contacts,
    activeServices,
    kyc: kycCheck,
    engagementLetter: seesMoney ? { fy, status: letterStatus } : null,
    dsc: (dsc.data ?? []).map((d) => ({ holder_name: d.holder_name, expiry_date: d.expiry_date, status: d.status })),
    today,
  });

  return {
    client,
    contacts,
    team,
    teamSignature: teamSignature(client.owner_employee_id, team),
    covers,
    activeServices,
    warnings,
    kyc,
    kycCheck,
  };
}

// =================================================================================================
// Overview (§7.3.3 tab 1)
// =================================================================================================

export interface OpenTaskRow {
  id: string;
  task_number: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  is_overdue: boolean;
  assignee_name: string | null;
}

export interface DeadlineRow {
  id: string;
  title: string;
  form_code: string | null;
  filing_period: string | null;
  due_date: string;
  status: ComplianceStatus;
  is_overdue: boolean;
}

export interface MessageRow {
  id: string;
  channel: MessageChannel;
  direction: MessageDirection;
  status: MessageStatus;
  subject: string | null;
  body: string;
  recipient: string | null;
  at: string;
  by_name: string | null;
}

export interface WhatsAppGroupSummary {
  id: string;
  name: string;
  status: WhatsappGroupStatus;
  purpose: string | null;
  last_opened_at: string | null;
  last_opened_by_name: string | null;
  checklist_done: number;
  checklist_total: number;
}

export interface OverviewData {
  openTasks: number;
  overdueTasks: number;
  tasks: OpenTaskRow[];
  nextDeadline: DeadlineRow | null;
  overdueDeadlines: number;
  /** Partner/Manager only; null for Employees (never loaded). */
  outstanding: { paise: Paise; invoices: number; overdue: number } | null;
  lastContactAt: string | null;
  messages: MessageRow[];
  whatsapp: WhatsAppGroupSummary | null;
  whatsappGroups: number;
  portal: { revokedByName: string | null };
  taxAudit: { decidedByName: string | null; parameterRows: StatutoryParameterRow[] };
  onboardedByName: string | null;
}

const WHATSAPP_STEPS = 7; // §7.25.2: seven setup steps

function checklistProgress(checklist: Json | null): { done: number; total: number } {
  if (!checklist || typeof checklist !== "object" || Array.isArray(checklist)) return { done: 0, total: WHATSAPP_STEPS };
  const entries = Object.values(checklist as Record<string, unknown>);
  const done = entries.filter((v) => !!v && typeof v === "object" && (v as { done?: unknown }).done === true).length;
  return { done, total: Math.max(WHATSAPP_STEPS, entries.length) };
}

export async function getOverview(supabase: ServerSupabase, user: CurrentUser, client: ClientRecord): Promise<OverviewData> {
  const id = client.id;
  const today = todayIST();
  const seesMoney = can.seeMoney(user.role);

  const [openCount, overdueCount, tasks, next, overdueDeadlines, messages, groups, money, params] = await Promise.all([
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("client_id", id).is("deleted_at", null).neq("status", "filed_done"),
    supabase.from("tasks_view").select("id", { count: "exact", head: true }).eq("client_id", id).is("deleted_at", null).eq("is_overdue", true),
    supabase
      .from("tasks_view")
      .select("id, task_number, title, status, priority, due_date, is_overdue, assigned_employee_id")
      .eq("client_id", id)
      .is("deleted_at", null)
      .neq("status", "filed_done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(5),
    supabase
      .from("compliance_events_view")
      .select("id, title, form_code, filing_period, due_date, status, is_overdue")
      .eq("client_id", id)
      .eq("status", "pending")
      .gte("due_date", today)
      .order("due_date", { ascending: true })
      .limit(1),
    supabase.from("compliance_events_view").select("id", { count: "exact", head: true }).eq("client_id", id).eq("is_overdue", true),
    supabase
      .from("messages")
      .select("id, channel, direction, status, subject, body, recipient, sent_at, created_at, sent_by")
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("client_whatsapp_groups_public")
      .select("id, name, status, purpose, is_primary, last_opened_at, last_opened_by, checklist, created_at")
      .eq("client_id", id)
      .is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(10),
    seesMoney
      ? supabase
          .from("invoices_view")
          .select("outstanding_amount, is_overdue")
          .eq("client_id", id)
          .is("deleted_at", null)
          .is("cancelled_at", null)
          .in("status", ["sent", "partially_paid", "disputed"])
          .gt("outstanding_amount", 0)
          .limit(1000)
      : Promise.resolve({ data: null, error: null }),
    client.annual_turnover !== null ? loadScaleParameterRows(supabase) : Promise.resolve([] as StatutoryParameterRow[]),
  ]);
  for (const r of [openCount, overdueCount, tasks, next, overdueDeadlines, messages, groups, money]) {
    if (r.error) throw r.error;
  }

  const taskRows = (tasks.data ?? []) as Array<{
    id: string | null;
    task_number: string | null;
    title: string | null;
    status: TaskStatus | null;
    priority: TaskPriority | null;
    due_date: string | null;
    is_overdue: boolean | null;
    assigned_employee_id: string | null;
  }>;
  const messageRows = (messages.data ?? []) as Array<{
    id: string;
    channel: MessageChannel;
    direction: MessageDirection;
    status: MessageStatus;
    subject: string | null;
    body: string;
    recipient: string | null;
    sent_at: string | null;
    created_at: string;
    sent_by: string | null;
  }>;
  const groupRows = (groups.data ?? []) as Array<{
    id: string | null;
    name: string | null;
    status: WhatsappGroupStatus | null;
    purpose: string | null;
    is_primary: boolean | null;
    last_opened_at: string | null;
    last_opened_by: string | null;
    checklist: Json | null;
  }>;
  const liveGroups = groupRows.filter((g) => g.status !== "closed");
  const group = liveGroups[0] ?? groupRows[0] ?? null;

  const [assignees, people] = await Promise.all([
    getEmployeeNames(supabase, taskRows.map((t) => t.assigned_employee_id)),
    getNamesByProfile(supabase, [
      ...messageRows.map((m) => m.sent_by),
      group?.last_opened_by ?? null,
      client.portal_revoked_by,
      client.tax_audit_decided_by,
      client.onboarded_by,
    ]),
  ]);

  let outstanding: OverviewData["outstanding"] = null;
  if (seesMoney) {
    const rows = ((money.data ?? []) as Array<{ outstanding_amount: number | null; is_overdue: boolean | null }>).filter((r) => r.outstanding_amount !== null);
    outstanding = {
      paise: sumPaise(rows.map((r) => toPaise(r.outstanding_amount as number))),
      invoices: rows.length,
      overdue: rows.filter((r) => r.is_overdue).length,
    };
  }

  const nextRow = (next.data ?? [])[0] as
    | { id: string | null; title: string | null; form_code: string | null; filing_period: string | null; due_date: string | null; status: ComplianceStatus | null; is_overdue: boolean | null }
    | undefined;

  return {
    openTasks: openCount.count ?? 0,
    overdueTasks: overdueCount.count ?? 0,
    tasks: taskRows
      .filter((t) => t.id && t.title && t.status)
      .map((t) => ({
        id: t.id as string,
        task_number: t.task_number,
        title: t.title as string,
        status: t.status as TaskStatus,
        priority: (t.priority ?? "medium") as TaskPriority,
        due_date: t.due_date,
        is_overdue: !!t.is_overdue,
        assignee_name: t.assigned_employee_id ? (assignees.get(t.assigned_employee_id) ?? null) : null,
      })),
    nextDeadline:
      nextRow && nextRow.id && nextRow.due_date
        ? {
            id: nextRow.id,
            title: nextRow.title ?? "",
            form_code: nextRow.form_code,
            filing_period: nextRow.filing_period,
            due_date: nextRow.due_date,
            status: (nextRow.status ?? "pending") as ComplianceStatus,
            is_overdue: !!nextRow.is_overdue,
          }
        : null,
    overdueDeadlines: overdueDeadlines.count ?? 0,
    outstanding,
    lastContactAt: messageRows[0] ? (messageRows[0].sent_at ?? messageRows[0].created_at) : null,
    messages: messageRows.map((m) => ({
      id: m.id,
      channel: m.channel,
      direction: m.direction,
      status: m.status,
      subject: m.subject,
      body: m.body,
      recipient: m.recipient,
      at: m.sent_at ?? m.created_at,
      by_name: m.sent_by ? (people.get(m.sent_by) ?? null) : null,
    })),
    whatsapp:
      group && group.id && group.name && group.status
        ? {
            id: group.id,
            name: group.name,
            status: group.status,
            purpose: group.purpose,
            last_opened_at: group.last_opened_at,
            last_opened_by_name: group.last_opened_by ? (people.get(group.last_opened_by) ?? null) : null,
            checklist_done: checklistProgress(group.checklist).done,
            checklist_total: checklistProgress(group.checklist).total,
          }
        : null,
    whatsappGroups: liveGroups.length,
    portal: { revokedByName: client.portal_revoked_by ? (people.get(client.portal_revoked_by) ?? null) : null },
    taxAudit: { decidedByName: client.tax_audit_decided_by ? (people.get(client.tax_audit_decided_by) ?? null) : null, parameterRows: params },
    onboardedByName: client.onboarded_by ? (people.get(client.onboarded_by) ?? null) : null,
  };
}

/** The first day of the FY the turnover is for (the tax-audit limits in force then, §6.6), or today. */
export function taxAuditParamsDate(turnoverFy: string | null): DateString {
  return turnoverFy && isFinancialYear(turnoverFy) ? fyStart(turnoverFy) : todayIST();
}

/** Email addresses the portal invite can go to: the client's, then its contacts' (§7.22 "needs an email"). */
export function portalEmailOptions(client: Pick<ClientRecord, "email">, contacts: ReadonlyArray<Pick<ContactRow, "email" | "name" | "is_primary" | "email_bounced">>): Array<{ email: string; label: string }> {
  const out: Array<{ email: string; label: string }> = [];
  const seen = new Set<string>();
  const add = (email: string | null, label: string) => {
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email: key, label });
  };
  add(client.email, "Client's email");
  for (const c of [...contacts].sort((a, b) => Number(b.is_primary) - Number(a.is_primary))) {
    if (c.email_bounced) continue;
    add(c.email, c.is_primary ? `${c.name} (primary contact)` : c.name);
  }
  return out;
}

// =================================================================================================
// Profile & contacts (§7.3.3 tab 2)
// =================================================================================================

export interface DocumentOption {
  id: string;
  title: string;
  category: Enums<"document_category">;
  financial_year: string | null;
  created_at: string;
}

/** The client's documents for the KYC "last audited financial statements" picker, audit ones first. */
export async function getKycDocumentOptions(supabase: ServerSupabase, clientId: string): Promise<DocumentOption[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, category, financial_year, created_at")
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  const rows = (data ?? []) as DocumentOption[];
  const weight = (c: string) => (c === "audit" ? 0 : c === "kyc" ? 1 : 2);
  return [...rows].sort((a, b) => weight(a.category) - weight(b.category));
}

export async function getProfileNames(supabase: ServerSupabase, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  return getNamesByProfile(supabase, ids);
}

// =================================================================================================
// Services & fees (§7.3.3 tab 3; Partner/Manager only)
// =================================================================================================

export interface ServiceRow {
  id: string;
  service_type: ServiceType;
  custom_name: string | null;
  frequency: ServiceFrequency;
  is_active: boolean;
  next_due_date: string | null;
  agreed_fee: number | null;
  billing_frequency: ServiceFrequency | null;
  sac_code: string | null;
  fee_agreed_at: string | null;
  auto_invoice: boolean;
  next_billing_date: string | null;
  last_auto_invoiced_at: string | null;
  source_quotation_item_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeeHistoryRow {
  id: string;
  client_service_id: string;
  agreed_fee: number | null;
  billing_frequency: ServiceFrequency | null;
  changed_at: string;
  changed_by_name: string | null;
}

export interface ServicesData {
  services: ServiceRow[];
  history: FeeHistoryRow[];
  firm: { state_code: string; default_tax_rate: number; default_sac: string; sac_by_service: SacMap | null };
}

const SERVICE_COLUMNS =
  "id, service_type, custom_name, frequency, is_active, next_due_date, agreed_fee, billing_frequency, sac_code, fee_agreed_at, auto_invoice, next_billing_date, last_auto_invoiced_at, source_quotation_item_id, created_at, updated_at";

function readSacMap(value: Json | null): SacMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: SacMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string" && /^\d{4,8}$/.test(v)) (out as Record<string, string>)[k] = v;
  return out;
}

/** Partner/Manager only: the caller checks the role first; RLS refuses everyone else anyway. */
export async function getServices(supabase: ServerSupabase, clientId: string): Promise<ServicesData> {
  const [services, history, firm] = await Promise.all([
    supabase.from("client_services").select(SERVICE_COLUMNS).eq("client_id", clientId).order("is_active", { ascending: false }).order("created_at", { ascending: true }),
    supabase
      .from("client_service_fee_history")
      .select("id, client_service_id, agreed_fee, billing_frequency, changed_at, changed_by")
      .eq("client_id", clientId)
      .order("changed_at", { ascending: false })
      .limit(200),
    supabase.from("firm_settings").select("state_code, default_tax_rate, default_sac, sac_by_service").eq("id", 1).maybeSingle(),
  ]);
  if (services.error) throw services.error;
  if (history.error) throw history.error;
  if (firm.error) throw firm.error;
  const names = await getNamesByProfile(supabase, (history.data ?? []).map((h) => h.changed_by));
  return {
    services: (services.data ?? []) as ServiceRow[],
    history: (history.data ?? []).map((h) => ({
      id: h.id,
      client_service_id: h.client_service_id,
      agreed_fee: h.agreed_fee,
      billing_frequency: h.billing_frequency,
      changed_at: h.changed_at,
      changed_by_name: h.changed_by ? (names.get(h.changed_by) ?? null) : null,
    })),
    firm: {
      state_code: firm.data?.state_code ?? "29",
      default_tax_rate: Number(firm.data?.default_tax_rate ?? 18),
      default_sac: firm.data?.default_sac ?? "9982",
      sac_by_service: readSacMap((firm.data?.sac_by_service ?? null) as Json | null),
    },
  };
}

// =================================================================================================
// Timeline (§7.3.3 tab 13)
// =================================================================================================

export interface TimelineRow {
  id: string;
  event_type: string;
  title: string;
  description: string | null;
  created_at: string;
  performed_by_name: string | null;
}

export async function getTimeline(
  supabase: ServerSupabase,
  clientId: string,
  filters: TimelineFilters,
  page: { from: number; to: number },
): Promise<{ rows: TimelineRow[]; total: number }> {
  let q = supabase
    .from("client_timeline_events")
    .select("id, event_type, title, description, created_at, performed_by", { count: "exact" })
    .eq("client_id", clientId);
  const or = groupOrFilter(filters.groups);
  if (or) q = q.or(or);
  const { gte, lt } = istRangeBounds(filters.from, filters.to);
  if (gte) q = q.gte("created_at", gte);
  if (lt) q = q.lt("created_at", lt);
  if (filters.q) q = q.ilike("title", `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const { data, error, count } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(page.from, page.to);
  if (error) throw error;
  const names = await getNamesByProfile(supabase, (data ?? []).map((r) => r.performed_by));
  return {
    rows: (data ?? []).map((r) => ({
      id: r.id,
      event_type: r.event_type,
      title: r.title,
      description: r.description,
      created_at: r.created_at,
      performed_by_name: r.performed_by ? (names.get(r.performed_by) ?? null) : null,
    })),
    total: count ?? 0,
  };
}

/** Whether the client has any timeline events at all (to tell an empty story from a filtered one). */
export async function hasAnyTimeline(supabase: ServerSupabase, clientId: string): Promise<boolean> {
  const { count, error } = await supabase.from("client_timeline_events").select("id", { count: "exact", head: true }).eq("client_id", clientId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

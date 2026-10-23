import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { CoverKind, CoverReason } from "@/lib/domain/enums";
import { COVER_DEFAULTS, coverState, isAbsentWithoutCover, type CoverState } from "@/lib/domain/cover";
import { getEmployeeNames, getNamesByProfile } from "@/lib/data/people";
import { getWorkingCalendar } from "@/lib/data/capacity";
import { addDays, istDayBounds, isWorkingDay, todayIST, type DateString } from "@/lib/domain/fy";
import { parseTimeOfDay } from "@/lib/domain/attendance";

/**
 * Reads for cover access (§4.7, §5.13) under the caller's RLS: Partners and Managers see every
 * cover; anyone else the covers where they are the cover person or the absent person (0040).
 * Client names come through the clients RLS: a cover person sees the client while the cover is in
 * force, the absent person sees their own clients.
 */

export interface CoverRow {
  id: string;
  kind: CoverKind;
  client_id: string | null;
  client_name: string | null;
  client_code: string | null;
  absent_employee_id: string | null;
  absent_name: string | null;
  cover_employee_id: string;
  cover_name: string;
  starts_at: string;
  ends_at: string;
  reason: CoverReason;
  note: string | null;
  handover_note: string | null;
  return_note: string | null;
  include_vault: boolean;
  leave_id: string | null;
  granted_by: string;
  granted_by_name: string | null;
  revoked_at: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
  merged_into: string | null;
  state: CoverState;
  created_at: string;
  updated_at: string;
}

const COVER_COLS =
  "id, kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, note, handover_note, return_note, include_vault, leave_id, granted_by, revoked_at, revoked_by, revoke_reason, merged_into, created_at, updated_at";

type RawCover = {
  id: string;
  kind: CoverKind;
  client_id: string | null;
  absent_employee_id: string | null;
  cover_employee_id: string;
  starts_at: string;
  ends_at: string;
  reason: CoverReason;
  note: string | null;
  handover_note: string | null;
  return_note: string | null;
  include_vault: boolean;
  leave_id: string | null;
  granted_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
};

async function decorate(supabase: ServerSupabase, rows: RawCover[], now: Date): Promise<CoverRow[]> {
  if (rows.length === 0) return [];
  const clientIds = Array.from(new Set(rows.map((r) => r.client_id).filter((c): c is string => !!c)));
  const [employees, profiles, clients] = await Promise.all([
    getEmployeeNames(supabase, rows.flatMap((r) => [r.absent_employee_id, r.cover_employee_id])),
    getNamesByProfile(supabase, rows.flatMap((r) => [r.granted_by, r.revoked_by])),
    clientIds.length ? supabase.from("clients").select("id, display_name, client_code").in("id", clientIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (clients.error) throw clients.error;
  const clientById = new Map((clients.data ?? []).map((c) => [c.id as string, c as { id: string; display_name: string; client_code: string }]));
  return rows.map((r) => ({
    ...r,
    client_name: r.client_id ? (clientById.get(r.client_id)?.display_name ?? null) : null,
    client_code: r.client_id ? (clientById.get(r.client_id)?.client_code ?? null) : null,
    absent_name: r.absent_employee_id ? (employees.get(r.absent_employee_id) ?? null) : null,
    cover_name: employees.get(r.cover_employee_id) ?? "",
    granted_by_name: profiles.get(r.granted_by) ?? null,
    revoked_by_name: r.revoked_by ? (profiles.get(r.revoked_by) ?? null) : null,
    state: coverState({ startsAt: r.starts_at, endsAt: r.ends_at, revokedAt: r.revoked_at }, now),
  }));
}

export async function getCover(supabase: ServerSupabase, id: string, now: Date = new Date()): Promise<CoverRow | null> {
  const { data, error } = await supabase.from("client_covers").select(COVER_COLS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await decorate(supabase, [data as RawCover], now))[0];
}

/**
 * Covers that reach a client (§4.7), in force or scheduled: client covers for it, and person
 * covers for its owner or anyone on its team. `recent` adds the ones that ended in the last 30
 * days (not merges), for the Team section's history line.
 */
export async function getCoversForClient(
  supabase: ServerSupabase,
  clientId: string,
  opts: { recentDays?: number } = {},
  now: Date = new Date(),
): Promise<{ live: CoverRow[]; recent: CoverRow[]; ownerEmployeeId: string | null; teamEmployeeIds: string[] }> {
  const [client, team] = await Promise.all([
    supabase.from("clients").select("owner_employee_id").eq("id", clientId).maybeSingle(),
    supabase.from("client_team_members").select("employee_id").eq("client_id", clientId),
  ]);
  if (client.error) throw client.error;
  if (team.error) throw team.error;
  const owner = client.data?.owner_employee_id ?? null;
  const people = Array.from(new Set([owner, ...(team.data ?? []).map((t) => t.employee_id)].filter((p): p is string => !!p)));
  const since = new Date(now.getTime() - (opts.recentDays ?? 30) * 86_400_000).toISOString();

  let q = supabase.from("client_covers").select(COVER_COLS).gt("ends_at", since).is("merged_into", null).order("starts_at", { ascending: true }).limit(100);
  q = people.length
    ? q.or(`client_id.eq.${clientId},and(kind.eq.person,absent_employee_id.in.(${people.join(",")}))`)
    : q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = await decorate(supabase, (data ?? []) as RawCover[], now);
  return {
    live: rows.filter((r) => r.state === "in_force" || r.state === "scheduled"),
    recent: rows.filter((r) => r.state === "ended" || r.state === "revoked"),
    ownerEmployeeId: owner,
    teamEmployeeIds: (team.data ?? []).map((t) => t.employee_id),
  };
}

/** A person's covers (§7.11.2 Work): those they hold and those for them; live first, then the last 60 days. */
export async function getCoversForPerson(supabase: ServerSupabase, employeeId: string, now: Date = new Date()): Promise<{ holding: CoverRow[]; forThem: CoverRow[] }> {
  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("client_covers")
    .select(COVER_COLS)
    .or(`cover_employee_id.eq.${employeeId},absent_employee_id.eq.${employeeId}`)
    .gt("ends_at", since)
    .is("merged_into", null)
    .order("ends_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const rows = await decorate(supabase, (data ?? []) as RawCover[], now);
  const order = (r: CoverRow) => (r.state === "in_force" ? 0 : r.state === "scheduled" ? 1 : 2);
  const sorted = rows.sort((a, b) => order(a) - order(b));
  return {
    holding: sorted.filter((r) => r.cover_employee_id === employeeId),
    forThem: sorted.filter((r) => r.absent_employee_id === employeeId),
  };
}

/**
 * My day's "Covering" (§7.2) and "I'm back, end cover" (§4.7): the signed-in person's live covers,
 * as the cover person and as the absent person, with handover notes. Also the ended covers they held
 * in the last 14 days that still have no return note (the prompt for a note back).
 */
export async function getMyCovers(
  supabase: ServerSupabase,
  user: CurrentUser,
  now: Date = new Date(),
): Promise<{ covering: CoverRow[]; coveredFor: CoverRow[]; awaitingReturnNote: CoverRow[] }> {
  if (!user.employeeId) return { covering: [], coveredFor: [], awaitingReturnNote: [] };
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("client_covers")
    .select(COVER_COLS)
    .or(`cover_employee_id.eq.${user.employeeId},absent_employee_id.eq.${user.employeeId}`)
    .gt("ends_at", since)
    .is("merged_into", null)
    .order("ends_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  const rows = await decorate(supabase, (data ?? []) as RawCover[], now);
  const live = (r: CoverRow) => r.state === "in_force" || r.state === "scheduled";
  return {
    covering: rows.filter((r) => r.cover_employee_id === user.employeeId && live(r)),
    coveredFor: rows.filter((r) => r.absent_employee_id === user.employeeId && live(r)),
    awaitingReturnNote: rows.filter((r) => r.cover_employee_id === user.employeeId && !live(r) && !r.return_note),
  };
}

export interface CoverClientRow {
  id: string;
  client_code: string;
  display_name: string;
  relation: "owner" | "team";
  open_tasks: number;
  next_deadline: string | null;
  next_deadline_title: string | null;
}

/**
 * The clients a person cover would reach (§4.7: owner or on the team), for People → person →
 * Cover their clients (the split table: each client's open tasks and next deadline) and the leave
 * approval prompt ("Who covers Ravi's 18 clients…?"). Partners and Managers only.
 */
export async function getClientsOfPerson(supabase: ServerSupabase, employeeId: string, today: string = todayIST()): Promise<CoverClientRow[]> {
  const [owned, team] = await Promise.all([
    supabase.from("clients").select("id, client_code, display_name").eq("owner_employee_id", employeeId).is("deleted_at", null).limit(1000),
    supabase.from("client_team_members").select("clients(id, client_code, display_name, deleted_at)").eq("employee_id", employeeId).limit(1000),
  ]);
  if (owned.error) throw owned.error;
  if (team.error) throw team.error;
  const byId = new Map<string, CoverClientRow>();
  for (const c of owned.data ?? []) {
    byId.set(c.id, { id: c.id, client_code: c.client_code as string, display_name: c.display_name, relation: "owner", open_tasks: 0, next_deadline: null, next_deadline_title: null });
  }
  for (const m of team.data ?? []) {
    const c = m.clients as { id: string; client_code: string; display_name: string; deleted_at: string | null } | null;
    if (!c || c.deleted_at || byId.has(c.id)) continue;
    byId.set(c.id, { id: c.id, client_code: c.client_code, display_name: c.display_name, relation: "team", open_tasks: 0, next_deadline: null, next_deadline_title: null });
  }
  const ids = Array.from(byId.keys());
  if (ids.length > 0) {
    const [tasks, events] = await Promise.all([
      supabase.from("tasks").select("client_id").in("client_id", ids).is("deleted_at", null).neq("status", "filed_done").limit(20000),
      supabase
        .from("compliance_events")
        .select("client_id, due_date, title")
        .in("client_id", ids)
        .eq("status", "pending")
        .gte("due_date", today)
        .order("due_date")
        .limit(5000),
    ]);
    if (tasks.error) throw tasks.error;
    if (events.error) throw events.error;
    for (const t of tasks.data ?? []) {
      const c = byId.get(t.client_id);
      if (c) c.open_tasks += 1;
    }
    for (const e of events.data ?? []) {
      if (!e.client_id) continue;
      const c = byId.get(e.client_id);
      if (c && !c.next_deadline) {
        c.next_deadline = e.due_date;
        c.next_deadline_title = e.title;
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/**
 * The cover badge for clients on a list (§4.7: "Covering for Ravi · until Sat 25 Oct, 11:59 pm"):
 * for the signed-in cover person, each client reached by a cover in force they hold → the absent
 * person's name and the end. Used by My clients and the client header.
 */
export async function getCoverBadges(
  supabase: ServerSupabase,
  coverEmployeeId: string,
  clients: ReadonlyArray<{ id: string; ownerEmployeeId: string | null; teamEmployeeIds?: readonly string[] }>,
): Promise<Map<string, { absentName: string; endsAt: string }>> {
  const out = new Map<string, { absentName: string; endsAt: string }>();
  if (clients.length === 0) return out;
  const { data, error } = await supabase
    .from("covers_in_force")
    .select("kind, client_id, absent_employee_id, ends_at")
    .eq("cover_employee_id", coverEmployeeId);
  if (error) throw error;
  const covers = data ?? [];
  if (covers.length === 0) return out;
  const names = await getEmployeeNames(supabase, [...covers.map((c) => c.absent_employee_id), ...clients.map((c) => c.ownerEmployeeId)]);
  for (const client of clients) {
    for (const c of covers) {
      const reaches =
        c.kind === "client"
          ? c.client_id === client.id
          : !!c.absent_employee_id && (client.ownerEmployeeId === c.absent_employee_id || (client.teamEmployeeIds ?? []).includes(c.absent_employee_id));
      if (!reaches || !c.ends_at) continue;
      const absentId = c.absent_employee_id ?? client.ownerEmployeeId;
      const prev = out.get(client.id);
      if (!prev || prev.endsAt < c.ends_at) out.set(client.id, { absentName: (absentId && names.get(absentId)) || "a colleague", endsAt: c.ends_at });
    }
  }
  return out;
}

/**
 * Every client the signed-in cover person reaches through a cover in force (§4.7), with the badge
 * facts ("Covering for Ravi · until Sat 25 Oct, 11:59 pm"): client covers name the client; person
 * covers reach the clients the absent person owns or is on the team of (the same rule as
 * can_see_client). For My clients' `?covering=1` filter and its badges. Under the viewer's RLS.
 */
export async function getMyCoveredClients(supabase: ServerSupabase, coverEmployeeId: string): Promise<Map<string, { absentName: string; endsAt: string }>> {
  const out = new Map<string, { absentName: string; endsAt: string }>();
  const { data, error } = await supabase.from("covers_in_force").select("kind, client_id, absent_employee_id, ends_at").eq("cover_employee_id", coverEmployeeId);
  if (error) throw error;
  const covers = (data ?? []).filter((c): c is typeof c & { ends_at: string } => !!c.ends_at);
  if (covers.length === 0) return out;

  // client id → [absent person (null: the client's owner), ends at]
  const reached: Array<{ clientId: string; absentId: string | null; endsAt: string }> = [];
  const absentIds = Array.from(new Set(covers.filter((c) => c.kind === "person" && c.absent_employee_id).map((c) => c.absent_employee_id as string)));
  for (const c of covers) if (c.kind === "client" && c.client_id) reached.push({ clientId: c.client_id, absentId: c.absent_employee_id, endsAt: c.ends_at });
  if (absentIds.length) {
    const [owned, team] = await Promise.all([
      supabase.from("clients").select("id, owner_employee_id").in("owner_employee_id", absentIds).is("deleted_at", null).limit(5000),
      supabase.from("client_team_members").select("client_id, employee_id").in("employee_id", absentIds).limit(5000),
    ]);
    if (owned.error) throw owned.error;
    if (team.error) throw team.error;
    for (const c of covers) {
      if (c.kind !== "person" || !c.absent_employee_id) continue;
      for (const o of owned.data ?? []) if (o.owner_employee_id === c.absent_employee_id) reached.push({ clientId: o.id, absentId: c.absent_employee_id, endsAt: c.ends_at });
      for (const t of team.data ?? []) if (t.employee_id === c.absent_employee_id) reached.push({ clientId: t.client_id, absentId: c.absent_employee_id, endsAt: c.ends_at });
    }
  }
  if (reached.length === 0) return out;

  // A client cover with no absent person covers for the client's owner.
  const ownerless = Array.from(new Set(reached.filter((r) => !r.absentId).map((r) => r.clientId)));
  const owners = new Map<string, string | null>();
  if (ownerless.length) {
    const { data: rows, error: err } = await supabase.from("clients").select("id, owner_employee_id").in("id", ownerless);
    if (err) throw err;
    for (const r of rows ?? []) owners.set(r.id, r.owner_employee_id);
  }
  const resolved = reached.map((r) => ({ ...r, absentId: r.absentId ?? owners.get(r.clientId) ?? null }));
  const names = await getEmployeeNames(supabase, resolved.map((r) => r.absentId));
  for (const r of resolved) {
    const prev = out.get(r.clientId);
    if (!prev || prev.endsAt < r.endsAt) out.set(r.clientId, { absentName: (r.absentId && names.get(r.absentId)) || "a colleague", endsAt: r.endsAt });
  }
  return out;
}

export interface WindowEvent {
  id: string;
  client_id: string | null;
  client_name: string | null;
  event_type: string;
  title: string;
  description: string | null;
  performed_by_name: string | null;
  created_at: string;
}

/**
 * "See what changed" (§4.7 Ending): the timelines of the clients a cover reached, during its window
 * (From to the earlier of Until and when it was ended). Read under the viewer's RLS, so an Employee
 * sees their own clients' events and never the money-side ones (0043).
 */
export async function getCoverWindowEvents(supabase: ServerSupabase, cover: CoverRow, limit = 60): Promise<WindowEvent[]> {
  let clientIds: string[] = [];
  if (cover.kind === "client") clientIds = cover.client_id ? [cover.client_id] : [];
  else if (cover.absent_employee_id) {
    const [owned, team] = await Promise.all([
      supabase.from("clients").select("id").eq("owner_employee_id", cover.absent_employee_id).is("deleted_at", null).limit(2000),
      supabase.from("client_team_members").select("client_id").eq("employee_id", cover.absent_employee_id).limit(2000),
    ]);
    if (owned.error) throw owned.error;
    if (team.error) throw team.error;
    clientIds = Array.from(new Set([...(owned.data ?? []).map((c) => c.id), ...(team.data ?? []).map((t) => t.client_id)]));
  }
  if (clientIds.length === 0) return [];
  const until = cover.revoked_at && cover.revoked_at < cover.ends_at ? cover.revoked_at : cover.ends_at;
  const { data, error } = await supabase
    .from("client_timeline_events")
    .select("id, client_id, event_type, title, description, performed_by, created_at, clients(display_name)")
    .in("client_id", clientIds)
    .gte("created_at", cover.starts_at)
    .lte("created_at", until)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const names = await getNamesByProfile(supabase, (data ?? []).map((e) => e.performed_by));
  return (data ?? []).map((e) => ({
    id: e.id,
    client_id: e.client_id,
    client_name: (e.clients as { display_name?: string } | null)?.display_name ?? null,
    event_type: e.event_type,
    title: e.title,
    description: e.description,
    performed_by_name: e.performed_by ? (names.get(e.performed_by) ?? null) : null,
    created_at: e.created_at,
  }));
}

// -------------------------------------------------------------------------------------------------
// Absent today without cover (§7.2 Manager dashboard, §4.7 "Where a cover is created", §8)
// -------------------------------------------------------------------------------------------------

export interface AbsentWithoutCoverRow {
  employee_id: string;
  full_name: string;
  designation: string | null;
  /** On approved leave today, or not signed in by the start of the day + grace + 30 minutes. */
  why: "on_leave" | "not_signed_in";
  /** The last day of the leave, when on leave. */
  leave_until: DateString | null;
  /** Open tasks due within 2 days (overdue ones too) on their clients no cover reaches. */
  due_tasks: number;
  clients: number;
  /** The earliest of those due dates. */
  next_due: DateString | null;
}

export interface AbsentWithoutCover {
  workingDay: boolean;
  /** "10:15": after this, someone who hasn't signed in counts as absent. */
  cutoff: string;
  /** Tasks count when due on or before this date. */
  dueBy: DateString;
  rows: AbsentWithoutCoverRow[];
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The Manager dashboard's "Absent today without cover" list (§7.2): people on leave today, or not
 * signed in by the start of the day + grace + 30 minutes, whose clients have open tasks due within
 * 2 days and no cover in force reaching them. The same rule as the 10:00 job
 * (server/jobs/absent-without-cover.ts, lib/domain/cover.ts isAbsentWithoutCover), read under the
 * viewer's RLS: Partners and Managers see everyone; for anyone else the list comes back empty.
 */
export async function getAbsentWithoutCover(supabase: ServerSupabase, now: Date = new Date()): Promise<AbsentWithoutCover> {
  const today = todayIST(now);
  const calendar = await getWorkingCalendar(supabase, today, today);
  const startMinutes = parseTimeOfDay(calendar.attendance.workDayStart) + calendar.attendance.lateGraceMinutes + COVER_DEFAULTS.noShowAfterMinutes;
  const dueBy = addDays(today, COVER_DEFAULTS.tasksDueWithinDays);
  const out: AbsentWithoutCover = { workingDay: true, cutoff: clock(startMinutes), dueBy, rows: [] };
  if (!isWorkingDay(today, { weekdays: calendar.weekdays, holidays: calendar.holidays })) {
    out.workingDay = false;
    return out;
  }

  const { start } = istDayBounds(today);
  const [staff, leave, sessions, covers] = await Promise.all([
    supabase.from("people_overview").select("id, full_name, designation, login_status").eq("login_status", "active").limit(1000),
    supabase.from("employee_leave").select("employee_id, end_date").eq("status", "approved").lte("start_date", today).gte("end_date", today).limit(1000),
    supabase.from("employee_sessions").select("employee_id, login_at, last_active_at").gte("last_active_at", start.toISOString()).limit(5000),
    supabase.from("covers_in_force").select("kind, client_id, absent_employee_id").limit(5000),
  ]);
  for (const r of [staff, leave, sessions, covers]) if (r.error) throw r.error;

  const leaveUntil = new Map<string, DateString>();
  for (const l of leave.data ?? []) {
    const prev = leaveUntil.get(l.employee_id);
    if (!prev || prev < l.end_date) leaveUntil.set(l.employee_id, l.end_date);
  }
  const signedIn = new Map<string, string>();
  for (const s of sessions.data ?? []) {
    const at = s.login_at > start.toISOString() ? s.login_at : start.toISOString();
    const prev = signedIn.get(s.employee_id);
    if (!prev || at < prev) signedIn.set(s.employee_id, at);
  }
  const personCovered = new Set<string>();
  const clientCovered = new Set<string>();
  for (const c of covers.data ?? []) {
    if (c.kind === "person" && c.absent_employee_id) personCovered.add(c.absent_employee_id);
    if (c.kind === "client" && c.client_id) clientCovered.add(c.client_id);
  }

  // Who is away at all (before looking at their clients): on leave, or a no-show past the cutoff.
  const base = { now, isWorkingDay: true, workDayStart: calendar.attendance.workDayStart, lateGraceMinutes: calendar.attendance.lateGraceMinutes, hasTasksDueSoon: true, hasCoverInForce: false };
  const away = (staff.data ?? []).filter((p) => {
    const id = p.id as string;
    return !personCovered.has(id) && isAbsentWithoutCover({ ...base, onLeaveToday: leaveUntil.has(id), signedInAt: signedIn.get(id) ?? null });
  });
  if (away.length === 0) return out;

  const ids = away.map((p) => p.id as string);
  const [owned, team] = await Promise.all([
    supabase.from("clients").select("id, owner_employee_id").in("owner_employee_id", ids).is("deleted_at", null).limit(5000),
    supabase.from("client_team_members").select("client_id, employee_id").in("employee_id", ids).limit(5000),
  ]);
  if (owned.error) throw owned.error;
  if (team.error) throw team.error;
  const clientsOf = new Map<string, Set<string>>();
  const add = (eid: string | null, cid: string) => {
    if (!eid || clientCovered.has(cid)) return;
    const set = clientsOf.get(eid) ?? new Set<string>();
    set.add(cid);
    clientsOf.set(eid, set);
  };
  for (const c of owned.data ?? []) add(c.owner_employee_id, c.id);
  for (const t of team.data ?? []) add(t.employee_id, t.client_id);
  const allClients = Array.from(new Set(Array.from(clientsOf.values()).flatMap((s) => Array.from(s))));
  if (allClients.length === 0) return out;

  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .select("client_id, due_date")
    .in("client_id", allClients)
    .is("deleted_at", null)
    .neq("status", "filed_done")
    .lte("due_date", dueBy)
    .limit(10000);
  if (taskError) throw taskError;
  const dueByClient = new Map<string, DateString[]>();
  for (const t of tasks ?? []) {
    if (!t.due_date) continue;
    dueByClient.set(t.client_id, [...(dueByClient.get(t.client_id) ?? []), t.due_date]);
  }

  for (const p of away) {
    const id = p.id as string;
    const clients = Array.from(clientsOf.get(id) ?? []).filter((c) => dueByClient.has(c));
    const dates = clients.flatMap((c) => dueByClient.get(c) ?? []).sort();
    if (dates.length === 0) continue;
    out.rows.push({
      employee_id: id,
      full_name: p.full_name ?? "",
      designation: p.designation,
      why: leaveUntil.has(id) ? "on_leave" : "not_signed_in",
      leave_until: leaveUntil.get(id) ?? null,
      due_tasks: dates.length,
      clients: clients.length,
      next_due: dates[0],
    });
  }
  out.rows.sort((a, b) => (a.next_due ?? "").localeCompare(b.next_due ?? "") || b.due_tasks - a.due_tasks || a.full_name.localeCompare(b.full_name));
  return out;
}

import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, financialYearOf, isoWeekday, todayIST, type DateString } from "@/lib/domain/fy";
import { CAPACITY_BAND_LABELS, assessCapacity, formatPerDay, readCapacityThresholds, workingDaysLeft, type CapacityBand, type LeaveSpan } from "@/lib/domain/capacity";
import { capacityWindow } from "@/lib/schemas/people";
import { OPEN_TASK_STATUSES } from "@/lib/schemas/tasks";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { notify } from "@/server/notify";

/**
 * Team health, Mondays 08:30 IST (§8):
 *   1. Capacity alerts to Managers (§7.11.4): everyone whose open tasks due in the next two weeks
 *      come to TIGHT or OVER against their working days left (weekends, holidays and approved
 *      leave excluded; the firm's bands from Settings → Working hours), in one notice.
 *   2. Leads untouched for 14 days (§7.5.1): how many open leads have had no call, note, stage
 *      change or quotation for 14 days, to Partners and Managers only (leads are money-side, §4.1;
 *      the lead's owner already hears about each one from the hourly lead job).
 *   3. Unassigned tasks: open tasks with nobody on them (declined ones included), to Managers.
 *   4. Clients with active services and no engagement letter Issued or Signed for the current FY
 *      (§7.15.3, §6.8 SA 210), to Partners and Managers.
 * One notice per part per week (dedupe key on the Monday), so a second run in the same week tells
 * nobody anything new. A part that fails is logged with its Ref and the others still run (§8).
 */

/** Leads untouched this long surface (§7.5.1). */
export const STALE_LEAD_DAYS = 14;

const PAGE = 1000;

/** The Monday of the IST week containing `date`: the week's dedupe key. */
export function weekKey(date: DateString): DateString {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** "Ravi Kumar OVER (5.2 a day), Anita Rao TIGHT (2.8 a day) and 2 more". */
export function capacityLine(people: ReadonlyArray<{ name: string; band: CapacityBand; perDay: string }>, max = 4): string {
  const shown = people.slice(0, max).map((p) => `${p.name} ${CAPACITY_BAND_LABELS[p.band]} (${p.perDay} a day)`);
  const rest = people.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** "Sharma Traders, Beta Industries and 3 more" (`total` when there are more than the names given). */
export function namesLine(names: readonly string[], max = 3, total: number = names.length): string {
  const shown = names.slice(0, max);
  const rest = Math.max(total, names.length) - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, cap = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

type Counts = {
  people_checked: number;
  over_capacity: number;
  stale_leads: number;
  unassigned_tasks: number;
  clients_without_letter: number;
  notified: number;
  failed: number;
};

async function capacityAlerts(admin: AdminSupabase, today: DateString, week: DateString, counts: Counts): Promise<void> {
  const window = capacityWindow(today);
  const [staff, settings, holidays, leave, tasks] = await Promise.all([
    admin.from("employees").select("id, full_name, profiles!inner(is_active, role)").eq("is_active", true).is("deleted_at", null).not("profile_id", "is", null).limit(5000),
    admin.from("firm_settings").select("working_weekdays, capacity_thresholds").eq("id", 1).maybeSingle(),
    admin.from("holidays").select("date").gte("date", window.from).lte("date", window.to),
    admin.from("employee_leave").select("employee_id, start_date, end_date, half_day").eq("status", "approved").lte("start_date", window.to).gte("end_date", window.from).limit(5000),
    fetchAll<{ assigned_employee_id: string | null }>((a, b) =>
      admin.from("tasks").select("assigned_employee_id").not("assigned_employee_id", "is", null).is("deleted_at", null).neq("status", "filed_done").lte("due_date", window.to).order("id").range(a, b),
    ),
  ]);
  for (const r of [staff, settings, holidays, leave]) if (r.error) throw r.error;

  const weekdays = settings.data?.working_weekdays?.length ? settings.data.working_weekdays.map(Number) : [1, 2, 3, 4, 5, 6];
  const thresholds = readCapacityThresholds(settings.data?.capacity_thresholds);
  const holidayDates = (holidays.data ?? []).map((h) => h.date);
  const leaves = new Map<string, LeaveSpan[]>();
  for (const l of leave.data ?? []) leaves.set(l.employee_id, [...(leaves.get(l.employee_id) ?? []), { start: l.start_date, end: l.end_date, status: "approved", halfDay: l.half_day }]);
  const open = new Map<string, number>();
  for (const t of tasks) if (t.assigned_employee_id) open.set(t.assigned_employee_id, (open.get(t.assigned_employee_id) ?? 0) + 1);

  const flagged: Array<{ name: string; band: CapacityBand; perDay: string; rank: number }> = [];
  for (const e of staff.data ?? []) {
    const profile = e.profiles as { is_active: boolean; role: string } | null;
    if (!profile?.is_active || profile.role === "client") continue;
    counts.people_checked++;
    const n = open.get(e.id) ?? 0;
    if (n === 0) continue;
    const days = workingDaysLeft(window.from, window.to, { weekdays, holidays: holidayDates, leaves: leaves.get(e.id) ?? [] });
    const a = assessCapacity(n, days, thresholds);
    if (a.band === "tight" || a.band === "over") {
      flagged.push({ name: e.full_name, band: a.band, perDay: formatPerDay(n, days), rank: a.perDay ?? Number.POSITIVE_INFINITY });
    }
  }
  counts.over_capacity = flagged.length;
  if (flagged.length === 0) return;
  flagged.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, "en-IN"));
  const over = flagged.filter((f) => f.band === "over").length;
  await notify({
    to: { roles: ["manager"] },
    type: "warning",
    title: over > 0 ? `${over} ${over === 1 ? "person is" : "people are"} over capacity for the next two weeks` : `${flagged.length} ${flagged.length === 1 ? "person is" : "people are"} running tight for the next two weeks`,
    body: `${capacityLine(flagged)}. Open tasks due by ${formatDate(window.to)} over the working days left. Move or reassign work before the week fills up.`,
    linkUrl: "/people",
    entity: null,
    dedupeKey: `team_health:capacity:${week}`,
  });
  counts.notified++;
}

async function staleLeads(admin: AdminSupabase, now: Date, week: DateString, counts: Counts): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_LEAD_DAYS * 86_400_000).toISOString();
  const { data, error, count } = await admin
    .from("leads")
    .select("id, name, company", { count: "exact" })
    .is("deleted_at", null)
    .not("status", "in", "(won,lost)")
    .lt("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: true })
    .limit(5);
  if (error) throw error;
  const total = count ?? 0;
  counts.stale_leads = total;
  if (total === 0) return;
  const names = (data ?? []).map((l) => l.company || l.name);
  await notify({
    to: { roles: ["partner", "manager"] },
    type: "info",
    title: `${total} ${total === 1 ? "lead has" : "leads have"} gone ${STALE_LEAD_DAYS} days without contact`,
    body: `${namesLine(names, 3, total)}. Call them, or mark them lost with a reason so the pipeline stays honest.`,
    linkUrl: "/leads?flag=stale",
    entity: null,
    dedupeKey: `team_health:stale_leads:${week}`,
  });
  counts.notified++;
}

async function unassignedTasks(admin: AdminSupabase, week: DateString, counts: Counts): Promise<void> {
  const { data, error, count } = await admin
    .from("tasks")
    .select("id, title, due_date, clients(display_name)", { count: "exact" })
    .is("assigned_employee_id", null)
    .is("deleted_at", null)
    .neq("status", "filed_done")
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(1);
  if (error) throw error;
  const total = count ?? 0;
  counts.unassigned_tasks = total;
  if (total === 0) return;
  const first = (data ?? [])[0] as { title: string; due_date: string | null; clients: { display_name: string } | null } | undefined;
  const earliest = first?.due_date ? ` The earliest is ${first.title}${first.clients?.display_name ? ` for ${first.clients.display_name}` : ""}, due ${formatDate(first.due_date)}.` : "";
  await notify({
    to: { roles: ["manager"] },
    type: "warning",
    title: `${total} open ${total === 1 ? "task has" : "tasks have"} nobody on ${total === 1 ? "it" : "them"}`,
    body: `Assign them from the Work tracker so they don't slip.${earliest}`,
    linkUrl: `/work?assignee=none&status=${OPEN_TASK_STATUSES.join(",")}`,
    entity: null,
    dedupeKey: `team_health:unassigned:${week}`,
  });
  counts.notified++;
}

async function missingEngagementLetters(admin: AdminSupabase, today: DateString, week: DateString, counts: Counts): Promise<void> {
  const fy = financialYearOf(today);
  const [services, letters] = await Promise.all([
    fetchAll<{ client_id: string; clients: { display_name: string; status: string; deleted_at: string | null } | null }>((a, b) =>
      admin
        .from("client_services")
        .select("client_id, clients!inner(display_name, status, deleted_at)")
        .eq("is_active", true)
        .eq("clients.status", "active")
        .is("clients.deleted_at", null)
        .order("id")
        .range(a, b) as unknown as PromiseLike<{ data: Array<{ client_id: string; clients: { display_name: string; status: string; deleted_at: string | null } | null }> | null; error: unknown }>,
    ),
    fetchAll<{ client_id: string }>((a, b) => admin.from("engagement_letters").select("client_id").eq("financial_year", fy).in("status", ["issued", "signed"]).order("id").range(a, b)),
  ]);
  const covered = new Set(letters.map((l) => l.client_id));
  const missing = new Map<string, string>();
  for (const s of services) if (!covered.has(s.client_id) && s.clients) missing.set(s.client_id, s.clients.display_name);
  counts.clients_without_letter = missing.size;
  if (missing.size === 0) return;
  const names = Array.from(missing.values()).sort((a, b) => a.localeCompare(b, "en-IN"));
  await notify({
    to: { roles: ["partner", "manager"] },
    type: "expiry_alert",
    title: `${missing.size} ${missing.size === 1 ? "client has" : "clients have"} no engagement letter for FY ${fy}`,
    body: `${namesLine(names, 3)}. Issue a letter for each before more work is done for them this year.`,
    linkUrl: `/engagement-letters?fy=${fy}&missing=1`,
    entity: null,
    dedupeKey: `team_health:engagement_letters:${fy}:${week}`,
  });
  counts.notified++;
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const week = weekKey(today);
  const counts: Counts = { people_checked: 0, over_capacity: 0, stale_leads: 0, unassigned_tasks: 0, clients_without_letter: 0, notified: 0, failed: 0 };
  const parts: Array<[string, () => Promise<void>]> = [
    ["capacity", () => capacityAlerts(admin, today, week, counts)],
    ["stale_leads", () => staleLeads(admin, now, week, counts)],
    ["unassigned", () => unassignedTasks(admin, week, counts)],
    ["engagement_letters", () => missingEngagementLetters(admin, today, week, counts)],
  ];
  for (const [name, part] of parts) {
    try {
      await part();
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: `job:team-health:${name}` });
    }
  }
  return { counts };
}

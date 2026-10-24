import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, diffDays, todayIST, type DateString } from "@/lib/domain/fy";
import { CEILING_PARAM_KEYS, resolveCeilingParams } from "@/lib/domain/ceiling";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { notify } from "@/server/notify";
import { dscAlertThreshold, parseCustody, registrationReminderDue, registrationTypeLabel, registersHref } from "@/lib/schemas/registers";
import { LETTER_EXPIRY_WINDOW_DAYS, isExpiringLetter } from "@/lib/schemas/engagement-letters";

/**
 * Register expiries, part of the 09:00 IST reminders (§8 "DSC / registration / engagement-letter
 * expiries; UDIN 60-day warnings", §9, §7.15.1, §7.15.3, §6.8):
 *   1. DSCs: an alert at 30, 15 and 7 days before expiry, to the client's owner and the Partners.
 *      A missed run still sends the next alert once (the smallest threshold reached), never twice.
 *   2. Statutory registrations: once per expiry date, when an Active registration enters its own
 *      "remind N days before" window, to the owner and the Partners.
 *   3. Engagement letters: Issued or Signed letters expiring in the next 30 days and not renewed,
 *      once per expiry date, to the Partners and the client's owner when that person is a Partner
 *      or Manager (fee data never reaches an Employee, §4.1; insert_notifications enforces it too).
 *   4. UDINs: audit reports signed with no UDIN yet (audit engagements with a report date and no
 *      UDIN, not archived): the signing (engagement) partner is told at 30, 15, 7 and 3 days left
 *      and on the last day, then once a week while it is late (§6.8: within 60 days of signing).
 * Idempotent: every notice has a dedupe key naming the record, its date and the threshold. A record
 * that fails is logged with its Ref and the run carries on.
 */

export type RegisterExpiryCounts = {
  dsc_alerts: number;
  registration_alerts: number;
  letter_alerts: number;
  udin_alerts: number;
  failed: number;
};

const PAGE = 1000;

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested in tests/unit/registers-expiries.test.ts)
// ---------------------------------------------------------------------------------------------

export function dscAlertKey(id: string, expiry: DateString, threshold: number): string {
  return `dsc_expiry:${id}:${expiry}:${threshold}`;
}

export function registrationAlertKey(id: string, expiry: DateString): string {
  return `registration_expiry:${id}:${expiry}`;
}

export function letterExpiryKey(id: string, expiry: DateString): string {
  return `engagement_letter_expiry:${id}:${expiry}`;
}

/** Days-left marks for a signed report still without a UDIN (§6.8: 60 days from signing). */
export const UDIN_ALERT_DAYS_LEFT = [30, 15, 7, 3, 0] as const;

/**
 * The UDIN warning a signed report is due for: the smallest days-left mark reached (so a missed run
 * still sends one, and none repeats), or, once late, one per week of lateness. Null when more than
 * 30 days are left.
 */
export function udinAlertStage(daysLeft: number): { key: string; late: boolean } | null {
  if (daysLeft < 0) return { key: `late:${Math.floor((-daysLeft - 1) / 7)}`, late: true };
  const hits = UDIN_ALERT_DAYS_LEFT.filter((d) => daysLeft <= d);
  return hits.length ? { key: `left:${Math.min(...hits)}`, late: false } : null;
}

export function udinAlertKey(engagementId: string, reportDate: DateString, stage: string): string {
  return `udin_missing:${engagementId}:${reportDate}:${stage}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "; the token is with the firm" / "with the client" / "with Asha Rao"; nothing when not recorded. */
export function custodyPhrase(custody: string | null | undefined): string {
  const c = parseCustody(custody);
  if (c.kind === "firm") return "; the token is with the firm";
  if (c.kind === "client") return "; the token is with the client";
  return c.kind === "person" ? `; the token is with ${c.name}` : "";
}

export function daysText(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

type ClientLite = { id: string; display_name: string; owner_employee_id: string | null; deleted_at: string | null };

async function clientsByIds(admin: AdminSupabase, ids: string[]): Promise<Map<string, ClientLite>> {
  const out = new Map<string, ClientLite>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await admin.from("clients").select("id, display_name, owner_employee_id, deleted_at").in("id", unique.slice(i, i + 200));
    if (error) throw error;
    for (const c of data ?? []) out.set(c.id, c as ClientLite);
  }
  return out;
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: RegisterExpiryCounts }> {
  const today = todayIST(now);
  const counts: RegisterExpiryCounts = { dsc_alerts: 0, registration_alerts: 0, letter_alerts: 0, udin_alerts: 0, failed: 0 };

  await dscAlerts(admin, today, counts);
  await registrationAlerts(admin, today, counts);
  await letterAlerts(admin, today, counts);
  await udinAlerts(admin, today, counts);

  return { counts };
}

async function dscAlerts(admin: AdminSupabase, today: DateString, counts: RegisterExpiryCounts) {
  try {
    const { data, error } = await admin
      .from("dsc_records")
      .select("id, client_id, holder_name, expiry_date, custody")
      .eq("status", "active")
      .gte("expiry_date", today)
      .lte("expiry_date", addDays(today, 30))
      .order("expiry_date")
      .limit(PAGE);
    if (error) throw error;
    const rows = data ?? [];
    const clients = await clientsByIds(admin, rows.map((r) => r.client_id));
    for (const d of rows) {
      try {
        const client = clients.get(d.client_id);
        if (!client || client.deleted_at) continue;
        const left = diffDays(d.expiry_date, today);
        const threshold = dscAlertThreshold(left);
        if (threshold === null) continue;
        await notify({
          to: { roles: ["partner"], employeeIds: client.owner_employee_id ? [client.owner_employee_id] : [] },
          type: "expiry_alert",
          title: `DSC of ${d.holder_name} expires ${daysText(left)}`,
          body: `${client.display_name}: the DSC of ${d.holder_name} expires on ${formatDate(d.expiry_date)}${custodyPhrase(d.custody)}. Arrange the renewal before the next filing that needs it.`,
          linkUrl: registersHref("dsc", { client: client.id }),
          entity: { type: "dsc_record", id: d.id },
          clientId: client.id,
          dedupeKey: dscAlertKey(d.id, d.expiry_date, threshold),
        });
        counts.dsc_alerts += 1;
      } catch (err) {
        counts.failed += 1;
        logUnexpected(err, { source: "job:register-expiries:dsc", dscId: d.id });
      }
    }
  } catch (err) {
    counts.failed += 1;
    logUnexpected(err, { source: "job:register-expiries:dsc" });
  }
}

async function registrationAlerts(admin: AdminSupabase, today: DateString, counts: RegisterExpiryCounts) {
  try {
    // The widest window a row may ask for is 365 days (lib/schemas/registers.ts).
    const { data, error } = await admin
      .from("statutory_registrations")
      .select("id, client_id, registration_type, registration_number, expiry_date, reminder_days, status")
      .eq("status", "active")
      .not("expiry_date", "is", null)
      .gte("expiry_date", today)
      .lte("expiry_date", addDays(today, 365))
      .order("expiry_date")
      .limit(PAGE);
    if (error) throw error;
    const due = (data ?? []).filter((r) => registrationReminderDue({ status: r.status, expiryDate: r.expiry_date, reminderDays: r.reminder_days }, today));
    const clients = await clientsByIds(admin, due.map((r) => r.client_id));
    for (const r of due) {
      try {
        const client = clients.get(r.client_id);
        if (!client || client.deleted_at || !r.expiry_date) continue;
        const left = diffDays(r.expiry_date, today);
        const label = registrationTypeLabel(r.registration_type);
        await notify({
          to: { roles: ["partner"], employeeIds: client.owner_employee_id ? [client.owner_employee_id] : [] },
          type: "expiry_alert",
          title: `${label} registration expires ${daysText(left)}`,
          body: `${client.display_name}: ${label} ${r.registration_number} expires on ${formatDate(r.expiry_date)}. Start the renewal, or mark it surrendered or cancelled in the register.`,
          linkUrl: registersHref("registrations", { client: client.id }),
          entity: { type: "statutory_registration", id: r.id },
          clientId: client.id,
          dedupeKey: registrationAlertKey(r.id, r.expiry_date),
        });
        counts.registration_alerts += 1;
      } catch (err) {
        counts.failed += 1;
        logUnexpected(err, { source: "job:register-expiries:registration", registrationId: r.id });
      }
    }
  } catch (err) {
    counts.failed += 1;
    logUnexpected(err, { source: "job:register-expiries:registrations" });
  }
}

async function letterAlerts(admin: AdminSupabase, today: DateString, counts: RegisterExpiryCounts) {
  try {
    const { data, error } = await admin
      .from("engagement_letters_register")
      .select("id, client_id, client_name, owner_employee_id, financial_year, status, expires_at, renewal_id")
      .in("status", ["issued", "signed"])
      .is("renewal_id", null)
      .gte("expires_at", today)
      .lte("expires_at", addDays(today, LETTER_EXPIRY_WINDOW_DAYS))
      .order("expires_at")
      .limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []).filter((l) => l.id && l.client_id && l.expires_at && l.status);
    // The owner gets it only when they are a Partner or Manager (money side, §4.1).
    const ownerIds = [...new Set(rows.map((l) => l.owner_employee_id).filter((v): v is string => Boolean(v)))];
    const managerOwners = new Set<string>();
    if (ownerIds.length) {
      const { data: emps, error: empError } = await admin.from("employees").select("id, profile_id").in("id", ownerIds);
      if (empError) throw empError;
      const profileIds = (emps ?? []).map((e) => e.profile_id).filter((v): v is string => Boolean(v));
      const { data: profiles, error: profileError } = profileIds.length
        ? await admin.from("profiles").select("id, role, is_active").in("id", profileIds)
        : { data: [], error: null };
      if (profileError) throw profileError;
      const managerProfiles = new Set((profiles ?? []).filter((p) => p.is_active && (p.role === "partner" || p.role === "manager")).map((p) => p.id));
      for (const e of emps ?? []) if (e.profile_id && managerProfiles.has(e.profile_id)) managerOwners.add(e.id);
    }
    for (const l of rows) {
      try {
        if (!isExpiringLetter({ status: l.status as "issued" | "signed", expiresAt: l.expires_at, renewed: Boolean(l.renewal_id) }, today)) continue;
        const left = diffDays(l.expires_at as string, today);
        await notify({
          to: { roles: ["partner"], employeeIds: l.owner_employee_id && managerOwners.has(l.owner_employee_id) ? [l.owner_employee_id] : [] },
          type: "expiry_alert",
          title: `Engagement letter expires ${daysText(left)}`,
          body: `${l.client_name}: the FY ${l.financial_year} engagement letter expires on ${formatDate(l.expires_at)}${l.status === "issued" ? " and was never signed" : ""}. Renew it for the next FY.`,
          linkUrl: `/engagement-letters/${l.id}`,
          entity: { type: "engagement_letter", id: l.id as string },
          clientId: l.client_id,
          dedupeKey: letterExpiryKey(l.id as string, l.expires_at as string),
        });
        counts.letter_alerts += 1;
      } catch (err) {
        counts.failed += 1;
        logUnexpected(err, { source: "job:register-expiries:letter", letterId: l.id });
      }
    }
  } catch (err) {
    counts.failed += 1;
    logUnexpected(err, { source: "job:register-expiries:letters" });
  }
}

const AUDIT_NAME: Record<string, string> = {
  statutory_companies_act: "statutory audit report",
  tax_audit: "tax audit report",
  gst_audit: "GST audit report",
  internal: "internal audit report",
  bank_branch: "bank branch audit report",
  stock: "stock audit report",
  certification: "certificate",
  other: "audit report",
};

async function udinAlerts(admin: AdminSupabase, today: DateString, counts: RegisterExpiryCounts) {
  try {
    const [engagements, params] = await Promise.all([
      admin
        .from("audit_engagements")
        .select("id, client_id, audit_type, financial_year, report_date, engagement_partner_id")
        .not("report_date", "is", null)
        .is("udin_record_id", null)
        .is("archived_at", null)
        .order("report_date")
        .limit(PAGE),
      admin.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").eq("key", CEILING_PARAM_KEYS.udinGenerationDays),
    ]);
    if (engagements.error) throw engagements.error;
    if (params.error) throw params.error;
    const p = resolveCeilingParams(
      (params.data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified })),
      today,
    ).params;
    const rows = engagements.data ?? [];
    const clients = await clientsByIds(admin, rows.map((r) => r.client_id));
    // engagement_partner_id names the employee row; the notice goes to that person's login.
    const partnerEmployees = [...new Set(rows.map((r) => r.engagement_partner_id).filter(Boolean))];
    const profileOf = new Map<string, string>();
    if (partnerEmployees.length) {
      const { data: emps, error } = await admin.from("employees").select("id, profile_id").in("id", partnerEmployees);
      if (error) throw error;
      for (const e of emps ?? []) if (e.profile_id) profileOf.set(e.id, e.profile_id);
    }
    for (const e of rows) {
      try {
        const client = clients.get(e.client_id);
        if (!client || client.deleted_at || !e.report_date) continue;
        const signedDays = diffDays(today, e.report_date);
        const left = p.udinGenerationDays - signedDays;
        const stage = udinAlertStage(left);
        if (!stage) continue;
        const what = AUDIT_NAME[e.audit_type] ?? "audit report";
        const profile = profileOf.get(e.engagement_partner_id) ?? null;
        await notify({
          to: profile ? { userIds: [profile] } : { roles: ["partner"] },
          type: "warning",
          title: stage.late ? `UDIN not generated: ${what} signed ${plural(signedDays, "day", "days")} ago` : `UDIN due ${daysText(left)}: ${what} of ${client.display_name}`,
          body: stage.late
            ? `${client.display_name}: the FY ${e.financial_year} ${what} was signed on ${formatDate(e.report_date)}, ${plural(signedDays, "day", "days")} ago, and has no UDIN in the register. ICAI requires it within ${p.udinGenerationDays} days of signing: generate it now and log it.`
            : `${client.display_name}: the FY ${e.financial_year} ${what} was signed on ${formatDate(e.report_date)}. Generate its UDIN by ${formatDate(addDays(e.report_date, p.udinGenerationDays))} (${p.udinGenerationDays} days from signing) and log it in the register.`,
          linkUrl: registersHref("udin", { client: client.id }),
          entity: { type: "audit_engagement", id: e.id },
          clientId: client.id,
          dedupeKey: udinAlertKey(e.id, e.report_date, stage.key),
        });
        counts.udin_alerts += 1;
      } catch (err) {
        counts.failed += 1;
        logUnexpected(err, { source: "job:register-expiries:udin", engagementId: e.id });
      }
    }
  } catch (err) {
    counts.failed += 1;
    logUnexpected(err, { source: "job:register-expiries:udins" });
  }
}

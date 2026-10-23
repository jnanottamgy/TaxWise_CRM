import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { parseDateString, todayIST, type DateString } from "@/lib/domain/fy";
import { notify } from "@/server/notify";

/**
 * Access review, on the 1st of January, April, July and October (§8; §6.10 "access reviews every
 * quarter (a Partner reviews who has which role and vault access)"; §7.15.1 "Quarterly vault access
 * review reminder for Partners"): one notice to every Partner saying who holds which role, which
 * Employees can reveal stored portal passwords, and which covers in force carry portal passwords
 * (§4.7), linking to People.
 *
 * Idempotent: one notice per calendar quarter (dedupe key `access_review:<year>-Q<n>`). It acts
 * only in the first 15 days of a quarter, so a stray manual run mid-quarter doesn't send a
 * "quarterly" review late; the counts say when it was outside the window.
 */

/** Days into a quarter in which the reminder still goes (a retried run on the 2nd still counts). */
export const ACCESS_REVIEW_WINDOW_DAYS = 15;

/** "2026-Q4" for any date in Oct–Dec 2026 (calendar quarters, as the schedule runs). */
export function calendarQuarterKey(date: DateString): string {
  const { year, month } = parseDateString(date);
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** True in the first `ACCESS_REVIEW_WINDOW_DAYS` days of January, April, July or October. */
export function inAccessReviewWindow(date: DateString): boolean {
  const { month, day } = parseDateString(date);
  return (month - 1) % 3 === 0 && day <= ACCESS_REVIEW_WINDOW_DAYS;
}

export type AccessSummary = { partners: number; managers: number; employees: number; vault: number; vaultCovers: number };

/** The notice's body: who holds what, in plain words. */
export function accessReviewBody(s: AccessSummary): string {
  const people = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    `${people(s.partners, "Partner", "Partners")}, ${people(s.managers, "Manager", "Managers")} and ${people(s.employees, "Employee", "Employees")} have access.`,
    s.vault > 0 ? `${people(s.vault, "Employee can", "Employees can")} reveal stored portal passwords (vault access).` : "No Employee has vault access.",
    s.vaultCovers > 0 ? `${people(s.vaultCovers, "cover in force includes", "covers in force include")} portal passwords.` : null,
    "Check each role and each vault grant is still right, and take away what isn't needed.",
  ];
  return parts.filter(Boolean).join(" ");
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const counts = { out_of_window: 0, partners_told: 0, failed: 0 };
  if (!inAccessReviewWindow(today)) {
    counts.out_of_window = 1;
    return { counts };
  }

  const [profiles, employees, covers] = await Promise.all([
    admin.from("profiles").select("id, role, is_active").in("role", ["partner", "manager", "employee"]).limit(5000),
    admin.from("employees").select("id, profile_id, is_active, deleted_at, vault_access").limit(5000),
    admin.from("client_covers").select("id", { count: "exact", head: true }).eq("include_vault", true).is("revoked_at", null).lte("starts_at", now.toISOString()).gt("ends_at", now.toISOString()),
  ]);
  for (const r of [profiles, employees, covers]) if (r.error) throw r.error;

  const active = (profiles.data ?? []).filter((p) => p.is_active);
  const employeeIds = new Set(active.filter((p) => p.role === "employee").map((p) => p.id));
  const summary: AccessSummary = {
    partners: active.filter((p) => p.role === "partner").length,
    managers: active.filter((p) => p.role === "manager").length,
    employees: active.filter((p) => p.role === "employee").length,
    vault: (employees.data ?? []).filter((e) => e.vault_access && e.is_active && !e.deleted_at && e.profile_id && employeeIds.has(e.profile_id)).length,
    vaultCovers: covers.count ?? 0,
  };

  const quarter = calendarQuarterKey(today);
  await notify({
    to: { roles: ["partner"] },
    type: "info",
    title: `Quarterly access review (${quarter.replace("-", " ")})`,
    body: accessReviewBody(summary),
    linkUrl: "/people",
    entity: null,
    dedupeKey: `access_review:${quarter}`,
  });
  counts.partners_told = summary.partners;
  return { counts };
}

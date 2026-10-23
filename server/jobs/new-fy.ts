import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { diffDays, financialYearOf, fyShort, fyStart, previousFinancialYear, todayIST, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { namesLine } from "@/server/jobs/team-health";
import { notify } from "@/server/notify";

/**
 * New financial year, 1 April (§8 "Rolls FY-scoped number series; reminds about engagement letter
 * renewals and annual independence declarations; asks a Partner to review §6 parameters for the
 * new Finance Act").
 *
 *   1. Number series. next_document_number (0031) already restarts each FY-scoped series (invoice,
 *      credit note, quotation, receipt) at 0001 with the first document DATED in the new FY, under
 *      its row lock. Rolling the rows here instead would be wrong: a March invoice raised on
 *      2 April must still take the old year's next number, and a series that had moved on would
 *      refuse it. So this step only tells the Partners which series restart and what the first
 *      number will look like.
 *   2. Engagement letters (§7.15.3): clients with active services whose letter for last year was
 *      Issued or Signed and who have none for the new year: renew them. Partners and Managers.
 *   3. Independence declarations (§7.15.4): how many active staff haven't declared for the new
 *      year. Partners.
 *   4. Law parameters (§6, §5.12): the Finance Act may have changed rates, limits and dates; a
 *      Partner reviews Settings → Law and confirms each value. Partners.
 *
 * Idempotent: every notice is keyed to the FY (`new_fy:<fy>:<part>`). It acts only in the first 30
 * days of the FY, so a manual run in October doesn't announce April's news; the counts say so. A
 * part that fails is logged with its Ref and the others still run (§8).
 */

export const NEW_FY_WINDOW_DAYS = 30;

/** The FY-scoped series and what they number (0031). */
export const FY_SCOPED_SERIES: ReadonlyArray<{ key: string; label: string; defaultPrefix: string; prefixColumn: "invoice_prefix" | "credit_note_prefix" | "quotation_prefix" | "receipt_prefix" }> = [
  { key: "invoice", label: "Invoices", defaultPrefix: "TW", prefixColumn: "invoice_prefix" },
  { key: "credit_note", label: "Credit notes", defaultPrefix: "TW-CN", prefixColumn: "credit_note_prefix" },
  { key: "quotation", label: "Quotations", defaultPrefix: "TW-Q", prefixColumn: "quotation_prefix" },
  { key: "receipt", label: "Receipts", defaultPrefix: "TW-R", prefixColumn: "receipt_prefix" },
];

/** True in the first `NEW_FY_WINDOW_DAYS` days of a financial year (1 April onwards). */
export function inNewFyWindow(today: DateString): boolean {
  const days = diffDays(today, fyStart(financialYearOf(today)));
  return days >= 0 && days < NEW_FY_WINDOW_DAYS;
}

/** "TW/27-28/0001": the first number of an FY-scoped series in `fy` (same shape as next_document_number). */
export function firstNumberOf(prefix: string, fy: FinancialYear): string {
  return `${prefix}/${fyShort(fy)}/0001`;
}

type Counts = { out_of_window: number; series_restarting: number; letters_to_renew: number; declarations_due: number; parameters_unverified: number; notified: number; failed: number };

const PAGE = 1000;

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

async function numberSeries(admin: AdminSupabase, fy: FinancialYear, counts: Counts): Promise<void> {
  const [series, settings] = await Promise.all([
    admin.from("number_series").select("key, financial_year, next_value").in("key", FY_SCOPED_SERIES.map((s) => s.key)),
    admin.from("firm_settings").select("invoice_prefix, credit_note_prefix, quotation_prefix, receipt_prefix").eq("id", 1).maybeSingle(),
  ]);
  if (series.error) throw series.error;
  if (settings.error) throw settings.error;
  const byKey = new Map((series.data ?? []).map((s) => [s.key, s]));
  const restarting = FY_SCOPED_SERIES.filter((s) => byKey.get(s.key)?.financial_year !== fy);
  counts.series_restarting = restarting.length;
  if (restarting.length === 0) return;
  const examples = restarting.map((s) => {
    const prefix = (settings.data?.[s.prefixColumn] ?? s.defaultPrefix) || s.defaultPrefix;
    return `${s.label} ${firstNumberOf(prefix, fy)}`;
  });
  await notify({
    to: { roles: ["partner"] },
    type: "info",
    title: `FY ${fy}: document numbers start again at 0001`,
    body: `The first document dated on or after ${formatDate(fyStart(fy))} takes the new year's first number: ${examples.join(", ")}. Documents dated in March still take last year's numbers. Check the prefixes in Settings → Numbering.`,
    linkUrl: "/settings/numbering",
    entity: null,
    dedupeKey: `new_fy:${fy}:numbering`,
  });
  counts.notified++;
}

async function engagementRenewals(admin: AdminSupabase, fy: FinancialYear, counts: Counts): Promise<void> {
  const previous = previousFinancialYear(fy);
  const [services, lastYear, thisYear] = await Promise.all([
    fetchAll<{ client_id: string; clients: { display_name: string } | null }>((a, b) =>
      admin
        .from("client_services")
        .select("client_id, clients!inner(display_name, status, deleted_at)")
        .eq("is_active", true)
        .eq("clients.status", "active")
        .is("clients.deleted_at", null)
        .order("id")
        .range(a, b) as unknown as PromiseLike<{ data: Array<{ client_id: string; clients: { display_name: string } | null }> | null; error: unknown }>,
    ),
    fetchAll<{ client_id: string }>((a, b) => admin.from("engagement_letters").select("client_id").eq("financial_year", previous).in("status", ["issued", "signed"]).order("id").range(a, b)),
    fetchAll<{ client_id: string }>((a, b) => admin.from("engagement_letters").select("client_id").eq("financial_year", fy).neq("status", "declined").order("id").range(a, b)),
  ]);
  const had = new Set(lastYear.map((l) => l.client_id));
  const has = new Set(thisYear.map((l) => l.client_id));
  const due = new Map<string, string>();
  for (const s of services) if (had.has(s.client_id) && !has.has(s.client_id) && s.clients) due.set(s.client_id, s.clients.display_name);
  counts.letters_to_renew = due.size;
  if (due.size === 0) return;
  const names = Array.from(due.values()).sort((a, b) => a.localeCompare(b, "en-IN"));
  await notify({
    to: { roles: ["partner", "manager"] },
    type: "expiry_alert",
    title: `${due.size} engagement ${due.size === 1 ? "letter" : "letters"} to renew for FY ${fy}`,
    body: `${namesLine(names, 3)} had a letter for FY ${previous} and none yet for FY ${fy}. Renew each for the new year (scope and services carry over).`,
    linkUrl: `/engagement-letters?fy=${fy}&missing=1`,
    entity: null,
    dedupeKey: `new_fy:${fy}:engagement_letters`,
  });
  counts.notified++;
}

async function independenceDeclarations(admin: AdminSupabase, fy: FinancialYear, counts: Counts): Promise<void> {
  const [staff, declared] = await Promise.all([
    admin.from("employees").select("id, profiles!inner(is_active, role)").eq("is_active", true).is("deleted_at", null).not("profile_id", "is", null).limit(5000),
    admin.from("independence_declarations").select("employee_id").eq("financial_year", fy).limit(5000),
  ]);
  if (staff.error) throw staff.error;
  if (declared.error) throw declared.error;
  const done = new Set((declared.data ?? []).map((d) => d.employee_id));
  const people = (staff.data ?? []).filter((e) => {
    const p = e.profiles as { is_active: boolean; role: string } | null;
    return p?.is_active && p.role !== "client";
  });
  const pending = people.filter((e) => !done.has(e.id)).length;
  counts.declarations_due = pending;
  if (pending === 0) return;
  await notify({
    to: { roles: ["partner"] },
    type: "info",
    title: `Independence declarations for FY ${fy}`,
    body: `${pending} of ${people.length} staff haven't made their annual independence declaration for FY ${fy} yet. Collect them before attest work for the year begins.`,
    linkUrl: "/quality?tab=independence",
    entity: null,
    dedupeKey: `new_fy:${fy}:independence`,
  });
  counts.notified++;
}

async function lawReview(admin: AdminSupabase, fy: FinancialYear, counts: Counts): Promise<void> {
  const { count, error } = await admin.from("statutory_parameters").select("id", { count: "exact", head: true }).eq("verified", false);
  if (error) throw error;
  counts.parameters_unverified = count ?? 0;
  const unverified = count ?? 0;
  await notify({
    to: { roles: ["partner"] },
    type: "warning",
    title: `Review the law parameters for FY ${fy}`,
    body: `The Finance Act for the new year may have changed tax rates, limits and due dates. Review Settings → Law and confirm each value${unverified > 0 ? `; ${unverified} ${unverified === 1 ? "is" : "are"} still marked unverified` : ""}.`,
    linkUrl: "/settings/law",
    entity: null,
    dedupeKey: `new_fy:${fy}:law_review`,
  });
  counts.notified++;
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const counts: Counts = { out_of_window: 0, series_restarting: 0, letters_to_renew: 0, declarations_due: 0, parameters_unverified: 0, notified: 0, failed: 0 };
  if (!inNewFyWindow(today)) {
    counts.out_of_window = 1;
    return { counts };
  }
  const fy = financialYearOf(today);
  const parts: Array<[string, () => Promise<void>]> = [
    ["numbering", () => numberSeries(admin, fy, counts)],
    ["engagement_letters", () => engagementRenewals(admin, fy, counts)],
    ["independence", () => independenceDeclarations(admin, fy, counts)],
    ["law_review", () => lawReview(admin, fy, counts)],
  ];
  for (const [name, part] of parts) {
    try {
      await part();
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: `job:new-fy:${name}` });
    }
  }
  return { counts };
}

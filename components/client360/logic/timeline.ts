import { addDays, isDateString, type DateString } from "@/lib/domain/fy";
import { readParam, readParamList, type SearchParamsInput } from "@/components/app/data-table/params";

/**
 * Client 360 → Timeline (§7.3.3 tab 13, §5.11 client_timeline_events): the client's story,
 * filterable by kind of event and by date. The groups map event_type prefixes to the words people
 * use; money-side groups (leads and quotations, billing) are offered only to Partners and Managers,
 * and RLS hides those rows from Employees anyway (0043). Dates are IST days, inclusive
 * (`?from=2026-10-23&to=2026-10-25`, the link the cover-ended notice uses, §4.7). Pure and client-safe.
 */

export const TIMELINE_GROUPS = [
  { id: "onboarding", label: "Onboarding, status and portal", prefixes: ["client_", "portal_invite", "portal_revoke", "portal_restore", "portal_password"], money: false },
  { id: "work", label: "Tasks", prefixes: ["task_"], money: false },
  { id: "compliance", label: "Compliance and filings", prefixes: ["compliance_", "filing_", "udin_"], money: false },
  { id: "documents", label: "Documents", prefixes: ["document_", "checklist_"], money: false },
  { id: "messages", label: "Messages, calls and notes", prefixes: ["message_", "note_", "call_", "portal_message"], money: false },
  { id: "team", label: "Team, covers and contacts", prefixes: ["employee_", "team_", "cover_", "contact_", "kyc_", "service_"], money: false },
  { id: "sales", label: "Leads and quotations", prefixes: ["lead_", "quotation_"], money: true },
  { id: "billing", label: "Invoices, payments and fees", prefixes: ["invoice_", "payment_", "receipt_", "credit_note_", "fee_", "engagement_letter_", "tds_credit_", "portal_payment_claim"], money: true },
] as const;

export type TimelineGroupId = (typeof TIMELINE_GROUPS)[number]["id"];

export function timelineGroups(seesMoney: boolean) {
  return TIMELINE_GROUPS.filter((g) => seesMoney || !g.money);
}

/** The group an event type belongs to (the longest matching prefix wins); null for anything else ("Other"). */
export function groupOf(eventType: string): TimelineGroupId | null {
  const t = eventType.toLowerCase();
  let best: { id: TimelineGroupId; length: number } | null = null;
  for (const g of TIMELINE_GROUPS) {
    for (const p of g.prefixes) {
      if (t.startsWith(p) && (!best || p.length > best.length)) best = { id: g.id, length: p.length };
    }
  }
  return best?.id ?? null;
}

export interface TimelineFilters {
  groups: TimelineGroupId[];
  from: DateString | null;
  to: DateString | null;
  q: string;
}

/** Reads `?type=work,documents&from=…&to=…&q=…`. Unknown groups, bad dates and a reversed range are dropped. */
export function parseTimelineFilters(sp: SearchParamsInput, seesMoney: boolean): TimelineFilters {
  const allowed = new Set<string>(timelineGroups(seesMoney).map((g) => g.id));
  const groups = readParamList(sp, "type").filter((g): g is TimelineGroupId => allowed.has(g));
  const date = (name: string): DateString | null => {
    const v = readParam(sp, name);
    return v && isDateString(v) ? v : null;
  };
  let from = date("from");
  let to = date("to");
  if (from && to && from > to) [from, to] = [to, from];
  const q = (readParam(sp, "q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
  return { groups, from, to, q };
}

/**
 * The PostgREST `or` filter for the chosen groups (`event_type.like.task_*,…`), or null for all.
 * Prefixes only hold [a-z_] (a LIKE `_` matches any one character, which is harmless for snake_case
 * event types).
 */
export function groupOrFilter(groups: readonly TimelineGroupId[]): string | null {
  if (groups.length === 0) return null;
  const parts: string[] = [];
  for (const g of TIMELINE_GROUPS) {
    if (!groups.includes(g.id)) continue;
    for (const p of g.prefixes) parts.push(`event_type.like.${p}*`);
  }
  return parts.join(",");
}

/** The IST day bounds of an inclusive `from`–`to` range, as instants for created_at (IST is UTC+5:30). */
export function istRangeBounds(from: DateString | null, to: DateString | null): { gte: string | null; lt: string | null } {
  const startOf = (d: DateString) => new Date(`${d}T00:00:00+05:30`).toISOString();
  return { gte: from ? startOf(from) : null, lt: to ? startOf(addDays(to, 1)) : null };
}

/** True when any timeline filter is on. */
export function hasTimelineFilters(f: TimelineFilters): boolean {
  return f.groups.length > 0 || f.from !== null || f.to !== null || f.q !== "";
}

export interface DayGroup<T> {
  day: DateString;
  items: T[];
}

/** Rows (newest first) grouped by IST day, keeping order. */
export function groupByDay<T>(rows: readonly T[], dayOf: (row: T) => DateString): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const row of rows) {
    const day = dayOf(row);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(row);
    else out.push({ day, items: [row] });
  }
  return out;
}

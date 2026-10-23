/**
 * The calendar's state and dates (§7.7 Calendar: month / week / agenda). Everything lives in the URL
 * (§2.3), so a view can be shared and a notification can link straight to a day:
 *
 *   /calendar?view=month&date=2026-10            October 2026 (weeks start on Monday)
 *   /calendar?view=week&date=2026-10-21           the week of 19–25 Oct 2026
 *   /calendar?view=agenda&date=2026-10-23&page=2  every deadline from 23 Oct, 25 a page
 *   …&day=2026-10-20&label=GSTR-3B                the agenda for one day and one return ("+12 more")
 *   …&client=<id>&owner=<employee id>&type=gstr_3b,tds&kind=statutory|firm
 *
 * Pure and client-safe. "Today" is always a parameter.
 */
import { COMPLIANCE_TYPES, type ComplianceType } from "@/lib/domain/enums";
import { addDays, addMonths, endOfMonth, isDateString, isoWeekday, MONTH_ABBR, parseDateString, type DateString } from "@/lib/domain/fy";
import { readParam, readParamList, type SearchParamsInput } from "@/components/app/data-table/params";

export const CALENDAR_VIEWS = ["month", "week", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const CALENDAR_KINDS = ["statutory", "firm"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = { statutory: "Statutory", firm: "Firm and internal" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface CalendarState {
  view: CalendarView;
  /** Month view: the 1st; week view: the Monday; agenda: the first day listed. */
  anchor: DateString;
  /** The dates the view shows (agenda: open-ended unless one day is chosen). */
  from: DateString;
  to: DateString | null;
  /** Agenda for one day ("+N more" from a month or week cell). */
  day: DateString | null;
  /** Agenda for one return on that day (a group's label: "GSTR-3B"). */
  label: string | null;
  client: string | null;
  owner: string | null;
  types: ComplianceType[];
  kind: CalendarKind | null;
}

/** Monday on or before the date. */
export function startOfWeek(date: DateString): DateString {
  return addDays(date, 1 - isoWeekday(date));
}

/** The weeks (Monday to Sunday) that cover the month of `date`. */
export function monthWeeks(date: DateString): DateString[][] {
  const first = `${date.slice(0, 7)}-01`;
  const last = endOfMonth(first);
  const weeks: DateString[][] = [];
  for (let start = startOfWeek(first); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

export function weekDays(date: DateString): DateString[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function parseCalendarState(sp: SearchParamsInput, today: DateString): CalendarState {
  const rawView = readParam(sp, "view");
  const view: CalendarView = (CALENDAR_VIEWS as readonly string[]).includes(rawView ?? "") ? (rawView as CalendarView) : "month";
  const rawDate = (readParam(sp, "date") ?? "").trim();
  const day = (() => {
    const d = (readParam(sp, "day") ?? "").trim();
    return isDateString(d) ? d : null;
  })();
  const base: DateString = isDateString(rawDate) ? rawDate : MONTH.test(rawDate) ? `${rawDate}-01` : today;

  const client = readParam(sp, "client");
  const owner = readParam(sp, "owner");
  const kindRaw = readParam(sp, "kind");
  const label = (readParam(sp, "label") ?? "").trim().slice(0, 80) || null;
  const filters = {
    client: client && UUID.test(client) ? client : null,
    owner: owner && (UUID.test(owner) || owner === "none") ? owner : null,
    types: readParamList(sp, "type").filter((t): t is ComplianceType => (COMPLIANCE_TYPES as readonly string[]).includes(t)),
    kind: (CALENDAR_KINDS as readonly string[]).includes(kindRaw ?? "") ? (kindRaw as CalendarKind) : null,
  };

  if (view === "month") {
    const anchor = `${base.slice(0, 7)}-01`;
    const weeks = monthWeeks(anchor);
    return { view, anchor, from: weeks[0][0], to: weeks[weeks.length - 1][6], day: null, label: null, ...filters };
  }
  if (view === "week") {
    const anchor = startOfWeek(base);
    return { view, anchor, from: anchor, to: addDays(anchor, 6), day: null, label: null, ...filters };
  }
  if (day) return { view, anchor: day, from: day, to: day, day, label, ...filters };
  return { view, anchor: base, from: base, to: null, day: null, label, ...filters };
}

/** The anchor one step back (-1) or forward (+1). */
export function shiftAnchor(view: CalendarView, anchor: DateString, dir: -1 | 1): DateString {
  if (view === "month") return addMonths(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return addDays(anchor, 7 * dir);
}

/** The heading over the calendar: "October 2026", "19–25 Oct 2026", "From 23 Oct 2026", "20 Oct 2026". */
export function calendarTitle(state: Pick<CalendarState, "view" | "anchor" | "day">): string {
  const p = parseDateString(state.anchor);
  if (state.view === "month") return `${FULL_MONTHS[p.month - 1]} ${p.year}`;
  if (state.view === "week") {
    const end = parseDateString(addDays(state.anchor, 6));
    if (end.month === p.month) return `${p.day}–${end.day} ${MONTH_ABBR[p.month - 1]} ${p.year}`;
    if (end.year === p.year) return `${p.day} ${MONTH_ABBR[p.month - 1]} – ${end.day} ${MONTH_ABBR[end.month - 1]} ${p.year}`;
    return `${p.day} ${MONTH_ABBR[p.month - 1]} ${p.year} – ${end.day} ${MONTH_ABBR[end.month - 1]} ${end.year}`;
  }
  const d = `${p.day} ${MONTH_ABBR[p.month - 1]} ${p.year}`;
  return state.day ? d : `From ${d}`;
}

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** A calendar URL: the current params with some replaced (null removes one). */
export function calendarHref(current: SearchParamsInput, patch: Record<string, string | null>): string {
  const next = new URLSearchParams();
  if (current) {
    if (current instanceof URLSearchParams) current.forEach((v, k) => next.append(k, v));
    else
      for (const [k, v] of Object.entries(current)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) next.append(k, one);
      }
  }
  for (const [k, v] of Object.entries(patch)) {
    next.delete(k);
    if (v !== null && v !== "") next.set(k, v);
  }
  if (patch.view !== undefined || patch.date !== undefined || patch.day !== undefined) next.delete("page");
  next.delete("event");
  const qs = next.toString();
  return qs ? `/calendar?${qs}` : "/calendar";
}

/** The date param for a view's anchor (a month view keeps "2026-10"). */
export function dateParam(view: CalendarView, anchor: DateString): string {
  return view === "month" ? anchor.slice(0, 7) : anchor;
}

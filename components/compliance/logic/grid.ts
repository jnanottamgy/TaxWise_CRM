/**
 * The filings grid's shape (§7.7): rows = clients, columns = periods. Columns are the FY's twelve
 * months (a quarterly QRMP return spans its three months), its four quarters (TDS returns, advance
 * tax), or one per form for annual returns (ITR, ROC). Each row is laid out into cells: a run of
 * columns that one or more deadlines cover, or an empty column. Column counts ("38 of 42 filed")
 * come from every client's deadlines, not just the page. Pure and client-safe.
 */
import { addDays, addMonths, compareDates, fyStart, isDateString, MONTH_ABBR, parseDateString, parsePeriodLabel, type DateString, type FinancialYear } from "@/lib/domain/fy";
import type { GridLayout } from "@/lib/schemas/compliance";
import { eventDisplayStatus, summariseStatuses, type EventDisplay, type StatusLike } from "@/components/compliance/logic/event";

export interface GridColumn {
  key: string;
  /** Header text: "Sep", "Q2", "AOC-4". */
  label: string;
  /** Second header line: the year on April and January, "Jul–Sep", the period of a form. */
  sub: string | null;
  /** Spoken / full name: "Sep 2026", "Q2 2026-27 (Jul–Sep)", "AOC-4 for FY 2025-26". */
  name: string;
  start: DateString | null;
  end: DateString | null;
}

/** What the layout needs of a deadline (the grid RPC's `events` and `summary` rows). */
export interface GridEventLike extends StatusLike {
  form_code: string | null;
  filing_period: string | null;
  period_start: DateString | null;
  period_end: DateString | null;
}

export type GridCell<E extends GridEventLike> =
  | { kind: "events"; start: number; span: number; events: E[]; display: EventDisplay; total: number; done: number }
  | { kind: "empty"; start: number };

const QUARTER_MONTHS = ["Apr–Jun", "Jul–Sep", "Oct–Dec", "Jan–Mar"] as const;

function monthOffsetFrom(fy: FinancialYear, date: DateString): number {
  const a = parseDateString(fyStart(fy));
  const b = parseDateString(date);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** The event's period: its own dates, else its period label, else the due date's month. */
function periodOf(e: Pick<GridEventLike, "period_start" | "period_end" | "filing_period" | "due_date">): { start: DateString; end: DateString } {
  if (e.period_start && e.period_end && isDateString(e.period_start) && isDateString(e.period_end)) return { start: e.period_start, end: e.period_end };
  const parsed = e.filing_period ? parsePeriodLabel(e.filing_period) : null;
  if (parsed) return { start: parsed.start, end: parsed.end };
  const start = `${e.due_date.slice(0, 7)}-01`;
  return { start, end: start };
}

/** "H1" / "Q2" when a form's period is part of a year (MSME-1 half-years), so each gets its own column. */
function subPeriodTag(filingPeriod: string | null): string | null {
  const m = filingPeriod ? /^(H[12]|Q[1-4])\b/.exec(filingPeriod.trim()) : null;
  return m ? m[1] : null;
}

export function formColumnKey(e: Pick<GridEventLike, "form_code" | "filing_period">): string {
  const form = (e.form_code ?? "").trim() || "Other";
  const tag = subPeriodTag(e.filing_period);
  return tag ? `${form} ${tag}` : form;
}

/** The columns for a layout and FY. Form columns come from the deadlines, ordered by their earliest due date. */
export function gridColumns(layout: GridLayout, fy: FinancialYear, events: readonly GridEventLike[]): GridColumn[] {
  const start = fyStart(fy);
  if (layout === "month") {
    return Array.from({ length: 12 }, (_, i) => {
      const s = addMonths(start, i);
      const { year, month } = parseDateString(s);
      const label = MONTH_ABBR[month - 1];
      return {
        key: s.slice(0, 7),
        label,
        sub: i === 0 || month === 1 ? String(year) : null,
        name: `${label} ${year}`,
        start: s,
        end: addMonths(s, 1),
      };
    });
  }
  if (layout === "quarter") {
    return QUARTER_MONTHS.map((months, i) => ({
      key: `Q${i + 1}`,
      label: `Q${i + 1}`,
      sub: months,
      name: `Q${i + 1} ${fy} (${months})`,
      start: addMonths(start, i * 3),
      end: addMonths(start, i * 3 + 3),
    }));
  }
  const byKey = new Map<string, { first: DateString; form: string; periods: Set<string> }>();
  for (const e of events) {
    const key = formColumnKey(e);
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { first: e.due_date, form: (e.form_code ?? "").trim() || "Other", periods: new Set(e.filing_period ? [e.filing_period] : []) });
    else {
      if (compareDates(e.due_date, cur.first) < 0) cur.first = e.due_date;
      if (e.filing_period) cur.periods.add(e.filing_period);
    }
  }
  return [...byKey.entries()]
    .sort((a, b) => compareDates(a[1].first, b[1].first) || (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => {
      const tag = key === v.form ? null : key.slice(v.form.length + 1);
      const onePeriod = v.periods.size === 1 ? [...v.periods][0] : null;
      const sub = onePeriod ? onePeriod.replace(/\s*\(DIN.*\)$/, "") : tag;
      return { key, label: v.form, sub, name: onePeriod ? `${v.form} for ${onePeriod}` : tag ? `${v.form} ${tag}` : v.form, start: null, end: null };
    });
}

/** The columns an event covers, inclusive, or null when it falls outside them. */
export function columnSpan(layout: GridLayout, fy: FinancialYear, columns: readonly GridColumn[], e: GridEventLike): [number, number] | null {
  if (columns.length === 0) return null;
  if (layout === "form") {
    const i = columns.findIndex((c) => c.key === formColumnKey(e));
    return i < 0 ? null : [i, i];
  }
  const p = periodOf(e);
  let a = monthOffsetFrom(fy, p.start);
  let b = monthOffsetFrom(fy, p.end);
  if (layout === "quarter") {
    a = Math.floor(a / 3);
    b = Math.floor(b / 3);
  }
  const last = columns.length - 1;
  if (b < 0 || a > last) return null;
  return [Math.max(0, a), Math.min(last, b)];
}

/**
 * One client's row: runs of columns covered by deadlines (overlapping deadlines share a cell, so a
 * client that changed scheme mid-year never draws two cells over one month), and empty columns.
 */
export function layoutRow<E extends GridEventLike>(layout: GridLayout, fy: FinancialYear, columns: readonly GridColumn[], events: readonly E[], today: DateString): GridCell<E>[] {
  const placed = events
    .map((e) => ({ e, span: columnSpan(layout, fy, columns, e) }))
    .filter((x): x is { e: E; span: [number, number] } => x.span !== null)
    .sort((x, y) => x.span[0] - y.span[0] || x.span[1] - y.span[1] || compareDates(x.e.due_date, y.e.due_date));

  const segments: Array<{ start: number; end: number; events: E[] }> = [];
  for (const { e, span } of placed) {
    const cur = segments[segments.length - 1];
    if (cur && span[0] <= cur.end) {
      cur.end = Math.max(cur.end, span[1]);
      cur.events.push(e);
    } else {
      segments.push({ start: span[0], end: span[1], events: [e] });
    }
  }

  const cells: GridCell<E>[] = [];
  let col = 0;
  for (const seg of segments) {
    for (; col < seg.start; col++) cells.push({ kind: "empty", start: col });
    const s = summariseStatuses(seg.events, today);
    cells.push({ kind: "events", start: seg.start, span: seg.end - seg.start + 1, events: seg.events, display: s.display, total: s.total, done: s.done });
    col = seg.end + 1;
  }
  for (; col < columns.length; col++) cells.push({ kind: "empty", start: col });
  return cells;
}

export interface ColumnCount {
  total: number;
  done: number;
  overdue: number;
  /** Under review: prepared and waiting for a reviewer. */
  review: number;
  /** Not started, documents awaited or in progress (not yet overdue). */
  open: number;
  /** The earliest due date among the column's deadlines. */
  firstDue: DateString | null;
}

/** Per column, over every client's deadlines: how many there are, filed, overdue, waiting for review, open. */
export function columnCounts(layout: GridLayout, fy: FinancialYear, columns: readonly GridColumn[], events: readonly GridEventLike[], today: DateString): ColumnCount[] {
  const counts: ColumnCount[] = columns.map(() => ({ total: 0, done: 0, overdue: 0, review: 0, open: 0, firstDue: null }));
  for (const e of events) {
    const span = columnSpan(layout, fy, columns, e);
    if (!span) continue;
    const d = eventDisplayStatus(e, today);
    if (d === "cancelled") continue;
    for (let i = span[0]; i <= span[1]; i++) {
      const c = counts[i];
      c.total++;
      if (d === "filed" || d === "completed") c.done++;
      else if (d === "overdue") c.overdue++;
      else if (d === "under_review") c.review++;
      else c.open++;
      if (!c.firstDue || compareDates(e.due_date, c.firstDue) < 0) c.firstDue = e.due_date;
    }
  }
  return counts;
}

/**
 * The column the grid answers for by default (§7.7: "is everyone's GSTR-3B filed for September?"):
 * the latest one whose first return is due by `today + leadDays`; otherwise the first with any.
 */
export function focusColumn(counts: readonly ColumnCount[], today: DateString, leadDays = 10): number {
  const horizon = addDays(today, leadDays);
  let best = -1;
  counts.forEach((c, i) => {
    if (c.total > 0 && c.firstDue && compareDates(c.firstDue, horizon) <= 0) best = i;
  });
  if (best >= 0) return best;
  const first = counts.findIndex((c) => c.total > 0);
  return first >= 0 ? first : 0;
}

/** The deadlines of one row that cover a column (the cell sheet lists them). */
export function eventsInColumn<E extends GridEventLike>(layout: GridLayout, fy: FinancialYear, columns: readonly GridColumn[], events: readonly E[], index: number): E[] {
  return events.filter((e) => {
    const span = columnSpan(layout, fy, columns, e);
    return span !== null && index >= span[0] && index <= span[1];
  });
}

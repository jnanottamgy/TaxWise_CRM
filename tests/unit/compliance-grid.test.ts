import { describe, expect, it } from "vitest";
import { columnCounts, columnSpan, eventsInColumn, focusColumn, formColumnKey, gridColumns, layoutRow, type GridEventLike } from "@/components/compliance/logic/grid";

const FY = "2026-27";
const TODAY = "2026-10-23";

function month(m: string, over: Partial<GridEventLike> = {}): GridEventLike {
  const [y, mm] = m.split("-").map(Number);
  const end = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
  const due = new Date(Date.UTC(y, mm, 20)).toISOString().slice(0, 10);
  const label = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mm - 1]} ${y}`;
  return { form_code: "GSTR-3B", filing_period: label, period_start: `${m}-01`, period_end: end, due_date: due, status: "pending", workflow_status: "not_started", ...over };
}

function quarter(q: 1 | 2 | 3 | 4, over: Partial<GridEventLike> = {}): GridEventLike {
  const starts = ["2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01"];
  const ends = ["2026-06-30", "2026-09-30", "2026-12-31", "2027-03-31"];
  const dues = ["2026-07-22", "2026-10-22", "2027-01-22", "2027-04-22"];
  return { form_code: "GSTR-3B", filing_period: `Q${q} ${FY}`, period_start: starts[q - 1], period_end: ends[q - 1], due_date: dues[q - 1], status: "pending", workflow_status: "not_started", ...over };
}

describe("gridColumns", () => {
  it("months run April to March with the year on April and January", () => {
    const cols = gridColumns("month", FY, []);
    expect(cols.map((c) => c.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]);
    expect(cols[0]).toMatchObject({ key: "2026-04", sub: "2026", name: "Apr 2026" });
    expect(cols[9]).toMatchObject({ key: "2027-01", sub: "2027" });
    expect(cols[5].sub).toBeNull();
  });

  it("quarters name their months", () => {
    expect(gridColumns("quarter", FY, []).map((c) => `${c.label} ${c.sub}`)).toEqual(["Q1 Apr–Jun", "Q2 Jul–Sep", "Q3 Oct–Dec", "Q4 Jan–Mar"]);
  });

  it("forms come from the deadlines, by their earliest due date; half-years get their own column", () => {
    const ev = (form: string, due: string, period: string): GridEventLike => ({ form_code: form, filing_period: period, period_start: null, period_end: null, due_date: due, status: "pending", workflow_status: "not_started" });
    const cols = gridColumns("form", "2025-26", [
      ev("AOC-4", "2026-10-30", "FY 2025-26"),
      ev("AGM", "2026-09-30", "FY 2025-26"),
      ev("MSME-1", "2025-10-31", "H1 2025-26"),
      ev("MSME-1", "2026-04-30", "H2 2025-26"),
      ev("AOC-4", "2026-10-30", "FY 2025-26"),
    ]);
    expect(cols.map((c) => c.key)).toEqual(["MSME-1 H1", "MSME-1 H2", "AGM", "AOC-4"]);
    expect(cols[3]).toMatchObject({ label: "AOC-4", sub: "FY 2025-26", name: "AOC-4 for FY 2025-26" });
    expect(formColumnKey({ form_code: "DIR-3 KYC Web", filing_period: "FY 2026-27 (DIN 01234567)" })).toBe("DIR-3 KYC Web");
  });
});

describe("layoutRow", () => {
  const cols = gridColumns("month", FY, []);

  it("a monthly filer fills one cell per month", () => {
    const cells = layoutRow("month", FY, cols, [month("2026-04"), month("2026-05")], TODAY);
    expect(cells.slice(0, 3).map((c) => [c.kind, c.start, c.kind === "events" ? c.span : 1])).toEqual([
      ["events", 0, 1],
      ["events", 1, 1],
      ["empty", 2, 1],
    ]);
    expect(cells).toHaveLength(12);
  });

  it("a QRMP quarter spans its three months", () => {
    const cells = layoutRow("month", FY, cols, [quarter(1, { workflow_status: "filed", status: "completed" }), quarter(2)], TODAY);
    expect(cells.map((c) => (c.kind === "events" ? `${c.start}+${c.span}:${c.display}` : `${c.start}`))).toEqual(["0+3:filed", "3+3:overdue", "6", "7", "8", "9", "10", "11"]);
  });

  it("overlapping deadlines share one cell, showing the least done", () => {
    const cells = layoutRow("month", FY, cols, [month("2026-07", { workflow_status: "filed", status: "completed" }), quarter(2)], TODAY);
    const first = cells.find((c) => c.kind === "events");
    expect(first).toMatchObject({ start: 3, span: 3, total: 2, done: 1, display: "overdue" });
  });

  it("leaves out deadlines outside the FY and clamps those that straddle it", () => {
    expect(columnSpan("month", FY, cols, month("2027-04"))).toBeNull();
    expect(columnSpan("month", FY, cols, { ...month("2026-03"), period_end: "2026-04-30" })).toEqual([0, 0]);
    expect(columnSpan("quarter", FY, gridColumns("quarter", FY, []), quarter(3))).toEqual([2, 2]);
    // No period dates: the period label, then the due date's month.
    expect(columnSpan("month", FY, cols, { ...month("2026-08"), period_start: null, period_end: null })).toEqual([4, 4]);
    expect(columnSpan("month", FY, cols, { ...month("2026-08"), period_start: null, period_end: null, filing_period: null, due_date: "2026-12-05" })).toEqual([8, 8]);
  });

  it("lists the deadlines of a column", () => {
    const events = [quarter(2), month("2026-08")];
    expect(eventsInColumn("month", FY, cols, events, 4)).toHaveLength(2);
    expect(eventsInColumn("month", FY, cols, events, 3)).toHaveLength(1);
  });
});

describe("columnCounts and focusColumn", () => {
  const cols = gridColumns("month", FY, []);

  it("counts every client's deadlines per column; a quarter counts in each of its months", () => {
    const counts = columnCounts("month", FY, cols, [
      month("2026-09", { workflow_status: "filed", status: "completed" }),
      month("2026-09", { workflow_status: "under_review", due_date: "2026-10-30" }),
      month("2026-09", { due_date: "2026-10-20" }),
      quarter(2),
      month("2026-09", { status: "cancelled" }),
    ], TODAY);
    expect(counts[5]).toEqual({ total: 4, done: 1, overdue: 2, review: 1, open: 0, firstDue: "2026-10-20" });
    expect(counts[3].total).toBe(1);
    expect(counts[0].total).toBe(0);
  });

  it("answers for the latest period already due (September in late October)", () => {
    const events = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"].map((m) => month(m));
    const counts = columnCounts("month", FY, cols, events, TODAY);
    expect(cols[focusColumn(counts, TODAY)].name).toBe("Sep 2026");
    expect(focusColumn(columnCounts("month", FY, cols, [], TODAY), TODAY)).toBe(0);
    expect(focusColumn(columnCounts("month", FY, cols, [month("2027-02")], TODAY), TODAY)).toBe(10);
  });
});

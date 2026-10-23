import { describe, expect, it } from "vitest";
import {
  TimeEntrySchema,
  budgetState,
  buildWeekGrid,
  dayTargets,
  entryTimes,
  formatDurationInput,
  formatElapsed,
  parseDuration,
  readTimesheetView,
  readWeekParam,
  rowsToCopy,
  utilisation,
  weekDates,
  weekLabel,
  type GridEntry,
} from "@/lib/schemas/timesheet";

const C1 = "6f1c2b4e-1d2a-4c3b-8a9e-0f1e2d3c4b5a";
const T1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("weeks", () => {
  it("weeks start on Monday", () => {
    expect(readWeekParam("2026-10-22", "2026-01-01")).toBe("2026-10-19");
    expect(readWeekParam(null, "2026-10-25")).toBe("2026-10-19");
    expect(readWeekParam("junk", "2026-10-26")).toBe("2026-10-26");
    expect(weekDates("2026-10-19")).toHaveLength(7);
    expect(weekDates("2026-10-19")[6]).toBe("2026-10-25");
  });

  it("labels a week compactly", () => {
    expect(weekLabel("2026-10-19")).toBe("19–25 Oct 2026");
    expect(weekLabel("2026-09-28")).toBe("28 Sep – 04 Oct 2026");
    expect(weekLabel("2025-12-29")).toBe("29 Dec 2025 – 04 Jan 2026");
  });

  it("only Partners and Managers reach the team and unbilled views", () => {
    expect(readTimesheetView("team", true)).toBe("team");
    expect(readTimesheetView("team", false)).toBe("mine");
    expect(readTimesheetView("unbilled", false)).toBe("mine");
    expect(readTimesheetView("x", true)).toBe("mine");
  });
});

describe("durations", () => {
  it("reads the usual ways of typing time", () => {
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("1.5")).toBe(90);
    expect(parseDuration("2")).toBe(120);
    expect(parseDuration("0.25")).toBe(15);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("1:75")).toBeNull();
  });

  it("formats the cell and the running timer", () => {
    expect(formatDurationInput(90)).toBe("1:30");
    expect(formatDurationInput(0)).toBe("");
    expect(formatElapsed(309_000)).toBe("5:09");
    expect(formatElapsed(3_909_000)).toBe("1:05:09");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("manual entries (§7.10)", () => {
  it("a range lands on its IST date; a duration starts at midnight IST", () => {
    const r = entryTimes({ date: "2026-10-22", mode: "range", start: "09:30", end: "11:00" });
    expect(r).toEqual({ ok: true, started_at: "2026-10-22T04:00:00.000Z", ended_at: "2026-10-22T05:30:00.000Z", minutes: 90, entry_source: "manual_range" });
    const d = entryTimes({ date: "2026-10-22", mode: "duration", duration: "2h" });
    expect(d).toEqual({ ok: true, started_at: "2026-10-21T18:30:00.000Z", ended_at: null, minutes: 120, entry_source: "manual_duration" });
  });

  it("refuses an end before the start, unreadable times and more than 24 hours", () => {
    expect(entryTimes({ date: "2026-10-22", mode: "range", start: "11:00", end: "10:00" })).toMatchObject({ ok: false, field: "end" });
    expect(entryTimes({ date: "2026-10-22", mode: "range", start: "9", end: "10:00" })).toMatchObject({ ok: false, field: "start" });
    expect(entryTimes({ date: "2026-10-22", mode: "duration", duration: "25h" })).toMatchObject({ ok: false, field: "duration" });
    expect(entryTimes({ date: "", mode: "duration", duration: "1h" })).toMatchObject({ ok: false, field: "date" });
  });

  it("the schema puts the time error on its field", () => {
    const r = TimeEntrySchema.safeParse({ date: "2026-10-22", mode: "duration", duration: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["duration"]);
  });
});

describe("targets and utilisation", () => {
  it("spreads the weekly target over working days, less holidays and leave", () => {
    const dates = weekDates("2026-10-19");
    const t = dayTargets(dates, {
      weeklyHours: 48,
      weekdays: [1, 2, 3, 4, 5, 6],
      holidays: ["2026-10-20"],
      leaves: [{ start: "2026-10-22", end: "2026-10-22", halfDay: true }],
    });
    expect(t).toEqual([480, 0, 480, 240, 480, 480, 0]);
  });

  it("utilisation is billable over total, to one decimal", () => {
    expect(utilisation(300, 400)).toBe(75);
    expect(utilisation(100, 300)).toBe(33.3);
    expect(utilisation(0, 0)).toBeNull();
  });

  it("budget against actual", () => {
    expect(budgetState(null, 100)).toEqual({ state: "none", percent: null });
    expect(budgetState(100, 50)).toEqual({ state: "under", percent: 50 });
    expect(budgetState(100, 85)).toEqual({ state: "near", percent: 85 });
    expect(budgetState(100, 130)).toEqual({ state: "over", percent: 130 });
  });
});

describe("week grid (§7.10)", () => {
  const dates = weekDates("2026-10-19");
  const entry = (over: Partial<GridEntry>): GridEntry => ({
    id: "e",
    started_at: "2026-10-19T04:00:00.000Z",
    ended_at: "2026-10-19T05:00:00.000Z",
    minutes: 60,
    client_id: C1,
    task_id: T1,
    billable: true,
    entry_source: "manual_range",
    locked: false,
    invoice_id: null,
    ...over,
  });

  it("adds entries into day cells by IST date; a running timer stays aside", () => {
    const g = buildWeekGrid(
      dates,
      [
        entry({ id: "a" }),
        entry({ id: "b", started_at: "2026-10-19T19:00:00.000Z", minutes: 30 }), // 20 Oct 00:30 IST
        entry({ id: "c", started_at: "2026-10-20T18:30:00.000Z", minutes: 45, entry_source: "manual_duration", client_id: null, task_id: null, billable: false }),
        entry({ id: "r", ended_at: null, minutes: 0 }),
      ],
      [],
    );
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0].cells.map((c) => c.minutes)).toEqual([60, 30, 0, 0, 0, 0, 0]);
    expect(g.rows[1].cells[2]).toMatchObject({ minutes: 45, editable: true, durationEntryId: "c" });
    expect(g.rows[0].cells[0].editable).toBe(false); // made from a timed entry
    expect(g.dayTotals).toEqual([60, 30, 45, 0, 0, 0, 0]);
    expect(g.total).toBe(135);
    expect(g.billable).toBe(90);
    expect(g.running?.id).toBe("r");
  });

  it("keeps saved rows with no time, and locked cells read-only", () => {
    const g = buildWeekGrid(dates, [entry({ id: "a", entry_source: "manual_duration", locked: true })], [{ id: "row1", client_id: null, task_id: null, billable: false }]);
    expect(g.rows[0]).toMatchObject({ savedRowId: "row1", total: 0 });
    expect(g.rows[1].cells[0]).toMatchObject({ editable: false, locked: true });
  });

  it("copies last week's rows once, minus those already here", () => {
    const last = [
      { client_id: C1, task_id: T1, billable: true },
      { client_id: C1, task_id: T1, billable: true },
      { client_id: C1, task_id: null, billable: true },
    ];
    expect(rowsToCopy(last, [{ client_id: C1, task_id: null, billable: true }])).toEqual([{ client_id: C1, task_id: T1, billable: true }]);
  });
});

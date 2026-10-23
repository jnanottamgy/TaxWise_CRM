import { describe, expect, it } from "vitest";
import { withEvent, withoutEvent, withParams } from "@/components/compliance/logic/urls";
import { calendarHref, calendarTitle, dateParam, monthWeeks, parseCalendarState, shiftAnchor, startOfWeek, weekDays } from "@/components/compliance/logic/calendar";

const TODAY = "2026-10-23";

describe("dates", () => {
  it("weeks start on Monday", () => {
    expect(startOfWeek("2026-10-23")).toBe("2026-10-19");
    expect(startOfWeek("2026-10-19")).toBe("2026-10-19");
    expect(startOfWeek("2026-10-25")).toBe("2026-10-19");
    expect(weekDays("2026-10-21")).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  });

  it("a month view covers whole weeks", () => {
    const weeks = monthWeeks("2026-10-15");
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toBe("2026-09-28");
    expect(weeks[4][6]).toBe("2026-11-01");
    expect(monthWeeks("2027-02-01")).toHaveLength(4); // Feb 2027 starts on a Monday
  });
});

describe("parseCalendarState", () => {
  it("defaults to this month", () => {
    expect(parseCalendarState({}, TODAY)).toMatchObject({ view: "month", anchor: "2026-10-01", from: "2026-09-28", to: "2026-11-01", types: [], kind: null });
  });

  it("reads a week, an agenda, one day and the filters, ignoring anything malformed", () => {
    expect(parseCalendarState({ view: "week", date: "2026-10-23" }, TODAY)).toMatchObject({ anchor: "2026-10-19", from: "2026-10-19", to: "2026-10-25" });
    expect(parseCalendarState({ view: "agenda" }, TODAY)).toMatchObject({ anchor: TODAY, from: TODAY, to: null, day: null });
    expect(parseCalendarState({ view: "agenda", day: "2026-10-20", label: "GSTR-3B" }, TODAY)).toMatchObject({ from: "2026-10-20", to: "2026-10-20", day: "2026-10-20", label: "GSTR-3B" });
    const s = parseCalendarState({ view: "nope", date: "2026-13", type: "gstr_3b,bogus,tds", kind: "firm", client: "x", owner: "none" }, TODAY);
    expect(s).toMatchObject({ view: "month", anchor: "2026-10-01", types: ["gstr_3b", "tds"], kind: "firm", client: null, owner: "none" });
    expect(parseCalendarState({ date: "2026-12" }, TODAY).anchor).toBe("2026-12-01");
  });
});

describe("navigation", () => {
  it("steps a month, a week or a week of agenda", () => {
    expect(shiftAnchor("month", "2026-10-01", 1)).toBe("2026-11-01");
    expect(shiftAnchor("month", "2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftAnchor("week", "2026-10-19", -1)).toBe("2026-10-12");
    expect(dateParam("month", "2026-10-01")).toBe("2026-10");
    expect(dateParam("week", "2026-10-19")).toBe("2026-10-19");
  });

  it("titles the view", () => {
    expect(calendarTitle({ view: "month", anchor: "2026-10-01", day: null })).toBe("October 2026");
    expect(calendarTitle({ view: "week", anchor: "2026-10-19", day: null })).toBe("19–25 Oct 2026");
    expect(calendarTitle({ view: "week", anchor: "2026-09-28", day: null })).toBe("28 Sep – 4 Oct 2026");
    expect(calendarTitle({ view: "week", anchor: "2026-12-28", day: null })).toBe("28 Dec 2026 – 3 Jan 2027");
    expect(calendarTitle({ view: "agenda", anchor: TODAY, day: null })).toBe("From 23 Oct 2026");
    expect(calendarTitle({ view: "agenda", anchor: "2026-10-20", day: "2026-10-20" })).toBe("20 Oct 2026");
  });

  it("builds links that keep the filters and drop the page and an open event", () => {
    expect(calendarHref({ view: "agenda", page: "3", type: "tds", event: "e1" }, { view: "month", date: "2026-10" })).toBe("/calendar?type=tds&view=month&date=2026-10");
    expect(calendarHref({}, {})).toBe("/calendar");
    expect(calendarHref(new URLSearchParams("kind=firm"), { kind: null })).toBe("/calendar");
  });
});

describe("event links", () => {
  it("open and close a deadline on the current page, keeping the rest", () => {
    expect(withEvent("/filings", { type: "gstr_3b", event: "old" }, "e1")).toBe("/filings?type=gstr_3b&event=e1");
    expect(withoutEvent("/filings", { type: "gstr_3b", event: "e1" })).toBe("/filings?type=gstr_3b");
    expect(withoutEvent("/calendar", new URLSearchParams("event=e1"))).toBe("/calendar");
    expect(withParams("/filings", { type: "itr", page: "3", event: "e1" }, { fy: "2025-26", period: null }, { resetPage: true })).toBe("/filings?type=itr&fy=2025-26");
    expect(withParams("/clients/c1", { tab: "compliance" }, {})).toBe("/clients/c1?tab=compliance");
  });
});

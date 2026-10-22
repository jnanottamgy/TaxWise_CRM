import { describe, expect, it } from "vitest";
import {
  EMPTY,
  formatDate,
  formatDateRange,
  formatDateShort,
  formatDateTime,
  formatFinancialYear,
  formatMinutes,
  formatMoney,
  formatMoneyCompact,
  formatNumber,
  formatPercent,
  formatTime,
  formatTimeAgo,
  relativeDue,
  URGENCY_TONE,
} from "@/lib/format";

describe("formatDate (§3.4)", () => {
  it("prints 22 Oct 2026", () => {
    expect(formatDate("2026-10-22")).toBe("22 Oct 2026");
    expect(formatDate("2026-07-01")).toBe("01 Jul 2026");
    expect(formatDate("2027-03-31")).toBe("31 Mar 2027");
  });

  it("reads timestamps in IST, whatever the machine's timezone", () => {
    expect(formatDate("2026-10-21T19:00:00Z")).toBe("22 Oct 2026");
    expect(formatDate("2026-10-21T18:00:00Z")).toBe("21 Oct 2026");
    expect(formatDate(new Date("2026-10-21T18:30:00Z"))).toBe("22 Oct 2026");
  });

  it("prints an em dash for missing or unreadable values", () => {
    expect(EMPTY).toBe("—");
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("garbage")).toBe("—");
    expect(formatDate(new Date(Number.NaN))).toBe("—");
  });

  it("formatDateShort and formatDateRange", () => {
    expect(formatDateShort("2026-07-01")).toBe("01 Jul");
    expect(formatDateShort(null)).toBe("—");
    expect(formatDateRange("2026-07-01", "2026-07-10")).toBe("01 Jul – 10 Jul 2026");
    expect(formatDateRange("2026-03-28", "2027-04-05")).toBe("28 Mar 2026 – 05 Apr 2027");
    expect(formatDateRange("2026-07-01", "2026-07-01")).toBe("01 Jul 2026");
    expect(formatDateRange("2026-07-01", null)).toBe("01 Jul 2026");
    expect(formatDateRange(null, null)).toBe("—");
  });
});

describe("formatTime and formatDateTime (IST)", () => {
  it("prints the IST wall-clock time", () => {
    expect(formatTime("2026-10-22T08:35:00Z")).toBe("14:05");
    expect(formatTime("2026-10-22T08:35:00Z", { hour12: true })).toBe("2:05 pm");
    expect(formatTime("2026-10-21T18:30:00Z")).toBe("00:00");
    expect(formatTime("2026-10-21T18:30:00Z", { hour12: true })).toBe("12:00 am");
    expect(formatTime("2026-10-22T06:30:00Z", { hour12: true })).toBe("12:00 pm");
    expect(formatTime("2026-10-22T07:11:00Z")).toBe("12:41");
  });

  it("has no time for a date-only value", () => {
    expect(formatTime("2026-10-22")).toBe("—");
    expect(formatTime(null)).toBe("—");
  });

  it("formatDateTime", () => {
    expect(formatDateTime("2026-10-22T08:35:00Z")).toBe("22 Oct 2026, 14:05");
    expect(formatDateTime(new Date("2026-10-21T19:15:00Z"), { hour12: true })).toBe("22 Oct 2026, 12:45 am");
    expect(formatDateTime("2026-10-22")).toBe("22 Oct 2026");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("nope")).toBe("—");
  });
});

describe("relativeDue (§3.4)", () => {
  const today = "2026-10-22";

  it("today and the next three days are 'soon' (warning)", () => {
    expect(relativeDue("2026-10-22", today)).toEqual({ text: "today", urgency: "soon", days: 0 });
    expect(relativeDue("2026-10-23", today)).toEqual({ text: "tomorrow", urgency: "soon", days: 1 });
    expect(relativeDue("2026-10-24", today)).toEqual({ text: "in 2 days", urgency: "soon", days: 2 });
    expect(relativeDue("2026-10-25", today)).toEqual({ text: "in 3 days", urgency: "soon", days: 3 });
  });

  it("4 to 7 days ahead is 'week' (info)", () => {
    expect(relativeDue("2026-10-26", today)).toEqual({ text: "in 4 days", urgency: "week", days: 4 });
    expect(relativeDue("2026-10-29", today)).toEqual({ text: "in 7 days", urgency: "week", days: 7 });
  });

  it("further out is 'later'", () => {
    expect(relativeDue("2026-10-30", today)).toEqual({ text: "in 8 days", urgency: "later", days: 8 });
    expect(relativeDue("2027-01-01", today).urgency).toBe("later");
  });

  it("past dates are overdue (danger)", () => {
    expect(relativeDue("2026-10-21", today)).toEqual({ text: "1 day overdue", urgency: "overdue", days: -1 });
    expect(relativeDue("2026-10-20", today)).toEqual({ text: "2 days overdue", urgency: "overdue", days: -2 });
    expect(relativeDue("2026-09-30", today)).toEqual({ text: "22 days overdue", urgency: "overdue", days: -22 });
  });

  it("crosses month and year boundaries", () => {
    expect(relativeDue("2027-01-02", "2026-12-30").text).toBe("in 3 days");
    expect(relativeDue("2026-02-28", "2026-03-01").text).toBe("1 day overdue");
  });

  it("maps urgency to the §3.4 colours", () => {
    expect(URGENCY_TONE).toEqual({ overdue: "danger", soon: "warning", week: "info", later: "neutral" });
  });
});

describe("formatTimeAgo", () => {
  const now = new Date("2026-10-22T08:30:00Z"); // 14:00 IST

  it("reads naturally for recent activity", () => {
    expect(formatTimeAgo("2026-10-22T08:29:30Z", now)).toBe("just now");
    expect(formatTimeAgo("2026-10-22T08:29:00Z", now)).toBe("1 minute ago");
    expect(formatTimeAgo("2026-10-22T08:25:00Z", now)).toBe("5 minutes ago");
    expect(formatTimeAgo("2026-10-22T07:30:00Z", now)).toBe("1 hour ago");
    expect(formatTimeAgo("2026-10-22T06:30:00Z", now)).toBe("2 hours ago");
  });

  it("switches to days, then the date", () => {
    expect(formatTimeAgo("2026-10-21T07:00:00Z", now)).toBe("yesterday");
    expect(formatTimeAgo("2026-10-19T08:30:00Z", now)).toBe("3 days ago");
    expect(formatTimeAgo("2026-10-12T08:30:00Z", now)).toBe("12 Oct 2026");
  });

  it("treats the future as just now and missing as a dash", () => {
    expect(formatTimeAgo("2026-10-22T09:00:00Z", now)).toBe("just now");
    expect(formatTimeAgo(null, now)).toBe("—");
    expect(formatTimeAgo("2026-10-01", now)).toBe("01 Oct 2026");
  });
});

describe("money, numbers and percentages", () => {
  it("formatMoney takes database rupees", () => {
    expect(formatMoney("123456.00")).toBe("₹1,23,456.00");
    expect(formatMoney(123456.5)).toBe("₹1,23,456.50");
    expect(formatMoney(0)).toBe("₹0.00");
    expect(formatMoney("-500")).toBe("-₹500.00");
    expect(formatMoney("123456.50", { decimals: 0 })).toBe("₹1,23,457");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney("not money")).toBe("—"); // never throws during render
  });

  it("formatMoneyCompact gives the tile value and the full value for hover", () => {
    expect(formatMoneyCompact("1230000")).toEqual({ compact: "₹12.3L", full: "₹12,30,000.00" });
    expect(formatMoneyCompact(null)).toEqual({ compact: "—", full: "—" });
    expect(formatMoneyCompact("n/a")).toEqual({ compact: "—", full: "—" });
  });

  it("formatNumber groups the Indian way", () => {
    expect(formatNumber(123456)).toBe("1,23,456");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber("1234.567")).toBe("1,234.57");
    expect(formatNumber(-1234567)).toBe("-12,34,567");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(2.5, { maxDecimals: 0 })).toBe("3");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber("abc")).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
  });

  it("formatPercent", () => {
    expect(formatPercent(18)).toBe("18%");
    expect(formatPercent("18.00")).toBe("18%");
    expect(formatPercent(12.5)).toBe("12.5%");
    expect(formatPercent(12.345)).toBe("12.35%");
    expect(formatPercent(12.345, { decimals: 1 })).toBe("12.3%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent("x")).toBe("—");
  });

  it("formatMinutes", () => {
    expect(formatMinutes(135)).toBe("2h 15m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(59.6)).toBe("1h");
    expect(formatMinutes(-135)).toBe("-2h 15m");
    expect(formatMinutes(-0.2)).toBe("0m");
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(Number.NaN)).toBe("—");
  });

  it("formatFinancialYear", () => {
    expect(formatFinancialYear("2026-27")).toBe("FY 2026-27");
    expect(formatFinancialYear(null)).toBe("—");
  });
});

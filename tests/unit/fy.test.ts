import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  assessmentYearOf,
  compareDates,
  daysInMonth,
  diffDays,
  endOfMonth,
  financialYearFromStartYear,
  financialYearOf,
  FY_DEFAULTS,
  fyContains,
  fyEnd,
  fyShort,
  fyStart,
  incomeTaxActName,
  incomeTaxStatute,
  isDateString,
  isFinancialYear,
  isoWeekday,
  isSunday,
  istDateOf,
  istDayBounds,
  isWorkingDay,
  monthPeriodLabel,
  nextFinancialYear,
  nowIST,
  parseDateString,
  parseFinancialYear,
  parsePeriodLabel,
  previousFinancialYear,
  quarterLabel,
  quarterOf,
  quarterRange,
  recentFinancialYears,
  taxYearLabel,
  todayIST,
  workingDaysBetween,
} from "@/lib/domain/fy";

describe("todayIST and nowIST (§0.1 rule 13)", () => {
  it("rolls over at IST midnight (18:30 UTC)", () => {
    expect(todayIST(new Date("2026-10-21T18:29:59.999Z"))).toBe("2026-10-21");
    expect(todayIST(new Date("2026-10-21T18:30:00.000Z"))).toBe("2026-10-22");
  });

  it("handles month, year and FY boundaries", () => {
    expect(todayIST(new Date("2026-12-31T18:30:00Z"))).toBe("2027-01-01");
    expect(todayIST(new Date("2027-03-31T18:30:00Z"))).toBe("2027-04-01");
    expect(todayIST(new Date("2028-02-28T19:00:00Z"))).toBe("2028-02-29");
  });

  it("defaults to the current instant", () => {
    expect(isDateString(todayIST())).toBe(true);
  });

  it("nowIST gives the wall-clock parts", () => {
    expect(nowIST(new Date("2026-10-22T04:15:30Z"))).toEqual({
      date: "2026-10-22",
      year: 2026,
      month: 10,
      day: 22,
      hour: 9,
      minute: 45,
      second: 30,
      isoWeekday: 4, // Thursday
      minutesOfDay: 585,
    });
    expect(nowIST(new Date("2026-10-21T18:30:00Z"))).toMatchObject({ date: "2026-10-22", hour: 0, minute: 0, minutesOfDay: 0 });
  });

  it("istDateOf reads timestamps in IST and passes dates through", () => {
    expect(istDateOf("2026-03-31T20:00:00Z")).toBe("2026-04-01");
    expect(istDateOf("2026-04-01T00:30:00+05:30")).toBe("2026-04-01");
    expect(istDateOf("2026-10-22")).toBe("2026-10-22");
    expect(istDateOf(new Date("2026-10-22T10:00:00Z"))).toBe("2026-10-22");
    expect(() => istDateOf("not a date")).toThrow(RangeError);
  });

  it("istDayBounds gives the UTC range of an IST day", () => {
    const { start, end } = istDayBounds("2026-10-22");
    expect(start.toISOString()).toBe("2026-10-21T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-10-22T18:30:00.000Z");
  });
});

describe("date strings", () => {
  it("isDateString accepts real dates only", () => {
    expect(isDateString("2026-10-22")).toBe(true);
    expect(isDateString("2028-02-29")).toBe(true);
    expect(isDateString("2026-02-29")).toBe(false);
    expect(isDateString("2026-04-31")).toBe(false);
    expect(isDateString("2026-13-01")).toBe(false);
    expect(isDateString("2026-00-10")).toBe(false);
    expect(isDateString("2026-1-01")).toBe(false);
    expect(isDateString("2026-10-22T00:00:00Z")).toBe(false);
    expect(isDateString(20261022)).toBe(false);
  });

  it("parseDateString", () => {
    expect(parseDateString("2026-10-22")).toEqual({ year: 2026, month: 10, day: 22 });
    expect(() => parseDateString("2026-02-30")).toThrow(RangeError);
  });

  it("daysInMonth and endOfMonth", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonth("2026-12-01")).toBe("2026-12-31");
  });

  it("addDays crosses months, years and leap days", () => {
    expect(addDays("2026-10-22", 3)).toBe("2026-10-25");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-22", 0)).toBe("2026-10-22");
    expect(addDays("2026-10-22", 365)).toBe("2027-10-22");
  });

  it("addMonths clamps to the end of shorter months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-10-22", 12)).toBe("2027-10-22");
    expect(addMonths("2026-10-22", -14)).toBe("2025-08-22");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("diffDays is left minus right, with no DST or timezone drift", () => {
    expect(diffDays("2026-10-25", "2026-10-22")).toBe(3);
    expect(diffDays("2026-10-22", "2026-10-25")).toBe(-3);
    expect(diffDays("2027-04-01", "2026-04-01")).toBe(365);
    expect(diffDays("2028-04-01", "2027-04-01")).toBe(366);
    expect(diffDays("2026-03-29", "2026-03-28")).toBe(1); // European DST change day
    expect(["2026-10-25", "2026-01-01", "2026-10-22"].sort(compareDates)).toEqual(["2026-01-01", "2026-10-22", "2026-10-25"]);
  });

  it("isoWeekday and isSunday", () => {
    expect(isoWeekday("2026-10-19")).toBe(1); // Monday
    expect(isoWeekday("2026-10-22")).toBe(4); // Thursday
    expect(isoWeekday("2026-10-25")).toBe(7); // Sunday
    expect(isSunday("2026-10-25")).toBe(true);
    expect(isSunday("2026-10-24")).toBe(false);
    expect(isSunday("2026-05-31")).toBe(true);
  });
});

describe("financial year (§6.3)", () => {
  it("financialYearOf: 1 April starts the year", () => {
    expect(financialYearOf("2026-04-01")).toBe("2026-27");
    expect(financialYearOf("2026-03-31")).toBe("2025-26");
    expect(financialYearOf("2027-03-31")).toBe("2026-27");
    expect(financialYearOf("2026-10-22")).toBe("2026-27");
    expect(financialYearOf("2027-01-01")).toBe("2026-27");
  });

  it("financialYearOf reads an instant in IST", () => {
    expect(financialYearOf(new Date("2026-03-31T19:00:00Z"))).toBe("2026-27"); // 1 Apr 00:30 IST
    expect(financialYearOf(new Date("2026-03-31T18:00:00Z"))).toBe("2025-26"); // 31 Mar 23:30 IST
  });

  it("labels across a century", () => {
    expect(financialYearFromStartYear(2099)).toBe("2099-00");
    expect(financialYearOf("1999-04-01")).toBe("1999-00");
    expect(financialYearFromStartYear(2009)).toBe("2009-10");
  });

  it("parseFinancialYear and isFinancialYear", () => {
    expect(parseFinancialYear("2026-27")).toBe(2026);
    expect(parseFinancialYear("2099-00")).toBe(2099);
    expect(parseFinancialYear("2026-28")).toBeNull();
    expect(parseFinancialYear("26-27")).toBeNull();
    expect(parseFinancialYear("2026-2027")).toBeNull();
    expect(isFinancialYear("2025-26")).toBe(true);
    expect(isFinancialYear("2025-25")).toBe(false);
    expect(isFinancialYear(null)).toBe(false);
  });

  it("start, end, short form, previous and next", () => {
    expect(fyStart("2026-27")).toBe("2026-04-01");
    expect(fyEnd("2026-27")).toBe("2027-03-31");
    expect(fyShort("2026-27")).toBe("26-27");
    expect(fyShort("2009-10")).toBe("09-10");
    expect(fyShort("2099-00")).toBe("99-00");
    expect(previousFinancialYear("2026-27")).toBe("2025-26");
    expect(nextFinancialYear("2026-27")).toBe("2027-28");
    expect(nextFinancialYear("2099-00")).toBe("2100-01");
    expect(() => fyStart("2026-28")).toThrow(RangeError);
    expect(() => fyShort("FY 2026-27")).toThrow(RangeError);
  });

  it("fyContains", () => {
    expect(fyContains("2026-27", "2026-04-01")).toBe(true);
    expect(fyContains("2026-27", "2027-03-31")).toBe(true);
    expect(fyContains("2026-27", "2027-04-01")).toBe(false);
    expect(fyContains("2026-27", "2026-03-31")).toBe(false);
  });

  it("recentFinancialYears, newest first", () => {
    expect(recentFinancialYears("2026-10-22", 3)).toEqual(["2026-27", "2025-26", "2024-25"]);
    expect(recentFinancialYears("2026-03-31", 2)).toEqual(["2025-26", "2024-25"]);
    expect(recentFinancialYears("2026-10-22", 0)).toEqual([]);
  });
});

describe("quarters and period labels (§6.3)", () => {
  it("quarterOf: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar", () => {
    const cases: Array<[string, number]> = [
      ["2026-04-01", 1],
      ["2026-06-30", 1],
      ["2026-07-01", 2],
      ["2026-09-30", 2],
      ["2026-10-01", 3],
      ["2026-12-31", 3],
      ["2027-01-01", 4],
      ["2027-03-31", 4],
    ];
    for (const [date, q] of cases) expect(quarterOf(date), date).toBe(q);
  });

  it("quarterLabel", () => {
    expect(quarterLabel("2026-09-15")).toBe("Q2 2026-27");
    expect(quarterLabel("2027-02-10")).toBe("Q4 2026-27");
    expect(quarterLabel("2026-03-31")).toBe("Q4 2025-26");
  });

  it("quarterRange", () => {
    expect(quarterRange("2026-27", 1)).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(quarterRange("2026-27", 2)).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(quarterRange("2026-27", 3)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(quarterRange("2026-27", 4)).toEqual({ start: "2027-01-01", end: "2027-03-31" });
  });

  it("monthPeriodLabel", () => {
    expect(monthPeriodLabel("2026-09-30")).toBe("Sep 2026");
    expect(monthPeriodLabel("2027-01-01")).toBe("Jan 2027");
  });

  it("parsePeriodLabel reads months, quarters and years back", () => {
    expect(parsePeriodLabel("Sep 2026")).toEqual({ kind: "month", start: "2026-09-01", end: "2026-09-30", financialYear: "2026-27" });
    expect(parsePeriodLabel("Feb 2028")).toEqual({ kind: "month", start: "2028-02-01", end: "2028-02-29", financialYear: "2027-28" });
    expect(parsePeriodLabel("mar 2027")?.financialYear).toBe("2026-27");
    expect(parsePeriodLabel("Q2 2026-27")).toEqual({ kind: "quarter", start: "2026-07-01", end: "2026-09-30", financialYear: "2026-27" });
    expect(parsePeriodLabel("2026-27")).toEqual({ kind: "year", start: "2026-04-01", end: "2027-03-31", financialYear: "2026-27" });
    expect(parsePeriodLabel("FY 2026-27")?.kind).toBe("year");
    for (const bad of ["Foo 2026", "Q5 2026-27", "Q1 2026-28", "2026-28", "September 2026", ""]) {
      expect(parsePeriodLabel(bad), bad).toBeNull();
    }
  });

  it("monthPeriodLabel and quarterLabel round-trip", () => {
    for (const date of ["2026-04-15", "2026-12-01", "2027-03-31"]) {
      expect(parsePeriodLabel(monthPeriodLabel(date))?.start).toBe(`${date.slice(0, 7)}-01`);
      const q = parsePeriodLabel(quarterLabel(date));
      expect(q && q.start <= date && date <= q.end).toBe(true);
    }
  });
});

describe("income-tax statute and tax-year labels (§6.1)", () => {
  it("the 1961 Act governs up to FY 2025-26; the 2025 Act from FY 2026-27", () => {
    expect(FY_DEFAULTS.incomeTaxAct2025FirstYear).toBe("2026-27");
    expect(incomeTaxStatute("2019-20")).toBe("1961");
    expect(incomeTaxStatute("2025-26")).toBe("1961");
    expect(incomeTaxStatute("2026-27")).toBe("2025");
    expect(incomeTaxStatute("2030-31")).toBe("2025");
  });

  it("takes the first 2025-Act year as a parameter", () => {
    expect(incomeTaxStatute("2026-27", { incomeTaxAct2025FirstYear: "2027-28" })).toBe("1961");
    expect(taxYearLabel("2026-27", { incomeTaxAct2025FirstYear: "2027-28" })).toBe("AY 2027-28");
  });

  it("labels AY for 1961-Act years and Tax year for 2025-Act years", () => {
    expect(taxYearLabel("2025-26")).toBe("AY 2026-27");
    expect(taxYearLabel("2024-25")).toBe("AY 2025-26");
    expect(taxYearLabel("2026-27")).toBe("Tax year 2026-27");
    expect(taxYearLabel("2027-28")).toBe("Tax year 2027-28");
  });

  it("assessmentYearOf and incomeTaxActName", () => {
    expect(assessmentYearOf("2025-26")).toBe("2026-27");
    expect(incomeTaxActName("2025-26")).toBe("Income-tax Act, 1961");
    expect(incomeTaxActName("2026-27")).toBe("Income-tax Act, 2025");
  });
});

describe("working days (§7.11.4)", () => {
  const MON_SAT = [1, 2, 3, 4, 5, 6];

  it("counts both ends, skipping non-working weekdays", () => {
    expect(workingDaysBetween("2026-10-19", "2026-10-25", { weekdays: MON_SAT })).toBe(6);
    expect(workingDaysBetween("2026-10-19", "2026-10-25", { weekdays: [1, 2, 3, 4, 5] })).toBe(5);
    expect(workingDaysBetween("2026-10-19", "2026-11-01", { weekdays: MON_SAT })).toBe(12);
  });

  it("skips holidays, given as a list or a set", () => {
    expect(workingDaysBetween("2026-10-19", "2026-10-25", { weekdays: MON_SAT, holidays: ["2026-10-20"] })).toBe(5);
    expect(workingDaysBetween("2026-10-19", "2026-10-25", { weekdays: MON_SAT, holidays: new Set(["2026-10-20", "2026-10-25"]) })).toBe(5);
  });

  it("is 0 when the end is before the start, and handles a single day", () => {
    expect(workingDaysBetween("2026-10-25", "2026-10-19", { weekdays: MON_SAT })).toBe(0);
    expect(workingDaysBetween("2026-10-22", "2026-10-22", { weekdays: MON_SAT })).toBe(1);
    expect(workingDaysBetween("2026-10-25", "2026-10-25", { weekdays: MON_SAT })).toBe(0);
    expect(workingDaysBetween("2026-10-22", "2026-10-22", { weekdays: MON_SAT, holidays: ["2026-10-22"] })).toBe(0);
  });

  it("isWorkingDay", () => {
    expect(isWorkingDay("2026-10-24", { weekdays: MON_SAT })).toBe(true);
    expect(isWorkingDay("2026-10-25", { weekdays: MON_SAT })).toBe(false);
    expect(isWorkingDay("2026-10-24", { weekdays: MON_SAT, holidays: ["2026-10-24"] })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  assessCapacity,
  bandForRate,
  CAPACITY_BAND_LABELS,
  CAPACITY_DEFAULTS,
  CAPACITY_SEED_PARAMETERS,
  capacityArithmetic,
  capacityBand,
  formatPerDay,
  readCapacityThresholds,
  resolveCapacityThresholds,
  tasksPerWorkingDay,
  validateCapacityThresholds,
  workingDaysLeft,
} from "@/lib/domain/capacity";

const MON_SAT = [1, 2, 3, 4, 5, 6];
// 19 Oct 2026 is a Monday; 25 Oct a Sunday.
const MON = "2026-10-19";
const SAT = "2026-10-24";
const SUN = "2026-10-25";

describe("capacity bands (§7.11.4)", () => {
  it("CLEAR < 1.5 · BUSY ≥ 1.5 · TIGHT ≥ 2.5 · OVER ≥ 4, with the spec's defaults", () => {
    expect(CAPACITY_DEFAULTS).toEqual({ busy: 1.5, tight: 2.5, over: 4 });
    expect(capacityBand(0, 5, CAPACITY_DEFAULTS)).toBe("clear");
    expect(capacityBand(7, 5, CAPACITY_DEFAULTS)).toBe("clear"); // 1.4
    expect(capacityBand(3, 2, CAPACITY_DEFAULTS)).toBe("busy"); // exactly 1.5
    expect(capacityBand(12, 5, CAPACITY_DEFAULTS)).toBe("busy"); // 2.4
    expect(capacityBand(5, 2, CAPACITY_DEFAULTS)).toBe("tight"); // exactly 2.5
    expect(capacityBand(19, 5, CAPACITY_DEFAULTS)).toBe("tight"); // 3.8
    expect(capacityBand(20, 5, CAPACITY_DEFAULTS)).toBe("over"); // exactly 4.0
    expect(capacityBand(30, 5, CAPACITY_DEFAULTS)).toBe("over");
  });

  it("uses editable thresholds", () => {
    const t = { busy: 1, tight: 2, over: 3 };
    expect(capacityBand(5, 5, t)).toBe("busy");
    expect(capacityBand(10, 5, t)).toBe("tight");
    expect(capacityBand(15, 5, t)).toBe("over");
  });

  it("compares exactly, with no float error at the boundary", () => {
    // 1.1 × 10 is 11.000000000000002 in floating point; 11 tasks over 10 days is exactly 1.1.
    const t = { busy: 1.1, tight: 2.2, over: 3.3 };
    expect(capacityBand(11, 10, t)).toBe("busy");
    expect(capacityBand(33, 10, t)).toBe("over");
    expect(capacityBand(32, 10, t)).toBe("tight");
  });

  it("handles half working days", () => {
    expect(capacityBand(18, 4.5, CAPACITY_DEFAULTS)).toBe("over"); // 4.0
    expect(capacityBand(17, 4.5, CAPACITY_DEFAULTS)).toBe("tight"); // 3.78
  });

  it("with no working days left: OVER if anything is open, CLEAR if not; never a divide by zero", () => {
    expect(capacityBand(1, 0, CAPACITY_DEFAULTS)).toBe("over");
    expect(capacityBand(0, 0, CAPACITY_DEFAULTS)).toBe("clear");
    expect(tasksPerWorkingDay(5, 0)).toBeNull();
    expect(formatPerDay(5, 0)).toBe("—");
  });

  it("bandForRate reads a ready-made figure the same way", () => {
    expect(bandForRate(1.49, CAPACITY_DEFAULTS)).toBe("clear");
    expect(bandForRate(1.5, CAPACITY_DEFAULTS)).toBe("busy");
    expect(bandForRate(2.5, CAPACITY_DEFAULTS)).toBe("tight");
    expect(bandForRate(4, CAPACITY_DEFAULTS)).toBe("over");
    expect(CAPACITY_BAND_LABELS.over).toBe("OVER");
  });

  it("rejects nonsense counts", () => {
    expect(() => capacityBand(-1, 5, CAPACITY_DEFAULTS)).toThrow(RangeError);
    expect(() => capacityBand(1.5, 5, CAPACITY_DEFAULTS)).toThrow(RangeError);
    expect(() => capacityBand(1, 1.3, CAPACITY_DEFAULTS)).toThrow(RangeError);
    expect(() => capacityBand(1, -2, CAPACITY_DEFAULTS)).toThrow(RangeError);
  });
});

describe("tasks per working day and the arithmetic (§7.6.2)", () => {
  it("shows the arithmetic with one decimal, half-up", () => {
    expect(capacityArithmetic(20, 5)).toBe("20 open tasks over 5 working days = 4.0 a day");
    expect(formatPerDay(7, 3)).toBe("2.3");
    expect(formatPerDay(5, 3)).toBe("1.7");
    expect(formatPerDay(1, 4)).toBe("0.3"); // 0.25 → 0.3 (half-up)
    expect(formatPerDay(1, 8)).toBe("0.1"); // 0.125 → 0.1
    expect(formatPerDay(0, 3)).toBe("0.0");
    expect(formatPerDay(9, 2)).toBe("4.5");
    expect(formatPerDay(45, 1)).toBe("45.0");
  });

  it("uses singular words for one task or one day, and shows half days", () => {
    expect(capacityArithmetic(1, 1)).toBe("1 open task over 1 working day = 1.0 a day");
    expect(capacityArithmetic(9, 4.5)).toBe("9 open tasks over 4.5 working days = 2.0 a day");
    expect(capacityArithmetic(3, 0)).toBe("3 open tasks and no working days left");
  });

  it("assessCapacity bundles the figures", () => {
    expect(assessCapacity(20, 5, CAPACITY_DEFAULTS)).toEqual({
      openTasks: 20,
      workingDays: 5,
      perDay: 4,
      band: "over",
      noWorkingDaysLeft: false,
      arithmetic: "20 open tasks over 5 working days = 4.0 a day",
    });
    expect(assessCapacity(2, 0, CAPACITY_DEFAULTS)).toMatchObject({ perDay: null, band: "over", noWorkingDaysLeft: true });
  });
});

describe("workingDaysLeft (§7.11.4: excluding weekends, holidays and leave)", () => {
  it("counts both ends, skipping non-working weekdays", () => {
    expect(workingDaysLeft(MON, SAT, { weekdays: MON_SAT })).toBe(6);
    expect(workingDaysLeft(MON, SUN, { weekdays: MON_SAT })).toBe(6);
    expect(workingDaysLeft(MON, SUN, { weekdays: [1, 2, 3, 4, 5] })).toBe(5);
    expect(workingDaysLeft(MON, MON, { weekdays: MON_SAT })).toBe(1);
    expect(workingDaysLeft(SUN, SUN, { weekdays: MON_SAT })).toBe(0);
  });

  it("is 0 when the end is before the start", () => {
    expect(workingDaysLeft(SAT, MON, { weekdays: MON_SAT })).toBe(0);
  });

  it("skips firm holidays (array or set)", () => {
    expect(workingDaysLeft(MON, SAT, { weekdays: MON_SAT, holidays: ["2026-10-20"] })).toBe(5);
    expect(workingDaysLeft(MON, SAT, { weekdays: MON_SAT, holidays: new Set(["2026-10-20", "2026-10-21"]) })).toBe(4);
  });

  it("skips approved leave, ignores requested/declined leave, and takes half a day for a half-day leave", () => {
    const leaves = [
      { start: "2026-10-21", end: "2026-10-22", status: "approved" as const },
      { start: "2026-10-23", end: "2026-10-23", status: "requested" as const },
      { start: "2026-10-24", end: "2026-10-24", status: "approved" as const, halfDay: true },
    ];
    expect(workingDaysLeft(MON, SAT, { weekdays: MON_SAT, leaves })).toBe(3.5);
    // A span without a status counts as approved; leave outside the window is ignored.
    expect(workingDaysLeft(MON, SAT, { weekdays: MON_SAT, leaves: [{ start: "2026-10-01", end: "2026-10-19" }] })).toBe(5);
  });

  it("doesn't double-count leave on a holiday or overlapping leave", () => {
    const leaves = [
      { start: "2026-10-20", end: "2026-10-21" },
      { start: "2026-10-21", end: "2026-10-21", halfDay: true },
    ];
    expect(workingDaysLeft(MON, SAT, { weekdays: MON_SAT, holidays: ["2026-10-20"], leaves })).toBe(4);
  });
});

describe("thresholds: validation, reading and the seed (§7.21, §16)", () => {
  it("validates rising, positive thresholds", () => {
    expect(validateCapacityThresholds(CAPACITY_DEFAULTS)).toBeNull();
    expect(validateCapacityThresholds({ busy: 2, tight: 2, over: 4 })).toBe("Tight must be higher than Busy.");
    expect(validateCapacityThresholds({ busy: 1, tight: 4, over: 4 })).toBe("Over must be higher than Tight.");
    expect(validateCapacityThresholds({ busy: 0, tight: 2, over: 4 })).toContain("positive");
  });

  it("reads firm_settings.capacity_thresholds jsonb, falling back as a whole when it is unusable", () => {
    expect(readCapacityThresholds({ busy: 1.5, tight: 2.5, over: 4 })).toEqual(CAPACITY_DEFAULTS);
    expect(readCapacityThresholds({ busy: "1", tight: "2", over: "3" })).toEqual({ busy: 1, tight: 2, over: 3 });
    expect(readCapacityThresholds({ busy: 3, tight: 2, over: 4 })).toEqual(CAPACITY_DEFAULTS);
    expect(readCapacityThresholds({ busy: 1 })).toEqual(CAPACITY_DEFAULTS);
    expect(readCapacityThresholds(null)).toEqual(CAPACITY_DEFAULTS);
    expect(readCapacityThresholds([1, 2, 3])).toEqual(CAPACITY_DEFAULTS);
  });

  it("the seed row holds the defaults and resolves by date", () => {
    expect(CAPACITY_SEED_PARAMETERS).toHaveLength(1);
    expect(CAPACITY_SEED_PARAMETERS[0]).toMatchObject({ key: "capacity.bands", value: { busy: 1.5, tight: 2.5, over: 4 }, verified: true });
    expect(resolveCapacityThresholds(CAPACITY_SEED_PARAMETERS, "2026-10-22")).toEqual(CAPACITY_DEFAULTS);
    const rows = [...CAPACITY_SEED_PARAMETERS, { key: "capacity.bands", value: { busy: 2, tight: 3, over: 5 }, effectiveFrom: "2027-04-01" }];
    expect(resolveCapacityThresholds(rows, "2027-04-01")).toEqual({ busy: 2, tight: 3, over: 5 });
    expect(resolveCapacityThresholds([], "2026-10-22")).toEqual(CAPACITY_DEFAULTS);
  });
});

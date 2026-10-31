import { describe, expect, it } from "vitest";
import { cronMatches, lastFireTime, parseCron, runsLessThanDaily } from "@/lib/domain/cron";

const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("reads numbers, stars, lists, ranges and steps", () => {
    expect([...parseCron("7 * * * *").minutes]).toEqual([7]);
    expect(parseCron("7 * * * *").hours.size).toBe(24);
    expect([...parseCron("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0-30/10 * * * *").minutes]).toEqual([0, 10, 20, 30]);
    expect([...parseCron("5/15 * * * *").minutes]).toEqual([5, 20, 35, 50]);
    expect([...parseCron("35 3 1 1,4,7,10 *").months]).toEqual([1, 4, 7, 10]);
    expect([...parseCron("0 9 * * 1-5").weekdays]).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats 7 as Sunday, like 0", () => {
    expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
  });

  it("refuses what it can't read, naming the field", () => {
    expect(() => parseCron("0 3 * *")).toThrow(/five fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/minute/);
    expect(() => parseCron("0 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("0 0 0 * *")).toThrow(/day of month/);
    expect(() => parseCron("0 0 * 13 *")).toThrow(/month/);
    expect(() => parseCron("x * * * *")).toThrow(/Can't read "x"/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/out of range/);
  });
});

describe("cronMatches (UTC)", () => {
  it("matches the minute, hour, day and weekday", () => {
    const monday = parseCron("0 3 * * 1");
    expect(cronMatches(monday, at("2026-11-02T03:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches(monday, at("2026-11-03T03:00:00Z"))).toBe(false);
    expect(cronMatches(monday, at("2026-11-02T03:01:00Z"))).toBe(false);
    expect(cronMatches(parseCron("0 3 1 * *"), at("2026-11-01T03:00:59Z"))).toBe(true);
  });

  it("counts either day when day of month and day of week are both set, as cron does", () => {
    const spec = parseCron("0 0 13 * 5");
    expect(cronMatches(spec, at("2026-11-13T00:00:00Z"))).toBe(true); // the 13th (a Friday too)
    expect(cronMatches(spec, at("2026-11-06T00:00:00Z"))).toBe(true); // a Friday
    expect(cronMatches(spec, at("2026-11-12T00:00:00Z"))).toBe(false); // neither
  });
});

describe("lastFireTime", () => {
  it("finds the latest firing at or before now, to the minute", () => {
    expect(lastFireTime("30 3 * * *", at("2026-10-31T05:10:42Z"), 12 * 60)?.toISOString()).toBe("2026-10-31T03:30:00.000Z");
    expect(lastFireTime("30 3 * * *", at("2026-10-31T03:30:59Z"), 60)?.toISOString()).toBe("2026-10-31T03:30:00.000Z");
    expect(lastFireTime("7 * * * *", at("2026-10-31T05:06:00Z"), 120)?.toISOString()).toBe("2026-10-31T04:07:00.000Z");
  });

  it("is null when the expression didn't fire inside the look-back", () => {
    expect(lastFireTime("30 3 * * *", at("2026-10-31T05:10:00Z"), 60)).toBeNull();
    expect(lastFireTime("0 1 1 4 *", at("2026-10-31T05:10:00Z"), 3 * 24 * 60)).toBeNull();
  });

  it("reaches back across days for the rarer jobs", () => {
    expect(lastFireTime("35 3 1 1,4,7,10 *", at("2026-10-02T09:00:00Z"), 3 * 24 * 60)?.toISOString()).toBe("2026-10-01T03:35:00.000Z");
  });
});

describe("runsLessThanDaily", () => {
  it("is true for weekly, monthly and yearly expressions only", () => {
    expect(runsLessThanDaily(parseCron("0 3 1 * *"))).toBe(true);
    expect(runsLessThanDaily(parseCron("0 3 * * 1"))).toBe(true);
    expect(runsLessThanDaily(parseCron("0 1 1 4 *"))).toBe(true);
    expect(runsLessThanDaily(parseCron("30 3 * * *"))).toBe(false);
    expect(runsLessThanDaily(parseCron("7 * * * *"))).toBe(false);
  });
});

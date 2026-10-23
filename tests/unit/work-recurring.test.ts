import { describe, expect, it } from "vitest";
import {
  AutomationSchema,
  JobTemplateSchema,
  describeSchedule,
  dueRuns,
  firstRunOnOrAfter,
  nextRunAfter,
  offsetLabel,
  periodForRun,
  planRun,
  readRecurringConfig,
  recurringTitle,
  runInstant,
  stepsInDateOrder,
  type RecurringSchedule,
} from "@/lib/schemas/job-templates";

const CLIENT = "6f1c2b4e-1d2a-4c3b-8a9e-0f1e2d3c4b5a";

const monthly: RecurringSchedule = { frequency: "monthly", run_day: 1, run_month: null, run_weekday: null, period_offset: 1, due_after_days: 19 };
const quarterly: RecurringSchedule = { frequency: "quarterly", run_day: 5, run_month: null, run_weekday: null, period_offset: 1, due_after_days: 26 };
const yearly: RecurringSchedule = { frequency: "yearly", run_day: 1, run_month: 6, run_weekday: null, period_offset: 1, due_after_days: 45 };
const weekly: RecurringSchedule = { frequency: "weekly", run_day: 1, run_month: null, run_weekday: 1, period_offset: 0, due_after_days: 4 };

describe("job templates", () => {
  it("words a step's offset", () => {
    expect(offsetLabel(9)).toBe("9 days before");
    expect(offsetLabel(0)).toBe("On the due date");
    expect(offsetLabel(-1)).toBe("1 day after");
  });

  it("orders steps by their date", () => {
    expect(stepsInDateOrder([{ offset_days: 0 }, { offset_days: 9 }, { offset_days: -9 }, { offset_days: 9 }]).map((s) => s.offset_days)).toEqual([9, 9, 0, -9]);
  });

  it("needs a name, a service and at least one step", () => {
    expect(JobTemplateSchema.safeParse({ name: "x", service_type: "gst", items: [] }).success).toBe(false);
    const ok = JobTemplateSchema.parse({ name: " Monthly GST ", service_type: "gst", default_lead_days: "", items: [{ title: "Collect", offset_days: "9" }] });
    expect(ok).toMatchObject({ name: "Monthly GST", default_lead_days: null, items: [{ title: "Collect", offset_days: 9 }] });
    expect(JobTemplateSchema.safeParse({ name: "x", service_type: "gst", items: [{ title: "a", offset_days: "1.5" }] }).success).toBe(false);
  });
});

describe("recurring schedule (§7.6.7)", () => {
  it("monthly on the 1st, for the month just ended", () => {
    expect(firstRunOnOrAfter(monthly, "2026-10-22")).toBe("2026-11-01");
    expect(firstRunOnOrAfter(monthly, "2026-11-01")).toBe("2026-11-01");
    expect(nextRunAfter(monthly, "2026-11-01")).toBe("2026-12-01");
    expect(planRun(monthly, "GSTR-3B: {period}", "2026-11-01")).toEqual({
      runDate: "2026-11-01",
      period: "Oct 2026",
      financialYear: "2026-27",
      title: "GSTR-3B: Oct 2026",
      dueDate: "2026-11-20",
    });
  });

  it("quarterly in April, July, October and January", () => {
    expect(firstRunOnOrAfter(quarterly, "2026-10-22")).toBe("2027-01-05");
    expect(nextRunAfter(quarterly, "2027-01-05")).toBe("2027-04-05");
    expect(periodForRun(quarterly, "2027-01-05")).toEqual({ label: "Q3 2026-27", financialYear: "2026-27" });
    expect(periodForRun(quarterly, "2026-07-05")).toEqual({ label: "Q1 2026-27", financialYear: "2026-27" });
  });

  it("yearly, for the financial year just ended", () => {
    expect(firstRunOnOrAfter(yearly, "2026-10-22")).toBe("2027-06-01");
    expect(periodForRun(yearly, "2027-06-01")).toEqual({ label: "2026-27", financialYear: "2026-27" });
  });

  it("weekly on a weekday", () => {
    expect(firstRunOnOrAfter(weekly, "2026-10-22")).toBe("2026-10-26");
    expect(periodForRun(weekly, "2026-10-26").label).toBe("Week of 26 Oct 2026");
  });

  it("clamps a late run day to short months", () => {
    const late: RecurringSchedule = { ...monthly, run_day: 28 };
    expect(nextRunAfter(late, "2027-01-28")).toBe("2027-02-28");
  });

  it("catches up at most three missed runs, the latest ones", () => {
    expect(dueRuns(monthly, "2026-11-01", "2026-10-31")).toEqual({ runs: [], skipped: 0, next: "2026-11-01" });
    expect(dueRuns(monthly, "2026-11-01", "2026-11-01")).toEqual({ runs: ["2026-11-01"], skipped: 0, next: "2026-12-01" });
    const late = dueRuns(monthly, "2026-06-01", "2026-11-15");
    expect(late).toEqual({ runs: ["2026-09-01", "2026-10-01", "2026-11-01"], skipped: 3, next: "2026-12-01" });
  });

  it("titles a period, with or without the token", () => {
    expect(recurringTitle("GSTR-3B: {period}", "Oct 2026")).toBe("GSTR-3B: Oct 2026");
    expect(recurringTitle("Bookkeeping", "Oct 2026")).toBe("Bookkeeping – Oct 2026");
  });

  it("describes the schedule in words", () => {
    expect(describeSchedule(monthly)).toBe("On the 1st of every month, for the month just ended; due 19 days later.");
    expect(describeSchedule(weekly)).toBe("Every Monday, for that week; due 4 days later.");
    expect(describeSchedule({ ...yearly, run_day: 22 })).toBe("On 22nd June every year, for the financial year just ended; due 45 days later.");
  });

  it("reads a stored config defensively", () => {
    expect(readRecurringConfig(null)).toBeNull();
    expect(readRecurringConfig({ title: " " })).toBeNull();
    expect(readRecurringConfig({ title: "GSTR-1: {period}", run_day: 40, priority: "bogus" })).toMatchObject({ title: "GSTR-1: {period}", run_day: 1, priority: "medium", period_offset: 1 });
  });

  it("the form needs the month for yearly and the weekday for weekly", () => {
    const base = { client_id: CLIENT, title: "ITR: {period}", run_day: "1", due_after_days: "45" };
    expect(AutomationSchema.safeParse({ ...base, frequency: "yearly" }).success).toBe(false);
    expect(AutomationSchema.safeParse({ ...base, frequency: "yearly", run_month: "6" }).success).toBe(true);
    expect(AutomationSchema.safeParse({ ...base, frequency: "weekly" }).success).toBe(false);
    expect(AutomationSchema.safeParse({ ...base, frequency: "monthly", run_day: "29" }).success).toBe(false);
  });

  it("next_run_at is the start of the run date in IST", () => {
    expect(runInstant("2026-11-01")).toBe("2026-11-01T00:00:00+05:30");
    expect(new Date(runInstant("2026-11-01")).toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });
});

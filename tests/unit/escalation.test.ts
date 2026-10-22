import { describe, expect, it } from "vitest";
import {
  APPEAL_DEFAULTS,
  appealLimitationDate,
  daysOverdue,
  daysToLimitation,
  dueDateChangeRearms,
  ESCALATION_DEFAULTS,
  ESCALATION_SEED_PARAMETERS,
  escalationLevelFor,
  FOLLOW_UP_DEFAULTS,
  limitationDate,
  planEscalation,
  quotationFollowUpSchedule,
  quotationFollowUpsDue,
  readLimitationPeriod,
  rearmEscalation,
  resolveEscalationParams,
} from "@/lib/domain/escalation";
import { addDays } from "@/lib/domain/fy";

const TODAY = "2026-10-22";

describe("daysOverdue (derived, §5.5)", () => {
  it("counts days past the due date for open tasks", () => {
    expect(daysOverdue("2026-10-18", TODAY, "in_progress")).toBe(4);
    expect(daysOverdue("2026-10-21", TODAY, "on_hold")).toBe(1);
  });

  it("is 0 when due today or later, with no due date, or once Filed/Done", () => {
    expect(daysOverdue(TODAY, TODAY, "in_progress")).toBe(0);
    expect(daysOverdue("2026-10-30", TODAY, "in_progress")).toBe(0);
    expect(daysOverdue(null, TODAY, "in_progress")).toBe(0);
    expect(daysOverdue("2026-10-01", TODAY, "filed_done")).toBe(0);
  });
});

describe("escalation levels (§7.6.7): > 3 days → 1, > 7 days → 2", () => {
  it("uses the spec's thresholds, strictly greater than", () => {
    expect(ESCALATION_DEFAULTS).toEqual({ level1AfterDays: 3, level2AfterDays: 7 });
    expect(escalationLevelFor(0)).toBe(0);
    expect(escalationLevelFor(3)).toBe(0);
    expect(escalationLevelFor(4)).toBe(1);
    expect(escalationLevelFor(7)).toBe(1);
    expect(escalationLevelFor(8)).toBe(2);
    expect(escalationLevelFor(90)).toBe(2);
  });

  it("follows edited thresholds", () => {
    expect(escalationLevelFor(2, { level1AfterDays: 1, level2AfterDays: 5 })).toBe(1);
    expect(escalationLevelFor(6, { level1AfterDays: 1, level2AfterDays: 5 })).toBe(2);
  });
});

describe("planEscalation: the daily job (§7.6.7, §8, §9)", () => {
  const task = (due: string, currentLevel = 0, status: "in_progress" | "filed_done" = "in_progress") => ({ status, dueDate: due, currentLevel, today: TODAY });

  it("does nothing while a task is at most 3 days overdue", () => {
    expect(planEscalation(task("2026-10-19"))).toEqual({
      level: 0,
      changed: false,
      reached: [],
      notify: { assignee: false, managers: false, partners: false },
      daysOverdue: 3,
    });
  });

  it("level 1 at more than 3 days: the assignee and Managers are told", () => {
    expect(planEscalation(task("2026-10-18"))).toEqual({
      level: 1,
      changed: true,
      reached: [1],
      notify: { assignee: true, managers: true, partners: false },
      daysOverdue: 4,
    });
  });

  it("level 2 at more than 7 days: Partners are told", () => {
    expect(planEscalation(task("2026-10-14", 1))).toEqual({
      level: 2,
      changed: true,
      reached: [2],
      notify: { assignee: true, managers: false, partners: true },
      daysOverdue: 8,
    });
  });

  it("jumping from 0 straight to 2 tells everyone for both levels", () => {
    expect(planEscalation(task("2026-10-01"))).toMatchObject({ level: 2, reached: [1, 2], notify: { assignee: true, managers: true, partners: true } });
  });

  it("is idempotent: a second run the same day changes nothing", () => {
    const first = planEscalation(task("2026-10-18"));
    const second = planEscalation(task("2026-10-18", first.level));
    expect(second.changed).toBe(false);
    expect(second.level).toBe(1);
    expect(second.reached).toEqual([]);
  });

  it("never lowers a level by itself", () => {
    expect(planEscalation(task("2026-10-30", 2))).toMatchObject({ level: 2, changed: false });
  });

  it("never escalates a Filed/Done task", () => {
    expect(planEscalation(task("2026-09-01", 0, "filed_done"))).toMatchObject({ level: 0, changed: false });
  });

  it("re-arms after a reopen or a due-date change, then escalates afresh", () => {
    expect(rearmEscalation()).toEqual({ escalationLevel: 0, escalatedAt: null });
    expect(dueDateChangeRearms("2026-10-01", "2026-10-31")).toBe(true);
    expect(dueDateChangeRearms("2026-10-01", null)).toBe(true);
    expect(dueDateChangeRearms(null, "2026-10-01")).toBe(true);
    expect(dueDateChangeRearms("2026-10-01", "2026-10-01")).toBe(false);
    // Reopened, still 10 days overdue: the next run takes it back up and tells people again.
    const rearmed = rearmEscalation().escalationLevel;
    expect(planEscalation(task("2026-10-12", rearmed))).toMatchObject({ level: 2, changed: true, reached: [1, 2] });
    // Due date moved into the future: nothing until it is overdue again.
    expect(planEscalation(task("2026-11-05", rearmed))).toMatchObject({ level: 0, changed: false });
    expect(planEscalation({ status: "in_progress", dueDate: "2026-11-05", currentLevel: rearmed, today: "2026-11-09" })).toMatchObject({ level: 1, changed: true });
  });
});

describe("quotation follow-ups (§7.5.3): day 3, 7 and 14", () => {
  it("schedules them from the send date", () => {
    expect(FOLLOW_UP_DEFAULTS.quotationFollowUpDays).toEqual([3, 7, 14]);
    expect(quotationFollowUpSchedule("2026-10-01")).toEqual([
      { day: 3, dueOn: "2026-10-04" },
      { day: 7, dueOn: "2026-10-08" },
      { day: 14, dueOn: "2026-10-15" },
    ]);
  });

  it("sends each one once its day has come, while Sent or Viewed and not expired", () => {
    const base = { sentOn: "2026-10-01", status: "sent" as const, validUntil: "2026-10-31", done: [] as number[] };
    expect(quotationFollowUpsDue({ ...base, today: "2026-10-03" })).toEqual([]);
    expect(quotationFollowUpsDue({ ...base, today: "2026-10-04" })).toEqual([3]);
    expect(quotationFollowUpsDue({ ...base, today: "2026-10-08", done: [3] })).toEqual([7]);
    expect(quotationFollowUpsDue({ ...base, today: "2026-10-20", done: [3] })).toEqual([7, 14]);
    expect(quotationFollowUpsDue({ ...base, today: "2026-10-20", status: "viewed", done: [3, 7, 14] })).toEqual([]);
  });

  it("stops for accepted, rejected, expired or superseded quotations, and after valid_until", () => {
    const base = { sentOn: "2026-10-01", validUntil: "2026-10-31", done: [] as number[], today: "2026-10-08" };
    for (const status of ["accepted", "rejected", "expired", "superseded", "draft"] as const) {
      expect(quotationFollowUpsDue({ ...base, status })).toEqual([]);
    }
    expect(quotationFollowUpsDue({ ...base, status: "sent", validUntil: "2026-10-07" })).toEqual([]);
    expect(quotationFollowUpsDue({ ...base, status: "sent", validUntil: "2026-10-08" })).toEqual([3, 7]);
  });
});

describe("appeal limitation dates (§7.8.4) [verify]", () => {
  it("uses 30 days, 60 days, 3 months and 3 months", () => {
    expect(APPEAL_DEFAULTS).toEqual({
      income_tax_first_appeal: { days: 30 },
      income_tax_tribunal: { days: 60 },
      gst_first_appeal: { months: 3 },
      gst_tribunal: { months: 3 },
    });
    expect(appealLimitationDate("income_tax_first_appeal", "2026-10-01")).toBe("2026-10-31");
    expect(appealLimitationDate("income_tax_tribunal", "2026-10-01")).toBe("2026-11-30");
    expect(appealLimitationDate("gst_first_appeal", "2026-10-01")).toBe("2027-01-01");
    expect(appealLimitationDate("gst_tribunal", "2026-11-30")).toBe("2027-02-28");
  });

  it("adds days or calendar months, clamping to the month's end", () => {
    expect(limitationDate("2026-01-31", { months: 1 })).toBe("2026-02-28");
    expect(limitationDate("2028-11-30", { months: 3 })).toBe("2029-02-28");
    expect(limitationDate("2027-11-30", { months: 3 })).toBe("2028-02-29");
    expect(limitationDate("2026-12-15", { days: 30 })).toBe("2027-01-14");
    expect(daysToLimitation("2026-10-31", TODAY)).toBe(9);
    expect(daysToLimitation("2026-10-20", TODAY)).toBe(-2);
  });

  it("reads limitation periods from parameter values", () => {
    expect(readLimitationPeriod({ days: 30 })).toEqual({ days: 30 });
    expect(readLimitationPeriod({ months: 3 })).toEqual({ months: 3 });
    expect(readLimitationPeriod({ days: 0 })).toBeNull();
    expect(readLimitationPeriod({ days: 1.5 })).toBeNull();
    expect(readLimitationPeriod(30)).toBeNull();
  });
});

describe("parameters (§5.12, §16)", () => {
  it("resolves every key from the seed rows, flagging the [verify] appeal periods", () => {
    const r = resolveEscalationParams(ESCALATION_SEED_PARAMETERS, TODAY);
    expect(r.escalation).toEqual(ESCALATION_DEFAULTS);
    expect(r.quotationFollowUpDays).toEqual([3, 7, 14]);
    expect(r.appeals).toEqual(APPEAL_DEFAULTS);
    expect(r.missing).toEqual([]);
    expect(r.unverified.sort()).toEqual(["appeal.gst.first_appeal", "appeal.gst.tribunal", "appeal.income_tax.first_appeal", "appeal.income_tax.tribunal"]);
  });

  it("falls back to the defaults for missing or unusable rows", () => {
    const rows = [
      { key: "escalation.overdue_days", value: { level1: 9, level2: 5 }, effectiveFrom: "2026-04-01" },
      { key: "quotation.follow_up_days", value: [14, 2], effectiveFrom: "2026-04-01" },
    ];
    const r = resolveEscalationParams(rows, TODAY);
    expect(r.escalation).toEqual(ESCALATION_DEFAULTS);
    expect(r.quotationFollowUpDays).toEqual([2, 14]);
    expect(r.missing).toContain("escalation.overdue_days");
    expect(r.missing).toContain("appeal.gst.tribunal");
  });

  it("picks up an edited escalation row from its effective date", () => {
    const rows = [...ESCALATION_SEED_PARAMETERS, { key: "escalation.overdue_days", value: { level1: 2, level2: 5 }, effectiveFrom: addDays(TODAY, 1) }];
    expect(resolveEscalationParams(rows, TODAY).escalation).toEqual(ESCALATION_DEFAULTS);
    expect(resolveEscalationParams(rows, addDays(TODAY, 1)).escalation).toEqual({ level1AfterDays: 2, level2AfterDays: 5 });
  });

  it("seeds the appeal periods unverified and the firm-practice rows verified", () => {
    for (const r of ESCALATION_SEED_PARAMETERS) {
      expect(r.verified).toBe(!r.key.startsWith("appeal."));
      if (r.key.startsWith("appeal.")) expect(r.notes).toContain("[verify]");
    }
  });
});

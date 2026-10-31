import { describe, expect, it } from "vitest";
import {
  AGEING_BUCKETS,
  ageReceivables,
  ageingBucket,
  atRiskClients,
  attendanceSoFar,
  atRiskReasons,
  conversionRate,
  countByPerson,
  countMissing,
  daysSince,
  filingStatusByType,
  fyMonths,
  invoicedVsCollected,
  latestEntryInto,
  latestSendBacks,
  receivableTotals,
  setupChecklist,
  weekHours,
  type SetupFacts,
} from "@/lib/domain/dashboard";
import { toPaise } from "@/lib/domain/money";

const TODAY = "2026-10-23";

describe("receivables ageing", () => {
  it("buckets by days since the invoice date", () => {
    expect(ageingBucket(0)).toBe("d0_30");
    expect(ageingBucket(30)).toBe("d0_30");
    expect(ageingBucket(31)).toBe("d31_60");
    expect(ageingBucket(60)).toBe("d31_60");
    expect(ageingBucket(61)).toBe("d61_90");
    expect(ageingBucket(90)).toBe("d61_90");
    expect(ageingBucket(91)).toBe("d90_plus");
    expect(ageingBucket(-4)).toBe("d0_30");
  });

  it("sums each bucket in paise and keeps empty buckets at zero", () => {
    const rows = ageReceivables(
      [
        { issueDate: "2026-10-01", outstandingPaise: toPaise("1000.10") },
        { issueDate: "2026-09-30", outstandingPaise: toPaise("2000.20") },
        { issueDate: "2026-06-01", outstandingPaise: toPaise("500") },
        { issueDate: "2026-06-02", outstandingPaise: toPaise("0") },
      ],
      TODAY,
    );
    expect(rows.map((r) => r.id)).toEqual(AGEING_BUCKETS.map((b) => b.id));
    expect(rows[0]).toMatchObject({ count: 2, paise: toPaise("3000.30") });
    expect(rows[1]).toMatchObject({ count: 0, paise: 0 });
    expect(rows[3]).toMatchObject({ count: 1, paise: toPaise("500") });
  });
});

describe("invoiced against collected", () => {
  it("lists the twelve months April to March", () => {
    const months = fyMonths("2026-27");
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-04");
    expect(months[11]).toBe("2027-03");
  });

  it("adds invoices by invoice month and receipts by payment month, ignoring other years", () => {
    const m = invoicedVsCollected(
      "2026-27",
      [
        { issueDate: "2026-04-10", totalPaise: toPaise("11800") },
        { issueDate: "2026-04-28", totalPaise: toPaise("5900.50") },
        { issueDate: "2026-03-31", totalPaise: toPaise("99999") },
      ],
      [
        { paymentDate: "2026-05-02", amountPaise: toPaise("11800") },
        { paymentDate: "2027-03-31", amountPaise: toPaise("100") },
      ],
    );
    expect(m[0]).toMatchObject({ month: "2026-04", label: "Apr", invoicedPaise: toPaise("17700.50"), collectedPaise: 0, invoiced: 17700.5 });
    expect(m[1]).toMatchObject({ label: "May", collected: 11800 });
    expect(m[11]).toMatchObject({ label: "Mar", collected: 100, invoiced: 0 });
  });
});

describe("filing status by return type", () => {
  it("counts filed, pending and overdue, drops cancelled and empty types, keeps the order", () => {
    const rows = filingStatusByType(
      [
        { type: "gstr_3b", status: "completed", dueDate: "2026-10-20" },
        { type: "gstr_3b", status: "pending", dueDate: "2026-10-20" },
        { type: "gstr_3b", status: "pending", dueDate: "2026-10-23" },
        { type: "gstr_3b", status: "cancelled", dueDate: "2026-10-20" },
        { type: "tds", status: "pending", dueDate: "2026-10-31" },
      ],
      TODAY,
      ["gstr_1", "gstr_3b", "tds"],
    );
    expect(rows).toEqual([
      { type: "gstr_3b", filed: 1, pending: 1, overdue: 1, total: 3 },
      { type: "tds", filed: 0, pending: 1, overdue: 0, total: 1 },
    ]);
  });
});

describe("at-risk clients", () => {
  it("flags three or more overdue tasks, or any receivable over 90 days", () => {
    expect(atRiskReasons({ overdueTasks: 2, receivablesOver90Paise: 0 })).toEqual([]);
    expect(atRiskReasons({ overdueTasks: 3, receivablesOver90Paise: 0 })).toEqual(["overdue_tasks"]);
    expect(atRiskReasons({ overdueTasks: 0, receivablesOver90Paise: 1 })).toEqual(["old_receivables"]);
    expect(atRiskReasons({ overdueTasks: 5, receivablesOver90Paise: 100 })).toEqual(["overdue_tasks", "old_receivables"]);
  });
});

describe("sent back to me", () => {
  it("keeps tasks whose latest change is a send-back, with its reason", () => {
    const m = latestSendBacks([
      { taskId: "a", from: "in_progress", to: "under_review", reason: null, at: "2026-10-20T05:00:00Z", by: "e1" },
      { taskId: "a", from: "under_review", to: "in_progress", reason: "Reconcile the ITC first", at: "2026-10-21T05:00:00Z", by: "m1" },
      { taskId: "b", from: "under_review", to: "in_progress", reason: "Wrong period", at: "2026-10-19T05:00:00Z", by: "m1" },
      { taskId: "b", from: "in_progress", to: "under_review", reason: null, at: "2026-10-22T05:00:00Z", by: "e1" },
    ]);
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")?.reason).toBe("Reconcile the ITC first");
  });
});

describe("overdue tasks by person", () => {
  it("groups by assignee, most first, unassigned last", () => {
    expect(
      countByPerson([
        { assigneeId: "e2", assigneeName: "Ravi" },
        { assigneeId: null, assigneeName: null },
        { assigneeId: "e1", assigneeName: "Anita" },
        { assigneeId: "e2", assigneeName: "Ravi" },
        { assigneeId: "e3", assigneeName: "Bhavna" },
      ]),
    ).toEqual([
      { employeeId: "e2", name: "Ravi", count: 2 },
      { employeeId: "e1", name: "Anita", count: 1 },
      { employeeId: "e3", name: "Bhavna", count: 1 },
      { employeeId: null, name: "Unassigned", count: 1 },
    ]);
  });
});

describe("setup checklist", () => {
  const none: SetupFacts = {
    hasLogo: false,
    hasBankAndUpi: false,
    hasFrnAndMembership: false,
    hasWhatsAppNumbers: false,
    teamAdded: false,
    firstClientOnboarded: false,
    firstInvoiceIssued: false,
    lawReviewed: false,
  };

  it("lists the eight items in order with where to do each (§7.2, less the email domain)", () => {
    const c = setupChecklist(none);
    expect(c.items).toHaveLength(8);
    expect(c.items[0]).toMatchObject({ id: "hasLogo", href: "/settings/firm", done: false });
    expect(c.items[7]).toMatchObject({ id: "lawReviewed", href: "/settings/law" });
    expect(c.items.map((i) => i.href)).not.toContain("/settings/email");
    expect(c).toMatchObject({ done: 0, complete: false });
  });

  it("is complete once every item is done", () => {
    const all = Object.fromEntries(Object.keys(none).map((k) => [k, true])) as SetupFacts;
    expect(setupChecklist(all)).toMatchObject({ done: 8, complete: true });
    expect(setupChecklist({ ...all, lawReviewed: false })).toMatchObject({ done: 7, complete: false });
  });
});

describe("pipeline and waiting", () => {
  it("converts decided quotations to a whole percentage", () => {
    expect(conversionRate({ accepted: 0, rejected: 0, expired: 0 })).toBeNull();
    expect(conversionRate({ accepted: 2, rejected: 1, expired: 0 })).toBe(67);
    expect(conversionRate({ accepted: 1, rejected: 0, expired: 3 })).toBe(25);
  });

  it("counts days waiting, never negative", () => {
    expect(daysSince("2026-10-20", TODAY)).toBe(3);
    expect(daysSince("2026-10-25", TODAY)).toBe(0);
  });
});

describe("receivable totals", () => {
  it("sums outstanding and overdue in paise and counts each", () => {
    const t = receivableTotals([
      { outstandingPaise: toPaise("21.68"), isOverdue: true },
      { outstandingPaise: toPaise("8.34"), isOverdue: false },
      { outstandingPaise: toPaise("0"), isOverdue: true },
      { outstandingPaise: toPaise("0.01"), isOverdue: true },
    ]);
    expect(t).toEqual({ count: 3, outstandingPaise: toPaise("30.03"), overdueCount: 2, overduePaise: toPaise("21.69") });
  });

  it("is all zeros with nothing open", () => {
    expect(receivableTotals([])).toEqual({ count: 0, outstandingPaise: 0, overdueCount: 0, overduePaise: 0 });
  });
});

describe("at-risk clients from rows", () => {
  const overdue = (clientId: string, n: number) => Array.from({ length: n }, () => ({ clientId, clientName: `Client ${clientId}` }));

  it("lists 3+ overdue tasks or a balance over 90 days, worst first", () => {
    const rows = atRiskClients(
      [...overdue("a", 3), ...overdue("b", 5), ...overdue("c", 2), ...overdue("d", 4)],
      [
        { clientId: "c", clientName: "Client c", issueDate: "2026-07-01", outstandingPaise: toPaise("1000") }, // 114 days
        { clientId: "d", clientName: "Client d", issueDate: "2026-07-24", outstandingPaise: toPaise("500") }, // 91 days
        { clientId: "e", clientName: "Client e", issueDate: "2026-07-25", outstandingPaise: toPaise("9000") }, // 90 days: not over 90
        { clientId: "f", clientName: "Client f", issueDate: "2026-01-01", outstandingPaise: 0 },
      ],
      TODAY,
    );
    expect(rows.map((r) => r.clientId)).toEqual(["d", "b", "a", "c"]);
    expect(rows[0]).toEqual({ clientId: "d", clientName: "Client d", overdueTasks: 4, receivablesOver90Paise: toPaise("500"), reasons: ["overdue_tasks", "old_receivables"] });
    expect(rows.find((r) => r.clientId === "c")?.reasons).toEqual(["old_receivables"]);
  });

  it("is empty when nothing qualifies", () => {
    expect(atRiskClients(overdue("a", 2), [], TODAY)).toEqual([]);
  });
});

describe("days waiting in a status", () => {
  it("keeps each task's latest move into the status", () => {
    const m = latestEntryInto(
      [
        { taskId: "t1", from: "in_progress", to: "data_awaited", reason: null, at: "2026-10-01T05:00:00Z", by: null },
        { taskId: "t1", from: "data_awaited", to: "in_progress", reason: null, at: "2026-10-05T05:00:00Z", by: null },
        { taskId: "t1", from: "in_progress", to: "data_awaited", reason: null, at: "2026-10-20T05:00:00Z", by: null },
        { taskId: "t2", from: "not_started", to: "in_progress", reason: null, at: "2026-10-21T05:00:00Z", by: null },
      ],
      "data_awaited",
    );
    expect([...m.keys()]).toEqual(["t1"]);
    expect(m.get("t1")?.at).toBe("2026-10-20T05:00:00Z");
  });
});

describe("this week's hours against the target", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const targets = [480, 480, 480, 480, 480, 480, 0];

  it("compares with the days so far and the whole week", () => {
    const w = weekHours(dates, targets, [480, 420, 300, 0, 60, 0, 0], TODAY);
    expect(w).toEqual({ loggedMinutes: 1260, targetMinutes: 2880, expectedMinutes: 2400, behindMinutes: 1140, percent: 44 });
  });

  it("is never behind when ahead, caps at 100% and has no percent without a target", () => {
    expect(weekHours(dates, targets, [600, 600, 600, 600, 600, 600, 0], TODAY)).toMatchObject({ behindMinutes: 0, percent: 100 });
    expect(weekHours(dates, [0, 0, 0, 0, 0, 0, 0], [60, 0, 0, 0, 0, 0, 0], TODAY)).toMatchObject({ targetMinutes: 0, percent: null, behindMinutes: 0 });
  });
});

describe("practice health", () => {
  it("counts what is missing, once each", () => {
    expect(countMissing(["a", "b", "c", "c"], ["b", "x"])).toBe(2);
    expect(countMissing([], ["a"])).toBe(0);
  });
});

describe("attendance so far today", () => {
  const params = { workDayStart: "09:30", lateGraceMinutes: 15, halfDayMinutes: 240 };
  const people = [{ id: "on-time" }, { id: "late" }, { id: "leave" }, { id: "missing" }];
  const sessions = [
    { employeeId: "on-time", loginAt: "2026-10-23T04:10:00Z", lastActiveAt: "2026-10-23T05:00:00Z", activeMinutes: 50 }, // 09:40 IST
    { employeeId: "late", loginAt: "2026-10-23T04:20:00Z", lastActiveAt: "2026-10-23T05:00:00Z", activeMinutes: 40 }, // 09:50 IST
    { employeeId: "late", loginAt: "2026-10-22T04:00:00Z", lastActiveAt: "2026-10-22T12:00:00Z", activeMinutes: 480 }, // yesterday: ignored
  ];
  const base = { people, sessions, onLeave: new Set(["leave"]), params, isWorkingDay: true, noShowAfterMinutes: 30, today: TODAY };

  it("reads present, late and on leave from today's sessions; no-shows are absent after the cutoff", () => {
    expect(attendanceSoFar({ ...base, now: new Date("2026-10-23T05:00:00Z") })).toEqual({
      workingDay: true,
      cutoff: "10:15",
      present: 1,
      late: 1,
      onLeave: 1,
      absent: 1,
      notInYet: 0,
      total: 4,
    });
  });

  it("counts no-shows as not in yet before the cutoff", () => {
    expect(attendanceSoFar({ ...base, now: new Date("2026-10-23T04:30:00Z") })).toMatchObject({ absent: 0, notInYet: 1 }); // 10:00 IST
  });

  it("counts nobody on a day off", () => {
    expect(attendanceSoFar({ ...base, isWorkingDay: false, now: new Date("2026-10-23T05:00:00Z") })).toMatchObject({ workingDay: false, total: 0, absent: 0 });
  });
});

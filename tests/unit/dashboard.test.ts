import { describe, expect, it } from "vitest";
import {
  AGEING_BUCKETS,
  ageReceivables,
  ageingBucket,
  atRiskReasons,
  conversionRate,
  countByPerson,
  daysSince,
  filingStatusByType,
  fyMonths,
  invoicedVsCollected,
  latestSendBacks,
  setupChecklist,
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
    emailDomainVerified: false,
    hasWhatsAppNumbers: false,
    teamAdded: false,
    firstClientOnboarded: false,
    firstInvoiceIssued: false,
    lawReviewed: false,
  };

  it("lists the nine §7.2 items in order with where to do each", () => {
    const c = setupChecklist(none);
    expect(c.items).toHaveLength(9);
    expect(c.items[0]).toMatchObject({ id: "hasLogo", href: "/settings/firm", done: false });
    expect(c.items[8]).toMatchObject({ id: "lawReviewed", href: "/settings/law" });
    expect(c).toMatchObject({ done: 0, complete: false });
  });

  it("is complete once every item is done", () => {
    const all = Object.fromEntries(Object.keys(none).map((k) => [k, true])) as SetupFacts;
    expect(setupChecklist(all)).toMatchObject({ done: 9, complete: true });
    expect(setupChecklist({ ...all, lawReviewed: false })).toMatchObject({ done: 8, complete: false });
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

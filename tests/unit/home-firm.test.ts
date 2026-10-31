import { describe, expect, it } from "vitest";
import {
  ageingFromBuckets,
  atRiskFromCounts,
  ceilingLevel,
  countLevel,
  fyMonthRows,
  fyToDate,
  healthTally,
  peerReviewLevel,
  setupFactsOf,
  setupSteps,
  udinLevel,
  type SetupDetail,
} from "@/lib/domain/dashboard";
import { toPaise } from "@/lib/domain/money";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const fresh: SetupDetail = {
  hasLogo: false,
  hasBank: false,
  hasUpi: false,
  hasFrn: false,
  lawReviewedAt: null,
  partners: 1,
  partnersMissingMembership: [{ profileId: ME, employeeId: "e-me", name: "CA Vinay" }],
  whatsappNumbers: 0,
  whatsappSlots: 5,
  teamMembers: 1,
  clientsOnboarded: 0,
  invoicesIssued: 0,
};

const done: SetupDetail = {
  ...fresh,
  hasLogo: true,
  hasBank: true,
  hasUpi: true,
  hasFrn: true,
  lawReviewedAt: "2026-10-01T10:00:00+05:30",
  partnersMissingMembership: [],
  whatsappNumbers: 2,
  teamMembers: 6,
  clientsOnboarded: 1,
  invoicesIssued: 1,
};

describe("the setup checklist with what is missing (§7.2, §4.3)", () => {
  it("starts with nothing done on a fresh firm (the setup Partner alone is not a team)", () => {
    const s = setupSteps(fresh, { profileId: ME });
    expect(s).toMatchObject({ done: 0, complete: false, percent: 0 });
    expect(s.items.map((i) => i.id)).toEqual([
      "hasLogo",
      "hasBankAndUpi",
      "hasFrnAndMembership",
      "hasWhatsAppNumbers",
      "teamAdded",
      "firstClientOnboarded",
      "firstInvoiceIssued",
      "lawReviewed",
    ]);
    const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
    expect(by.hasWhatsAppNumbers.detail).toBe("0 of 5 numbers entered");
    expect(by.teamAdded.detail).toBe("Only you so far");
    expect(by.hasFrnAndMembership).toMatchObject({ href: "/settings/firm", detail: "FRN still to add · No membership number for CA Vinay" });
  });

  it("is complete, and leaves the page, once all eight are done", () => {
    const s = setupSteps(done, { profileId: ME });
    expect(s).toMatchObject({ done: 8, complete: true, percent: 100 });
    expect(s.items.every((i) => i.detail === null)).toBe(true);
    expect(Object.values(setupFactsOf(done)).every(Boolean)).toBe(true);
  });

  it("needs both the bank account and the UPI ID, and says which is missing", () => {
    const bankOnly = setupSteps({ ...done, hasUpi: false }, { profileId: ME });
    expect(bankOnly.items.find((i) => i.id === "hasBankAndUpi")).toMatchObject({ done: false, detail: "UPI ID still to add" });
    const upiOnly = setupSteps({ ...done, hasBank: false }, { profileId: ME });
    expect(upiOnly.items.find((i) => i.id === "hasBankAndUpi")).toMatchObject({ done: false, detail: "Bank account still to add" });
    expect(bankOnly.percent).toBe(88); // 7 of 8
  });

  it("sends a missing membership number to the Partner's own Profile, or to the other Partner in People", () => {
    const mine = setupSteps({ ...done, partnersMissingMembership: [{ profileId: ME, employeeId: "e-me", name: "CA Vinay" }] }, { profileId: ME });
    expect(mine.items.find((i) => i.id === "hasFrnAndMembership")).toMatchObject({ href: "/profile", detail: "No membership number for CA Vinay" });
    const theirs = setupSteps({ ...done, partnersMissingMembership: [{ profileId: OTHER, employeeId: "e-2", name: "CA Anita" }] }, { profileId: ME });
    expect(theirs.items.find((i) => i.id === "hasFrnAndMembership")?.href).toBe("/people/e-2");
    const many = setupSteps(
      {
        ...done,
        partners: 3,
        partnersMissingMembership: [
          { profileId: OTHER, employeeId: "e-2", name: "Anita" },
          { profileId: "p3", employeeId: "e-3", name: "Ravi" },
          { profileId: "p4", employeeId: null, name: "Suma" },
        ],
      },
      { profileId: ME },
    );
    expect(many.items.find((i) => i.id === "hasFrnAndMembership")?.detail).toBe("No membership number for Anita, Ravi and 1 more");
  });

  it("does not count the FRN as done with no active Partner", () => {
    expect(setupFactsOf({ ...done, partners: 0 }).hasFrnAndMembership).toBe(false);
  });
});

describe("invoiced and collected by month", () => {
  it("labels the FY's months and keeps months not yet begun empty", () => {
    const rows = fyMonthRows([
      { month: "2026-04", invoicedPaise: toPaise("21.68"), collectedPaise: toPaise("8.34") },
      { month: "2026-05", invoicedPaise: toPaise("0"), collectedPaise: toPaise("3.81") },
      { month: "2026-06", invoicedPaise: null, collectedPaise: null },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Apr", "May", "Jun"]);
    expect(rows[2]).toMatchObject({ invoicedPaise: null, collectedPaise: null });
    expect(fyToDate(rows)).toEqual({ invoicedPaise: toPaise("21.68"), collectedPaise: toPaise("12.15"), months: 2 });
  });

  it("labels January to March of the following calendar year", () => {
    expect(fyMonthRows([{ month: "2027-01", invoicedPaise: 0, collectedPaise: 0 }])[0].label).toBe("Jan");
  });
});

describe("receivables ageing from the database's buckets", () => {
  it("keeps every bucket in order, with zeros where the database has none", () => {
    const a = ageingFromBuckets([
      { bucket: "90_plus", count: 1, paise: toPaise("11800") },
      { bucket: "0_30", count: 2, paise: toPaise("5900.50") },
      { bucket: "unknown", count: 9, paise: 1 },
    ]);
    expect(a.map((r) => r.label)).toEqual(["0–30 days", "31–60 days", "61–90 days", "90+ days"]);
    expect(a.map((r) => r.count)).toEqual([2, 0, 0, 1]);
    expect(a[0].paise).toBe(toPaise("5900.50"));
  });
});

describe("at-risk clients from per-client counts", () => {
  it("gives each its reasons and drops a row that isn't at risk", () => {
    const rows = atRiskFromCounts([
      { clientId: "a", clientName: "Sharma Traders", overdueTasks: 4, receivablesOldPaise: toPaise("12000") },
      { clientId: "b", clientName: "Beta Industries", overdueTasks: 3, receivablesOldPaise: 0 },
      { clientId: "c", clientName: "Gamma LLP", overdueTasks: 1, receivablesOldPaise: toPaise("0.01") },
      { clientId: "d", clientName: "Not at risk", overdueTasks: 2, receivablesOldPaise: 0 },
    ]);
    expect(rows.map((r) => [r.clientId, r.reasons])).toEqual([
      ["a", ["overdue_tasks", "old_receivables"]],
      ["b", ["overdue_tasks"]],
      ["c", ["old_receivables"]],
    ]);
  });
});

describe("practice health levels", () => {
  it("marks the tax-audit ceiling", () => {
    expect(ceilingLevel([null, "near"])).toBe("watch");
    expect(ceilingLevel(["near", "at_ceiling"])).toBe("act");
    expect(ceilingLevel(["over"])).toBe("act");
    expect(ceilingLevel([null])).toBe("fine");
    expect(ceilingLevel([])).toBe("fine");
  });

  it("marks UDINs past the 60 days as act, any still to generate as watch", () => {
    expect(udinLevel([{ daysLate: 3 }], 1)).toBe("act");
    expect(udinLevel([{ daysLate: null }], 1)).toBe("watch");
    expect(udinLevel([], 0)).toBe("fine");
    expect(udinLevel([{ daysLate: 0 }], 1)).toBe("watch");
  });

  it("marks peer review and counts", () => {
    expect(peerReviewLevel("missing")).toBe("act");
    expect(peerReviewLevel("expired")).toBe("act");
    expect(peerReviewLevel("expiring")).toBe("watch");
    expect(peerReviewLevel("valid")).toBe("fine");
    expect(countLevel(1, 0)).toBe("act");
    expect(countLevel(0, 2)).toBe("watch");
    expect(countLevel(0, 0)).toBe("fine");
  });

  it("tallies what needs action and what is coming up, ignoring items that failed to load", () => {
    expect(healthTally(["act", "watch", "fine", null, "watch"])).toEqual({ act: 1, watch: 2 });
  });
});

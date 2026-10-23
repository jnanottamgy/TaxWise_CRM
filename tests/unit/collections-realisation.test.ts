import { describe, expect, it } from "vitest";
import {
  allocateByWeights,
  billingPeriodsOf,
  buildRealisation,
  feeInForce,
  periodKey,
  sortRealisationRows,
  type RealisationEngagement,
  type RealisationInvoice,
} from "@/lib/domain/realisation";

describe("allocateByWeights", () => {
  it("splits exactly, largest remainder first", () => {
    expect(allocateByWeights(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocateByWeights(100, [3, 1])).toEqual([75, 25]);
    expect(allocateByWeights(101, [1, 1])).toEqual([51, 50]);
    expect(allocateByWeights(-101, [1, 1])).toEqual([-51, -50]);
    expect(allocateByWeights(10, [0, 0])).toEqual([5, 5]);
    expect(allocateByWeights(10, [-5, 5])).toEqual([0, 10]);
    expect(allocateByWeights(0, [1, 2])).toEqual([0, 0]);
    expect(allocateByWeights(7, [])).toEqual([]);
    const shares = allocateByWeights(123457, [333, 667, 1001, 9]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(123457);
  });
});

describe("billing periods and fees", () => {
  it("lists an FY's months, quarters or the year", () => {
    const months = billingPeriodsOf("2026-27", "monthly");
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ label: "Apr 2026", start: "2026-04-01", end: "2026-04-30" });
    expect(months[11]).toEqual({ label: "Mar 2027", start: "2027-03-01", end: "2027-03-31" });
    expect(billingPeriodsOf("2026-27", "quarterly").map((p) => [p.label, p.end])).toEqual([
      ["Q1 2026-27", "2026-06-30"],
      ["Q2 2026-27", "2026-09-30"],
      ["Q3 2026-27", "2026-12-31"],
      ["Q4 2026-27", "2027-03-31"],
    ]);
    expect(billingPeriodsOf("2026-27", "annual")).toEqual([{ label: "FY 2026-27", start: "2026-04-01", end: "2027-03-31" }]);
  });

  it("takes the fee in force on a day from the history", () => {
    const h = [
      { changedOn: "2026-04-01", agreedFeePaise: 5000_00 },
      { changedOn: "2026-08-15", agreedFeePaise: 6000_00 },
    ];
    expect(feeInForce(h, "2026-08-01", 7000_00)).toBe(5000_00);
    expect(feeInForce(h, "2026-09-01", 7000_00)).toBe(6000_00);
    expect(feeInForce(h, "2026-01-01", 7000_00)).toBe(5000_00);
    expect(feeInForce([], "2026-09-01", 7000_00)).toBe(7000_00);
  });
});

describe("buildRealisation (§7.9.10)", () => {
  const gst: RealisationEngagement = {
    id: "eng-gst",
    clientId: "c1",
    clientName: "Alpha Traders",
    clientCode: "TW-C-0001",
    clientStatus: "active",
    serviceType: "gst",
    customName: null,
    frequency: "monthly",
    billingFrequency: null,
    isActive: true,
    agreedFeePaise: 5000_00,
    startedOn: "2026-06-10",
    endedOn: null,
    feeHistory: [{ changedOn: "2026-06-10", agreedFeePaise: 5000_00 }],
  };
  const audit: RealisationEngagement = {
    ...gst,
    id: "eng-audit",
    serviceType: "audit",
    frequency: "annual",
    agreedFeePaise: 60000_00,
    startedOn: "2025-04-01",
    feeHistory: [],
  };
  const onHold: RealisationEngagement = { ...gst, id: "eng-hold", clientId: "c2", clientName: "Beta", clientCode: "TW-C-0002", clientStatus: "on_hold" };

  const invoice = (over: Partial<RealisationInvoice>): RealisationInvoice => ({
    id: "i",
    clientId: "c1",
    clientName: "Alpha Traders",
    clientCode: "TW-C-0001",
    issueDate: "2026-07-01",
    clientServiceId: null,
    serviceType: "gst",
    totalPaise: 5900_00,
    creditNotedPaise: 0,
    creditTaxablePaise: 0,
    collectedPaise: 0,
    lines: [{ amountPaise: 5000_00, isReimbursement: false, serviceType: "gst", clientServiceId: "eng-gst" }],
    ...over,
  });

  it("compares agreed, invoiced and collected per engagement, and lists the leakage", () => {
    const report = buildRealisation({
      fy: "2026-27",
      asOf: "2026-10-23",
      engagements: [gst, audit, onHold],
      invoices: [
        invoice({ id: "jun", collectedPaise: 5900_00 }),
        invoice({ id: "jul", collectedPaise: 2950_00 }),
        // A credit note of ₹1,000 + GST: invoiced 4,000; half the net total collected.
        invoice({ id: "aug", creditNotedPaise: 1180_00, creditTaxablePaise: 1000_00, collectedPaise: 2360_00 }),
        // A reimbursement isn't a fee; an ad hoc line goes to "not tied to an engagement".
        invoice({
          id: "adhoc",
          totalPaise: 2360_00 + 500_00,
          collectedPaise: 0,
          lines: [
            { amountPaise: 2000_00, isReimbursement: false, serviceType: "income_tax", clientServiceId: null },
            { amountPaise: 500_00, isReimbursement: true, serviceType: null, clientServiceId: null },
          ],
          serviceType: "income_tax",
        }),
      ],
      billedPeriodKeys: new Set([periodKey("eng-gst", "Jun 2026"), periodKey("eng-gst", "Jul 2026"), periodKey("eng-gst", "aug 2026")]),
    });

    const row = report.rows.find((r) => r.engagementId === "eng-gst")!;
    // Jun–Oct 2026 have started (the engagement began 10 Jun): 5 × 5,000.
    expect(row.agreedPaise).toBe(25000_00);
    expect(row.invoicedPaise).toBe(14000_00);
    // Jun all (5,000), Jul half (2,500), Aug: 2,360 of the net 4,720 → half of the 4,000 fee (2,000).
    expect(row.collectedPaise).toBe(9500_00);
    expect(row.billingPercent).toBe(56);
    expect(row.realisationPercent).toBe(67.9);
    // Sep has ended with no invoice; Oct hasn't ended.
    expect(row.leakagePeriods).toBe(1);
    expect(report.leakage.map((l) => [l.clientName, l.periodLabel])).toEqual([["Alpha Traders", "Sep 2026"]]);

    const auditRow = report.rows.find((r) => r.engagementId === "eng-audit")!;
    expect(auditRow).toMatchObject({ agreedPaise: 60000_00, invoicedPaise: 0, billingPercent: 0, realisationPercent: null, leakagePeriods: 0 });

    // On hold: agreed still counts, but its periods aren't leakage while billing is paused.
    expect(report.rows.find((r) => r.engagementId === "eng-hold")?.leakagePeriods).toBe(0);

    const adhoc = report.rows.find((r) => r.key === "adhoc:c1:income_tax")!;
    expect(adhoc).toMatchObject({ engagementId: null, agreedPaise: 0, invoicedPaise: 2000_00, collectedPaise: 0, billingPercent: null, realisationPercent: 0 });

    expect(report.totals.invoicedPaise).toBe(report.rows.reduce((s, r) => s + r.invoicedPaise, 0));
  });

  it("counts a one-time engagement once in the FY it began, and an ended one only until it ended", () => {
    const once: RealisationEngagement = { ...gst, id: "eng-once", serviceType: "incorporation", frequency: "one_time", agreedFeePaise: 15000_00, startedOn: "2026-05-01", feeHistory: [] };
    const ended: RealisationEngagement = { ...gst, id: "eng-ended", isActive: false, startedOn: "2026-04-01", endedOn: "2026-05-20", feeHistory: [] };
    const r = buildRealisation({ fy: "2026-27", asOf: "2026-10-23", engagements: [once, ended], invoices: [], billedPeriodKeys: new Set() });
    expect(r.rows.find((x) => x.engagementId === "eng-once")?.agreedPaise).toBe(15000_00);
    expect(r.rows.find((x) => x.engagementId === "eng-ended")).toMatchObject({ agreedPaise: 10000_00, leakagePeriods: 0 });
  });

  it("sorts with empty ratios last", () => {
    const report = buildRealisation({ fy: "2026-27", asOf: "2026-10-23", engagements: [gst, audit], invoices: [invoice({ collectedPaise: 5900_00 })], billedPeriodKeys: new Set() });
    expect(sortRealisationRows(report.rows, "realisation", "desc").map((r) => r.engagementId)).toEqual(["eng-gst", "eng-audit"]);
    expect(sortRealisationRows(report.rows, "agreed", "desc")[0].engagementId).toBe("eng-audit");
  });
});

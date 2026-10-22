import { describe, expect, it } from "vitest";
import { INVOICE_STATUSES, type InvoiceStatus } from "@/lib/domain/enums";
import {
  AGEING_BUCKET_LABELS,
  ageingBucket,
  agreedFeeNote,
  daysOverdue,
  deriveInvoiceStatus,
  duplicatePeriodMessage,
  findDuplicatePeriodInvoice,
  invoiceAgeDays,
  isInvoiceOverdue,
  isReceivable,
  normalisePeriodLabel,
  planRetainerBilling,
  reminderEligibility,
  reminderSchedule,
  reminderToSend,
  RETAINER_SKIP_REASON_LABELS,
  RETAINER_SKIP_REASONS,
  retainerPeriodLabel,
  statusAfterReceipts,
  type PeriodInvoice,
  type RetainerEngagement,
} from "@/lib/domain/invoice";
import { settlementFrom } from "@/lib/domain/tds";

const TODAY = "2026-10-22";

// -------------------------------------------------------------------------------------------------
// Derived overdue (§5.7, §7.9.3, §14)
// -------------------------------------------------------------------------------------------------

describe("a draft invoice is never overdue (§5.7, §14)", () => {
  it("stays Draft however late and however much is outstanding", () => {
    expect(isInvoiceOverdue("draft", 1_18_000_00, "2025-01-01", TODAY)).toBe(false);
    expect(deriveInvoiceStatus("draft", 1_18_000_00, "2025-01-01", TODAY)).toBe("draft");
    expect(daysOverdue("draft", 1_18_000_00, "2025-01-01", TODAY)).toBe(0);
  });

  it("only Sent and Partially paid can be overdue", () => {
    const overdue = INVOICE_STATUSES.filter((s) => isInvoiceOverdue(s, 100, "2026-10-01", TODAY));
    expect(overdue).toEqual(["sent", "partially_paid"]);
    for (const s of ["awaiting_approval", "paid", "disputed", "waived"] as InvoiceStatus[]) {
      expect(deriveInvoiceStatus(s, 100, "2026-10-01", TODAY)).toBe(s);
    }
  });
});

describe("deriveInvoiceStatus and daysOverdue (§5.7, §7.9.3)", () => {
  it("is overdue the day after the due date, with a balance", () => {
    expect(deriveInvoiceStatus("sent", 100, "2026-10-22", TODAY)).toBe("sent"); // due today
    expect(deriveInvoiceStatus("sent", 100, "2026-10-21", TODAY)).toBe("overdue");
    expect(daysOverdue("sent", 100, "2026-10-21", TODAY)).toBe(1);
    expect(deriveInvoiceStatus("partially_paid", 1, "2026-09-22", TODAY)).toBe("overdue");
    expect(daysOverdue("partially_paid", 1, "2026-09-22", TODAY)).toBe(30);
  });

  it("is not overdue with nothing outstanding (or an overpayment)", () => {
    expect(deriveInvoiceStatus("sent", 0, "2026-01-01", TODAY)).toBe("sent");
    expect(isInvoiceOverdue("partially_paid", -100, "2026-01-01", TODAY)).toBe(false);
    expect(daysOverdue("sent", 0, "2026-01-01", TODAY)).toBe(0);
  });

  it("shows a cancelled invoice as cancelled, never overdue", () => {
    expect(deriveInvoiceStatus("sent", 100, "2026-01-01", TODAY, { cancelled: true })).toBe("cancelled");
    expect(isInvoiceOverdue("sent", 100, "2026-01-01", TODAY, { cancelled: true })).toBe(false);
    expect(daysOverdue("sent", 100, "2026-01-01", TODAY, { cancelled: true })).toBe(0);
  });

  it("crosses FYs and month ends correctly", () => {
    expect(daysOverdue("sent", 100, "2026-03-31", "2026-04-01")).toBe(1);
    expect(daysOverdue("sent", 100, "2024-02-28", "2024-03-01")).toBe(2); // leap year
  });
});

describe("statusAfterReceipts (§7.9.3: Paid / Partially paid come only from receipts)", () => {
  const total = 1_18_000_00;

  it("moves Sent → Partially paid → Paid as receipts arrive", () => {
    const part = settlementFrom(total, [{ amountReceivedPaise: 50_000_00, tdsPaise: 0 }]);
    expect(statusAfterReceipts("sent", part)).toBe("partially_paid");
    const full = settlementFrom(total, [
      { amountReceivedPaise: 50_000_00, tdsPaise: 0 },
      { amountReceivedPaise: 58_000_00, tdsPaise: 10_000_00 },
    ]);
    expect(full.outstandingPaise).toBe(0);
    expect(statusAfterReceipts("partially_paid", full)).toBe("paid");
  });

  it("counts TDS and credit notes as settlement", () => {
    expect(statusAfterReceipts("sent", settlementFrom(total, [{ amountReceivedPaise: 0, tdsPaise: 10_000_00 }]))).toBe("partially_paid");
    expect(statusAfterReceipts("sent", settlementFrom(total, [], [{ totalPaise: total }]))).toBe("paid");
    expect(statusAfterReceipts("sent", settlementFrom(total, [{ amountReceivedPaise: total + 100, tdsPaise: 0 }]))).toBe("paid"); // ₹1 over
  });

  it("goes back when a receipt is reversed", () => {
    expect(statusAfterReceipts("paid", settlementFrom(total, [{ amountReceivedPaise: total, tdsPaise: 0, reversed: true }]))).toBe("sent");
    expect(
      statusAfterReceipts(
        "paid",
        settlementFrom(total, [
          { amountReceivedPaise: 18_000_00, tdsPaise: 0 },
          { amountReceivedPaise: 1_00_000_00, tdsPaise: 0, reversed: true },
        ]),
      ),
    ).toBe("partially_paid");
  });

  it("leaves Draft, Awaiting approval, Disputed and Waived alone", () => {
    const full = settlementFrom(total, [{ amountReceivedPaise: total, tdsPaise: 0 }]);
    for (const s of ["draft", "awaiting_approval", "disputed", "waived"] as InvoiceStatus[]) expect(statusAfterReceipts(s, full)).toBe(s);
  });
});

// -------------------------------------------------------------------------------------------------
// Ageing (§7.2, §7.9.5)
// -------------------------------------------------------------------------------------------------

describe("ageingBucket (§7.2: 0–30 / 31–60 / 61–90 / 90+)", () => {
  it("puts each boundary in the right bucket", () => {
    expect([-5, 0, 1, 30].map(ageingBucket)).toEqual(["0_30", "0_30", "0_30", "0_30"]);
    expect([31, 60].map(ageingBucket)).toEqual(["31_60", "31_60"]);
    expect([61, 90].map(ageingBucket)).toEqual(["61_90", "61_90"]);
    expect([91, 400].map(ageingBucket)).toEqual(["90_plus", "90_plus"]);
    expect(AGEING_BUCKET_LABELS).toEqual({ "0_30": "0–30 days", "31_60": "31–60 days", "61_90": "61–90 days", "90_plus": "90+ days" });
  });

  it("ages from the issue date by default, or from the due date", () => {
    const inv = { issueDate: "2026-08-01", dueDate: "2026-08-16" };
    expect(invoiceAgeDays(inv, TODAY)).toBe(82);
    expect(ageingBucket(invoiceAgeDays(inv, TODAY))).toBe("61_90");
    expect(invoiceAgeDays(inv, TODAY, "due_date")).toBe(67);
    expect(invoiceAgeDays({ issueDate: TODAY, dueDate: "2026-11-06" }, TODAY, "due_date")).toBe(-15);
  });

  it("counts only money still to collect as receivable", () => {
    expect(isReceivable("sent", 100)).toBe(true);
    expect(isReceivable("partially_paid", 100)).toBe(true);
    expect(isReceivable("disputed", 100)).toBe(true);
    expect(isReceivable("draft", 100)).toBe(false);
    expect(isReceivable("awaiting_approval", 100)).toBe(false);
    expect(isReceivable("paid", 0)).toBe(false);
    expect(isReceivable("waived", 100)).toBe(false);
    expect(isReceivable("sent", 0)).toBe(false);
    expect(isReceivable("sent", 100, { cancelled: true })).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// Reminders (§7.9.5)
// -------------------------------------------------------------------------------------------------

describe("reminderSchedule (§7.9.5: 3 days before, then 1, 7 and 15 after)", () => {
  it("builds the default schedule", () => {
    expect(reminderSchedule("2026-10-20")).toEqual([
      { kind: "before_due", offsetDays: -3, date: "2026-10-17", tone: "gentle", key: "before_due:3" },
      { kind: "after_due", offsetDays: 1, date: "2026-10-21", tone: "firm", key: "after_due:1" },
      { kind: "after_due", offsetDays: 7, date: "2026-10-27", tone: "firm", key: "after_due:7" },
      { kind: "after_due", offsetDays: 15, date: "2026-11-04", tone: "firm", key: "after_due:15" },
    ]);
  });

  it("follows the firm's settings (sorted, de-duplicated, no before-due at 0)", () => {
    const s = reminderSchedule("2026-03-30", { beforeDays: 0, afterDays: [30, 2, 2, 0] });
    expect(s.map((x) => [x.key, x.date])).toEqual([
      ["after_due:2", "2026-04-01"],
      ["after_due:30", "2026-04-29"],
    ]);
  });
});

describe("reminderEligibility (§7.9.5, §7.3.4)", () => {
  const base = { status: "sent" as InvoiceStatus, outstandingPaise: 100, clientStatus: "active" as const };

  it("allows Sent and Partially paid invoices with a balance for active (or pending) clients", () => {
    expect(reminderEligibility(base)).toEqual({ eligible: true });
    expect(reminderEligibility({ ...base, status: "partially_paid" })).toEqual({ eligible: true });
    expect(reminderEligibility({ ...base, clientStatus: "pending" })).toEqual({ eligible: true });
  });

  it("never reminds for Draft, Disputed, Waived or Paid invoices", () => {
    for (const status of ["draft", "disputed", "waived", "paid"] as InvoiceStatus[]) {
      const r = reminderEligibility({ ...base, status });
      expect(r).toMatchObject({ eligible: false, reason: status });
    }
  });

  it("never reminds clients On hold (or inactive)", () => {
    expect(reminderEligibility({ ...base, clientStatus: "on_hold" })).toMatchObject({ eligible: false, reason: "client_on_hold" });
    expect(reminderEligibility({ ...base, clientStatus: "inactive" })).toMatchObject({ eligible: false, reason: "client_inactive" });
  });

  it("doesn't remind while awaiting approval, once cancelled, or with nothing outstanding", () => {
    expect(reminderEligibility({ ...base, status: "awaiting_approval" })).toMatchObject({ eligible: false, reason: "awaiting_approval" });
    expect(reminderEligibility({ ...base, cancelled: true })).toMatchObject({ eligible: false, reason: "cancelled" });
    expect(reminderEligibility({ ...base, outstandingPaise: 0 })).toMatchObject({ eligible: false, reason: "nothing_outstanding" });
    const r = reminderEligibility({ ...base, status: "disputed" });
    if (!r.eligible) expect(r.message).toBe("It's disputed, so reminders are paused.");
  });
});

describe("reminderToSend (§7.9.5, daily job)", () => {
  const due = "2026-10-20";

  it("sends nothing before the first reminder date", () => {
    expect(reminderToSend(due, "2026-10-16")).toBeNull();
  });

  it("sends each reminder on its day, once", () => {
    expect(reminderToSend(due, "2026-10-17")?.key).toBe("before_due:3");
    expect(reminderToSend(due, "2026-10-18", ["before_due:3"])).toBeNull();
    expect(reminderToSend(due, "2026-10-21", ["before_due:3"])?.key).toBe("after_due:1");
    expect(reminderToSend(due, "2026-10-27", ["before_due:3", "after_due:1"])?.key).toBe("after_due:7");
    expect(reminderToSend(due, "2026-11-04", ["before_due:3", "after_due:1", "after_due:7"])?.key).toBe("after_due:15");
    expect(reminderToSend(due, "2026-12-01", ["before_due:3", "after_due:1", "after_due:7", "after_due:15"])).toBeNull();
  });

  it("catches up with only the latest missed reminder", () => {
    expect(reminderToSend(due, "2026-10-25", ["before_due:3"])?.key).toBe("after_due:1");
    expect(reminderToSend(due, "2026-11-10", [])?.key).toBe("after_due:15");
    expect(reminderToSend(due, "2026-10-25", ["after_due:1"])).toBeNull();
  });

  it("never sends the before-due reminder after the due date", () => {
    expect(reminderToSend(due, "2026-10-20")?.key).toBe("before_due:3"); // the due date itself is still before
    expect(reminderToSend(due, "2026-10-23", [], { beforeDays: 3, afterDays: [7] })).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Duplicate period and agreed fee (§7.9.2)
// -------------------------------------------------------------------------------------------------

describe("normalisePeriodLabel", () => {
  it("matches equivalent labels", () => {
    expect(normalisePeriodLabel(" sep  2026 ")).toBe(normalisePeriodLabel("Sep 2026"));
    expect(normalisePeriodLabel("FY 2026-27")).toBe(normalisePeriodLabel("2026-27"));
    expect(normalisePeriodLabel("Q2 2026-27")).toBe("quarter:2026-07-01");
    expect(normalisePeriodLabel("Annual retainer  ")).toBe("annual retainer");
    expect(normalisePeriodLabel("Sep 2026")).not.toBe(normalisePeriodLabel("Oct 2026"));
  });
});

describe("findDuplicatePeriodInvoice (§7.9.2: same engagement period → block with a link)", () => {
  const existing: PeriodInvoice[] = [
    { id: "a", invoiceNumber: "TW/26-27/0042", clientServiceId: "svc-gst", billingPeriodLabel: "Sep 2026", status: "sent" },
    { id: "b", invoiceNumber: null, clientServiceId: "svc-gst", billingPeriodLabel: "Oct 2026", status: "draft" },
    { id: "c", invoiceNumber: "TW/26-27/0050", clientServiceId: "svc-gst", billingPeriodLabel: "Aug 2026", status: "sent", cancelled: true },
    { id: "d", invoiceNumber: null, clientServiceId: "svc-gst", billingPeriodLabel: "Jul 2026", status: "draft", deleted: true },
    { id: "e", invoiceNumber: "TW/26-27/0010", clientServiceId: "svc-audit", billingPeriodLabel: "FY 2026-27", status: "paid" },
  ];

  it("finds an issued or draft invoice for the same engagement and period", () => {
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-gst", billingPeriodLabel: "sep 2026" }, existing)?.id).toBe("a");
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-gst", billingPeriodLabel: "Oct 2026" }, existing)?.id).toBe("b");
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-audit", billingPeriodLabel: "2026-27" }, existing)?.id).toBe("e");
  });

  it("ignores other engagements, cancelled and deleted invoices, and the invoice itself", () => {
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-tds", billingPeriodLabel: "Sep 2026" }, existing)).toBeNull();
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-gst", billingPeriodLabel: "Aug 2026" }, existing)).toBeNull();
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-gst", billingPeriodLabel: "Jul 2026" }, existing)).toBeNull();
    expect(findDuplicatePeriodInvoice({ id: "a", clientServiceId: "svc-gst", billingPeriodLabel: "Sep 2026" }, existing)).toBeNull();
  });

  it("can't check without an engagement or a period", () => {
    expect(findDuplicatePeriodInvoice({ clientServiceId: null, billingPeriodLabel: "Sep 2026" }, existing)).toBeNull();
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-gst", billingPeriodLabel: "  " }, existing)).toBeNull();
    expect(findDuplicatePeriodInvoice({ clientServiceId: "svc-gst", billingPeriodLabel: null }, existing)).toBeNull();
  });

  it("names the invoice to open", () => {
    expect(duplicatePeriodMessage(existing[0])).toBe("Sep 2026 is already billed for this engagement on invoice TW/26-27/0042. Open it instead of raising another.");
    expect(duplicatePeriodMessage(existing[1])).toBe("Oct 2026 is already billed for this engagement on a draft invoice. Open it instead of raising another.");
  });
});

describe("agreedFeeNote (§7.9.2)", () => {
  it("notes a fee different from the agreed one", () => {
    expect(agreedFeeNote(15_000_00, 18_000_00)).toBe("Agreed ₹15,000.00; invoicing ₹18,000.00.");
    expect(agreedFeeNote(15_000_00, 15_000_00)).toBeNull();
    expect(agreedFeeNote(null, 18_000_00)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Retainer billing (§7.9.6)
// -------------------------------------------------------------------------------------------------

describe("planRetainerBilling (§7.9.6)", () => {
  const monthly: RetainerEngagement = {
    autoInvoice: true,
    isActive: true,
    clientStatus: "active",
    agreedFeePaise: 15_000_00,
    frequency: "monthly",
    billingFrequency: null,
    nextBillingDate: "2026-10-01",
  };

  it("enumerates exactly the six skip reasons in §7.9.6", () => {
    expect(RETAINER_SKIP_REASONS.map((r) => RETAINER_SKIP_REASON_LABELS[r])).toEqual([
      "not enabled",
      "service inactive",
      "client inactive or on hold",
      "no agreed fee",
      "one-time service",
      "not yet due",
    ]);
  });

  it("skips with each reason", () => {
    const reason = (e: Partial<RetainerEngagement>) => {
      const p = planRetainerBilling({ ...monthly, ...e }, TODAY);
      return p.kind === "skip" ? p.reason : null;
    };
    expect(reason({ autoInvoice: false })).toBe("not_enabled");
    expect(reason({ isActive: false })).toBe("service_inactive");
    expect(reason({ clientStatus: "inactive" })).toBe("client_inactive_or_on_hold");
    expect(reason({ clientStatus: "on_hold" })).toBe("client_inactive_or_on_hold");
    expect(reason({ agreedFeePaise: null })).toBe("no_agreed_fee");
    expect(reason({ agreedFeePaise: 0 })).toBe("no_agreed_fee");
    expect(reason({ frequency: "one_time" })).toBe("one_time_service");
    expect(reason({ billingFrequency: "one_time" })).toBe("one_time_service");
    expect(reason({ nextBillingDate: "2026-10-23" })).toBe("not_yet_due");
    expect(reason({ nextBillingDate: null })).toBe("not_yet_due");
    const p = planRetainerBilling({ ...monthly, autoInvoice: false }, TODAY);
    expect(p).toEqual({ kind: "skip", reason: "not_enabled", label: "not enabled" });
  });

  it("checks the reasons in the §7.9.6 order", () => {
    const all: RetainerEngagement = { ...monthly, autoInvoice: false, isActive: false, clientStatus: "on_hold", agreedFeePaise: null, frequency: "one_time", nextBillingDate: null };
    expect(planRetainerBilling(all, TODAY)).toMatchObject({ reason: "not_enabled" });
    expect(planRetainerBilling({ ...all, autoInvoice: true }, TODAY)).toMatchObject({ reason: "service_inactive" });
    expect(planRetainerBilling({ ...all, autoInvoice: true, isActive: true }, TODAY)).toMatchObject({ reason: "client_inactive_or_on_hold" });
    expect(planRetainerBilling({ ...all, autoInvoice: true, isActive: true, clientStatus: "active" }, TODAY)).toMatchObject({ reason: "no_agreed_fee" });
    expect(planRetainerBilling({ ...all, autoInvoice: true, isActive: true, clientStatus: "active", agreedFeePaise: 1 }, TODAY)).toMatchObject({
      reason: "one_time_service",
    });
  });

  it("drafts the due period and advances next_billing_date by one cycle", () => {
    expect(planRetainerBilling(monthly, TODAY)).toEqual({
      kind: "bill",
      periods: [{ billingDate: "2026-10-01", periodLabel: "Oct 2026" }],
      amountPaise: 15_000_00,
      nextBillingDate: "2026-11-01",
      hitCap: false,
    });
    expect(planRetainerBilling({ ...monthly, nextBillingDate: TODAY }, TODAY)).toMatchObject({ kind: "bill", nextBillingDate: "2026-11-22" });
  });

  it("catches up missed periods, at most 3 per run, and reports hitting the cap", () => {
    const two = planRetainerBilling({ ...monthly, nextBillingDate: "2026-09-01" }, TODAY);
    expect(two).toMatchObject({ kind: "bill", nextBillingDate: "2026-11-01", hitCap: false });
    if (two.kind === "bill") expect(two.periods.map((p) => p.periodLabel)).toEqual(["Sep 2026", "Oct 2026"]);

    const three = planRetainerBilling({ ...monthly, nextBillingDate: "2026-08-01" }, TODAY);
    expect(three).toMatchObject({ kind: "bill", nextBillingDate: "2026-11-01", hitCap: false });

    const five = planRetainerBilling({ ...monthly, nextBillingDate: "2026-06-01" }, TODAY);
    expect(five.kind).toBe("bill");
    if (five.kind === "bill") {
      expect(five.periods.map((p) => p.billingDate)).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
      expect(five.nextBillingDate).toBe("2026-09-01");
      expect(five.hitCap).toBe(true);
    }
    // The next run picks up where it stopped.
    const next = planRetainerBilling({ ...monthly, nextBillingDate: "2026-09-01" }, TODAY);
    expect(next).toMatchObject({ hitCap: false, nextBillingDate: "2026-11-01" });
  });

  it("labels quarterly and annual periods, and uses billing_frequency when set", () => {
    const q = planRetainerBilling({ ...monthly, frequency: "quarterly", nextBillingDate: "2026-10-01" }, TODAY);
    expect(q).toMatchObject({ periods: [{ periodLabel: "Q3 2026-27" }], nextBillingDate: "2027-01-01" });
    const a = planRetainerBilling({ ...monthly, frequency: "annual", nextBillingDate: "2026-04-01" }, TODAY);
    expect(a).toMatchObject({ periods: [{ periodLabel: "FY 2026-27" }], nextBillingDate: "2027-04-01" });
    const billedQuarterly = planRetainerBilling({ ...monthly, billingFrequency: "quarterly", nextBillingDate: "2026-07-01" }, TODAY);
    expect(billedQuarterly).toMatchObject({ periods: [{ periodLabel: "Q2 2026-27" }, { periodLabel: "Q3 2026-27" }], nextBillingDate: "2027-01-01" });
    expect(retainerPeriodLabel("2027-03-31", "annual")).toBe("FY 2026-27");
  });

  it("keeps month-end billing dates on month ends (no drift)", () => {
    const p = planRetainerBilling({ ...monthly, nextBillingDate: "2026-01-31" }, "2026-03-31");
    expect(p.kind).toBe("bill");
    if (p.kind === "bill") {
      expect(p.periods.map((x) => x.billingDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
      expect(p.nextBillingDate).toBe("2026-04-30");
      expect(p.hitCap).toBe(false);
    }
  });

  it("can label in arrears (the period before the billing date) and honours a custom cap", () => {
    const p = planRetainerBilling({ ...monthly, nextBillingDate: "2026-10-01" }, TODAY, { arrears: true });
    expect(p).toMatchObject({ periods: [{ billingDate: "2026-10-01", periodLabel: "Sep 2026" }] });
    const capped = planRetainerBilling({ ...monthly, nextBillingDate: "2026-06-01" }, TODAY, { maxPeriodsPerRun: 1 });
    expect(capped).toMatchObject({ periods: [{ billingDate: "2026-06-01" }], nextBillingDate: "2026-07-01", hitCap: true });
  });

  it("bills a client whose onboarding is pending (only inactive / on hold are skipped)", () => {
    expect(planRetainerBilling({ ...monthly, clientStatus: "pending" }, TODAY).kind).toBe("bill");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildStatement,
  collectionRate,
  daysSalesOutstanding,
  decideInvoiceReminder,
  formatBalance,
  matchTdsStatement,
  overdueFrom,
  parseStatementAmount,
  parseStatementDate,
  parseTdsStatement,
  ratioPercent,
  reminderDueDateWindow,
  reminderIdempotencyKey,
  reminderSettingsFrom,
  reminderSlotLabel,
  statementEvents,
  sweepDueDates,
  tdsCorrectionDraft,
  tdsStatementDueDate,
  type MatchableReceipt,
  type TdsStatementLine,
} from "@/lib/domain/collections";

describe("ratios (§7.9.5)", () => {
  it("rounds percentages half-up exactly and refuses a zero base", () => {
    expect(ratioPercent(1, 3)).toBe(33.3);
    expect(ratioPercent(2, 3)).toBe(66.7);
    expect(ratioPercent(1, 8, 2)).toBe(12.5);
    expect(ratioPercent(0, 100)).toBe(0);
    expect(ratioPercent(5, 0)).toBeNull();
    expect(ratioPercent(150, 100)).toBe(150);
  });

  it("collection rate counts the opening receivables and billing, less credits and write-offs", () => {
    const r = collectionRate({ openingPaise: 100_000_00, billedPaise: 400_000_00, creditedPaise: 20_000_00, writtenOffPaise: 30_000_00, collectedPaise: 360_000_00 });
    expect(r.duePaise).toBe(450_000_00);
    expect(r.ratePercent).toBe(80);
    expect(collectionRate({ openingPaise: 0, billedPaise: 0, creditedPaise: 0, writtenOffPaise: 0, collectedPaise: 0 }).ratePercent).toBeNull();
  });

  it("days sales outstanding over the last 90 days' billing", () => {
    expect(daysSalesOutstanding({ outstandingPaise: 150_000_00, billedPaise: 300_000_00, days: 90 })).toBe(45);
    expect(daysSalesOutstanding({ outstandingPaise: 1, billedPaise: 3, days: 90 })).toBe(30);
    expect(daysSalesOutstanding({ outstandingPaise: 100, billedPaise: 0, days: 90 })).toBeNull();
  });
});

describe("payment reminders (§7.9.5)", () => {
  const base = { status: "sent" as const, outstandingPaise: 5900_00, clientStatus: "active" as const, dueDate: "2026-10-20", doneKeys: [] as string[] };

  it("sends 3 days before the due date, then 1, 7 and 15 days after", () => {
    expect(decideInvoiceReminder({ ...base, today: "2026-10-17" })).toMatchObject({ action: "send", stage: "before", days: 3, slot: { key: "before_due:3" } });
    expect(decideInvoiceReminder({ ...base, today: "2026-10-21" })).toMatchObject({ action: "send", stage: "after", days: 1, slot: { key: "after_due:1" } });
    expect(decideInvoiceReminder({ ...base, today: "2026-10-27" })).toMatchObject({ action: "send", stage: "after", days: 7, slot: { key: "after_due:7" } });
    expect(decideInvoiceReminder({ ...base, today: "2026-11-04" })).toMatchObject({ action: "send", stage: "after", days: 15, slot: { key: "after_due:15" } });
    expect(decideInvoiceReminder({ ...base, today: "2026-10-18", doneKeys: ["before_due:3"] })).toEqual({ action: "wait" });
    expect(decideInvoiceReminder({ ...base, today: "2026-10-16" })).toEqual({ action: "wait" });
  });

  it("never reminds about a Draft, Disputed, Waived or Paid invoice, or a client On hold", () => {
    for (const status of ["draft", "awaiting_approval", "disputed", "waived", "paid"] as const) {
      expect(decideInvoiceReminder({ ...base, status, today: "2026-10-21" })).toEqual({ action: "skip", reason: status });
    }
    expect(decideInvoiceReminder({ ...base, clientStatus: "on_hold", today: "2026-10-21" })).toEqual({ action: "skip", reason: "client_on_hold" });
    expect(decideInvoiceReminder({ ...base, cancelled: true, today: "2026-10-21" })).toEqual({ action: "skip", reason: "cancelled" });
    expect(decideInvoiceReminder({ ...base, outstandingPaise: 0, today: "2026-10-21" })).toEqual({ action: "skip", reason: "nothing_outstanding" });
  });

  it("doesn't repeat a slot, and lets a missed slot go only within the grace days", () => {
    expect(decideInvoiceReminder({ ...base, today: "2026-10-21", doneKeys: ["after_due:1"] })).toEqual({ action: "wait" });
    // The 7-day slot (27 Oct) missed: still sent on 30 Oct (3 days late), not on 31 Oct.
    expect(decideInvoiceReminder({ ...base, today: "2026-10-30" })).toMatchObject({ action: "send", days: 10, slot: { key: "after_due:7" } });
    expect(decideInvoiceReminder({ ...base, today: "2026-10-31" })).toEqual({ action: "wait" });
  });

  it("reads the firm's reminder settings, keys each email once, and names each slot", () => {
    expect(reminderSettingsFrom({ invoice_reminder_before_days: 5, invoice_reminder_after_days: [2, 10] })).toEqual({ beforeDays: 5, afterDays: [2, 10] });
    expect(reminderSettingsFrom(null)).toEqual({ beforeDays: 3, afterDays: [1, 7, 15] });
    expect(reminderSettingsFrom({ invoice_reminder_after_days: [0, -1] })).toEqual({ beforeDays: 3, afterDays: [1, 7, 15] });
    expect(reminderIdempotencyKey("abc", { kind: "before_due", offsetDays: -3 })).toBe("invoice:abc:reminder:before_due:3");
    expect(reminderIdempotencyKey("abc", { kind: "after_due", offsetDays: 15 })).toBe("invoice:abc:reminder:after_due:15");
    expect(reminderSlotLabel("before_due:3")).toBe("3 days before the due date");
    expect(reminderSlotLabel("after_due:1")).toBe("1 day after the due date");
    expect(reminderDueDateWindow("2026-10-23")).toEqual({ from: "2026-10-05", to: "2026-10-26" });
  });

  it("an invoice becomes overdue the day after its due date; the sweep looks back a few days", () => {
    expect(overdueFrom("2026-10-22")).toBe("2026-10-23");
    expect(sweepDueDates("2026-10-23")).toEqual({ from: "2026-10-20", to: "2026-10-22" });
    expect(sweepDueDates("2026-10-23", 1)).toEqual({ from: "2026-10-22", to: "2026-10-22" });
  });
});

describe("statement of account (§11)", () => {
  const events = statementEvents({
    invoices: [
      { id: "i1", number: "TW/25-26/0090", kind: "tax_invoice", issueDate: "2026-03-10", totalPaise: 11800_00 },
      { id: "i2", number: "TW/26-27/0004", kind: "tax_invoice", issueDate: "2026-04-05", totalPaise: 5900_00, periodLabel: "Apr 2026" },
      { id: "i3", number: "TW/26-27/0009", kind: "tax_invoice", issueDate: "2026-05-05", totalPaise: 5900_00, cancelledOn: "2026-05-07" },
      { id: "i4", number: "TW/26-27/0012", kind: "tax_invoice", issueDate: "2026-06-01", totalPaise: 2360_00, waivedOn: "2026-09-30", waivedPaise: 360_00 },
    ],
    receipts: [
      { id: "r1", number: "TW-R/25-26/0050", invoiceNumber: "TW/25-26/0090", paymentDate: "2026-03-30", receivedPaise: 10800_00, tdsPaise: 1000_00, tdsSection: "194J", methodLabel: "UPI" },
      { id: "r2", number: "TW-R/26-27/0007", invoiceNumber: "TW/26-27/0004", paymentDate: "2026-04-20", receivedPaise: 5400_00, tdsPaise: 500_00, tdsSection: "393", reference: "UTR123", methodLabel: "Bank transfer" },
      { id: "r3", number: "TW-R/26-27/0010", invoiceNumber: "TW/26-27/0012", paymentDate: "2026-06-15", receivedPaise: 2000_00, tdsPaise: 0, reversedOn: "2026-06-20" },
    ],
    creditNotes: [{ id: "c1", number: "TW-CN/26-27/0001", invoiceNumber: "TW/26-27/0004", issueDate: "2026-04-25", totalPaise: 0 }],
  });

  it("opens with what was owed before the period, runs a balance, and closes on it", () => {
    const st = buildStatement(events, { from: "2026-04-01", to: "2026-09-30" });
    expect(st.openingPaise).toBe(0);
    expect(st.rows.map((r) => r.kind)).toEqual(["invoice", "receipt", "tds", "credit_note", "invoice", "cancellation", "invoice", "receipt", "reversal", "write_off"]);
    expect(st.rows.at(-1)?.balancePaise).toBe(st.closingPaise);
    // 5,900 − 5,400 − 500 + 5,900 − 5,900 + 2,360 − 2,000 + 2,000 − 360 = 2,000
    expect(st.closingPaise).toBe(2000_00);
    expect(st.totals.byKind.tds).toBe(500_00);
    expect(st.totals.debitPaise - st.totals.creditPaise).toBe(st.closingPaise - st.openingPaise);
  });

  it("carries earlier movements into the opening balance", () => {
    const st = buildStatement(events, { from: "2026-05-01", to: "2026-05-31" });
    expect(st.openingPaise).toBe(0);
    const before = buildStatement(events, { from: "2026-03-15", to: "2026-03-31" });
    expect(before.openingPaise).toBe(11800_00);
    expect(before.closingPaise).toBe(0);
    expect(() => buildStatement(events, { from: "2026-05-01", to: "2026-04-01" })).toThrow();
  });

  it("describes each movement in words", () => {
    const st = buildStatement(events, { from: "2026-04-01", to: "2026-04-30" });
    expect(st.rows[0].description).toBe("Invoice TW/26-27/0004 for Apr 2026");
    expect(st.rows[1].description).toBe("Payment against invoice TW/26-27/0004 (Bank transfer · UTR123)");
    expect(st.rows[2].description).toBe("TDS deducted under s.393 on invoice TW/26-27/0004");
    expect(formatBalance(2000_00)).toBe("₹2,000.00 Dr");
    expect(formatBalance(-500_00)).toBe("₹500.00 Cr");
    expect(formatBalance(0)).toBe("₹0.00");
  });
});

describe("TDS statements (§7.9.9)", () => {
  const twentySixAs = [
    "Annual Tax Statement under Section 203AA of the Income Tax Act, 1961",
    "Assessment Year^2027-28",
    "PART-I - Details of Tax Deducted at Source",
    "Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)",
    "1^ALPHA TRADERS PRIVATE LIMITED^BLRA12345B^^^^^60000.00^6000.00^6000.00",
    "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)",
    "^1^194J^15-Sep-2026^F^10-Oct-2026^-^50000.00^5000.00^5000.00",
    "^2^194J^20-Sep-2026^U^10-Oct-2026^-^10000.00^1000.00^1000.00",
    "2^BETA INDUSTRIES^MUMB12345C^^^^^20000.00^2000.00^2000.00",
    "^1^194J^05-Oct-2026^F^30-Oct-2026^-^20000.00^2000.00^2000.00",
    "PART-II - Details of Tax Deducted at Source for 15G / 15H",
    "Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)",
    "1^SOME BANK^CHEN12345D^^^^^9000.00^0.00^0.00",
    "^1^194A^31-Mar-2027^F^15-May-2027^-^9000.00^0.00^0.00",
  ].join("\n");

  it("reads a TRACES 26AS text export: deductors, their transactions, booking status, Part I only", () => {
    const r = parseTdsStatement(twentySixAs);
    expect(r.format).toBe("26as_text");
    expect(r.financialYear).toBe("2026-27");
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ tan: "BLRA12345B", deductorName: "ALPHA TRADERS PRIVATE LIMITED", section: "194J", transactionDate: "2026-09-15", bookingStatus: "F", bookingDate: "2026-10-10", amountPaidPaise: 50000_00, tdsPaise: 5000_00 });
    expect(r.lines[1].bookingStatus).toBe("U");
    expect(r.lines[2]).toMatchObject({ tan: "MUMB12345C", tdsPaise: 2000_00, transactionDate: "2026-10-05" });
    expect(r.problems).toEqual([]);
  });

  it("reads a table (CSV) with a header row, and lists what it can't read", () => {
    const csv = [
      "TAN of Deductor,Name of Deductor,Section,Date of payment,Amount paid,TDS deducted",
      'BLRA12345B,"Alpha Traders, Bengaluru",194J,15/09/2026,"50,000.00","5,000.00"',
      "BADTAN,Someone,194J,15/09/2026,100,10",
      "MUMB12345C,Beta,194J,31/02/2026,100,",
    ].join("\n");
    const r = parseTdsStatement(csv);
    expect(r.format).toBe("table");
    expect(r.lines).toEqual([
      expect.objectContaining({ tan: "BLRA12345B", deductorName: "Alpha Traders, Bengaluru", section: "194J", transactionDate: "2026-09-15", amountPaidPaise: 50000_00, tdsPaise: 5000_00 }),
    ]);
    expect(r.problems.map((p) => p.lineNo)).toEqual([3, 4]);
  });

  it("reads an AIS-style table whose deductor is 'NAME (TAN)'", () => {
    const csv = ["Information Source,Quarter,Date of payment/credit,Amount paid/credited,TDS deducted,TDS deposited", "ALPHA TRADERS (BLRA12345B),Q2,15-09-2026,50000,5000,5000"].join("\n");
    const r = parseTdsStatement(csv);
    expect(r.lines).toEqual([expect.objectContaining({ tan: "BLRA12345B", deductorName: "ALPHA TRADERS", transactionDate: "2026-09-15", tdsPaise: 5000_00 })]);
  });

  it("parses amounts and dates strictly", () => {
    expect(parseStatementAmount("1,23,456.50")).toBe(12345650);
    expect(parseStatementAmount("₹ 500")).toBe(50000);
    expect(parseStatementAmount("12.345")).toBeNull();
    expect(parseStatementAmount("-")).toBeNull();
    expect(parseStatementDate("15-SEP-2026")).toBe("2026-09-15");
    expect(parseStatementDate("2026-09-15")).toBe("2026-09-15");
    expect(parseStatementDate("31/04/2026")).toBeNull();
    expect(parseStatementDate("15 September 2026")).toBe("2026-09-15");
  });

  const receipt = (id: string, tan: string | null, tds: number, date: string, extra: Partial<MatchableReceipt> = {}): MatchableReceipt => ({
    id,
    tan,
    tdsPaise: tds,
    paymentDate: date,
    quarter: null,
    status: "expected",
    matched: false,
    ...extra,
  });
  const line = (tan: string, tds: number, date: string | null, extra: Partial<TdsStatementLine> = {}): TdsStatementLine => ({
    lineNo: 1,
    tan,
    deductorName: null,
    section: "194J",
    transactionDate: date,
    bookingStatus: "F",
    bookingDate: null,
    amountPaidPaise: null,
    tdsPaise: tds,
    ...extra,
  });

  it("matches by TAN and amount, nearest date first, one receipt per line", () => {
    const receipts = [
      receipt("r-jul", "BLRA12345B", 5000_00, "2026-07-10", { quarter: "Q2 2026-27" }),
      receipt("r-sep", "BLRA12345B", 5000_00, "2026-09-14", { quarter: "Q2 2026-27" }),
      receipt("r-other", "MUMB12345C", 5000_00, "2026-09-14"),
    ];
    const m = matchTdsStatement([line("BLRA12345B", 5000_00, "2026-09-15"), line("BLRA12345B", 5000_00, "2026-07-11")], receipts);
    expect(m[0]).toMatchObject({ status: "matched", receiptIds: ["r-sep"], note: null });
    expect(m[1]).toMatchObject({ status: "matched", receiptIds: ["r-jul"] });
  });

  it("allows ₹1 of rounding, combines receipts paid together, and reports mismatches", () => {
    const receipts = [
      receipt("a", "BLRA12345B", 1234_40, "2026-09-01"),
      receipt("b1", "BLRA12345B", 300_00, "2026-10-01", { quarter: "Q3 2026-27" }),
      receipt("b2", "BLRA12345B", 200_00, "2026-10-02", { quarter: "Q3 2026-27" }),
      receipt("done", "BLRA12345B", 999_00, "2026-10-02", { status: "reflected" }),
    ];
    const m = matchTdsStatement(
      [line("BLRA12345B", 1234_00, "2026-09-01"), line("BLRA12345B", 500_00, "2026-10-05"), line("BLRA12345B", 999_00, "2026-10-06"), line("ZZZZ99999Z", 100_00, "2026-10-06")],
      receipts,
    );
    expect(m[0]).toMatchObject({ status: "matched", receiptIds: ["a"] });
    expect(m[0].note).toMatch(/Within ₹1/);
    expect(m[1]).toMatchObject({ status: "matched", receiptIds: ["b1", "b2"], note: "2 receipts paid together." });
    expect(m[2]).toMatchObject({ status: "unmatched", receiptIds: [] });
    expect(m[3]).toMatchObject({ status: "unmatched", note: "No expected TDS from this TAN in our receipts." });
  });

  it("calls an amount that doesn't fit a mismatch, and never matches a line TRACES marks U", () => {
    const receipts = [receipt("x", "BLRA12345B", 5000_00, "2026-09-10", { quarter: "Q2 2026-27" })];
    const m = matchTdsStatement([line("BLRA12345B", 4500_00, "2026-09-15"), line("BLRA12345B", 5000_00, "2026-09-15", { bookingStatus: "U" })], receipts);
    expect(m[0].status).toBe("amount_mismatch");
    expect(m[0].note).toBe("The statement shows ₹4,500.00; our receipts from this TAN for Q2 2026-27 show ₹5,000.00 expected.");
    expect(m[1]).toMatchObject({ status: "unmatched", receiptIds: [] });
    expect(m[1].note).toMatch(/unmatched \(U\)/);
  });

  it("works out when the deductor's statement is due from the due-date rules", () => {
    const rules = [
      { rule: { day: 31, quarters: [1], monthOffset: 1, afterQuarterEnd: true } },
      { rule: { day: 31, quarters: [2], monthOffset: 1, afterQuarterEnd: true } },
      { rule: { day: 31, quarters: [3], monthOffset: 1, afterQuarterEnd: true } },
      { rule: { day: 31, quarters: [4], monthOffset: 2, afterQuarterEnd: true } },
    ];
    expect(tdsStatementDueDate("Q1 2026-27", rules)).toBe("2026-07-31");
    expect(tdsStatementDueDate("Q2 2026-27", rules)).toBe("2026-10-31");
    expect(tdsStatementDueDate("Q3 2026-27", rules)).toBe("2027-01-31");
    expect(tdsStatementDueDate("Q4 2026-27", rules)).toBe("2027-05-31");
    expect(tdsStatementDueDate("Sep 2026", rules)).toBeNull();
  });

  it("drafts the message asking the client to correct their TDS statement", () => {
    const d = tdsCorrectionDraft({
      contactName: "Ravi",
      clientName: "Alpha Traders",
      firmName: "TaxWise Consultants",
      firmPan: "AAXFT1811B",
      senderName: "Anita",
      items: [
        { invoiceNumber: "TW/26-27/0004", invoiceDate: "2026-04-05", tdsPaise: 500_00, section: "194J", quarter: "Q1 2026-27" },
        { invoiceNumber: "TW/26-27/0011", invoiceDate: "2026-05-05", tdsPaise: 1000_00, section: "393", quarter: "Q1 2026-27", statementPaise: 900_00 },
      ],
    });
    expect(d.subject).toBe("TaxWise Consultants | TDS deducted on our invoices: correction needed");
    expect(d.body).toContain("Dear Ravi,");
    expect(d.body).toContain("- ₹500.00 TDS on invoice TW/26-27/0004 dated 05 Apr 2026, section 194J, Q1 2026-27; it doesn't show in our 26AS / AIS");
    expect(d.body).toContain("our 26AS shows ₹900.00");
    expect(d.body).toContain("Total: ₹1,500.00.");
    expect(d.body).toContain("our PAN is AAXFT1811B");
    expect(d.body.endsWith("TaxWise Consultants")).toBe(true);
  });
});

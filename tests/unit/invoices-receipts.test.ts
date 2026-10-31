import { describe, expect, it } from "vitest";
import {
  RecordReceiptSchema,
  checkReceiptAmounts,
  paiseOf,
  receiptPayload,
  receiptShareText,
  referenceLabel,
  storedTdsSection,
  tdsQuarterLabel,
  tdsSectionOptions,
  tdsSuggestion,
} from "@/lib/schemas/receipts";
import { tdsRulesOn } from "@/lib/domain/tds";
import {
  CREDIT_NOTE_REASON_OPTIONS,
  IssueCreditNoteSchema,
  creditNotePayload,
  creditNotePreview,
  creditableRates,
} from "@/lib/schemas/credit-notes";

const INVOICE = "0b6f2b1e-1c55-4d5a-9a3e-5f2f8a1f0c01";

describe("Record receipt (§7.9.4, §6.5)", () => {
  it("suggests TDS on the taxable value excluding GST, less what earlier receipts recorded", () => {
    // ₹10,000 taxable + ₹1,800 GST; 10% under 194J → ₹1,000, not ₹1,180 (CBDT Circular 23/2017).
    const s = tdsSuggestion({ taxablePaise: 1_000_000, ratePercent: 10, tdsAlreadyPaise: 0, tdsDeductedText: "" });
    expect(s?.expectedPaise).toBe(100_000);
    expect(s?.difference).toBeNull();
    const after = tdsSuggestion({ taxablePaise: 1_000_000, ratePercent: 10, tdsAlreadyPaise: 40_000, tdsDeductedText: "500" });
    expect(after?.expectedPaise).toBe(60_000);
    expect(after?.difference?.kind).toBe("short");
    expect(after?.difference?.message).toContain("₹100.00 less");
    expect(tdsSuggestion({ taxablePaise: 1_000_000, ratePercent: null, tdsAlreadyPaise: 0, tdsDeductedText: "" })).toBeNull();
  });

  it("refuses more than the outstanding amount plus ₹1, and says to record the advance separately", () => {
    expect(checkReceiptAmounts({ amountReceived: "10900", tdsAmount: "1000" }, 1_180_000).ok).toBe(false);
    expect(checkReceiptAmounts({ amountReceived: "10800", tdsAmount: "1000" }, 1_180_000).ok).toBe(true);
    expect(checkReceiptAmounts({ amountReceived: "10801", tdsAmount: "0" }, 1_080_000).ok).toBe(true);
    const over = checkReceiptAmounts({ amountReceived: "12000", tdsAmount: "" }, 1_180_000);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error).toContain("advance separately");
      expect(Object.keys(over.fieldErrors ?? {})).toContain("amountReceived");
    }
    const nothing = checkReceiptAmounts({ amountReceived: "0", tdsAmount: "" }, 1_180_000);
    expect(nothing.ok).toBe(false);
  });

  it("picks the TDS rules in force on the payment date, professional fees first, then Other", () => {
    const rules = tdsRulesOn("2026-10-22");
    const options = tdsSectionOptions(rules);
    expect(options[0].value.endsWith(":professional")).toBe(true);
    expect(options.at(-1)?.value).toBe("OTHER");
    expect(storedTdsSection(options[0].value)).toBe(options[0].value.split(":")[0].toUpperCase());
    expect(storedTdsSection("")).toBe("OTHER");
  });

  it("names the TDS quarter as record_receipt stores it", () => {
    expect(tdsQuarterLabel("2026-10-22")).toBe("Q3 2026-27");
    expect(tdsQuarterLabel("2027-03-31")).toBe("Q4 2026-27");
    expect(tdsQuarterLabel("2026-04-01")).toBe("Q1 2026-27");
  });

  it("asks for the section when TDS was deducted", () => {
    const r = RecordReceiptSchema.safeParse({ invoiceId: INVOICE, paymentDate: "2026-10-22", amountReceived: "10620", tdsAmount: "1180", method: "upi" });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(["tdsSection"]);
    expect(RecordReceiptSchema.safeParse({ invoiceId: INVOICE, paymentDate: "2026-10-22", amountReceived: "100", method: "" }).success).toBe(false);
  });

  it("writes the WhatsApp message that goes with the receipt PDF", () => {
    const base = { contactName: "Rakesh Sharma", receiptNumber: "TW-R/26-27/0007", invoiceNumber: "TW/26-27/0042", paymentDate: "22 Oct 2026", amount: "₹10,620.00", tds: null, balance: null, firmName: "TaxWise Consultants" };
    const paid = receiptShareText(base);
    expect(paid).toContain("Hi Rakesh, thank you for your payment of ₹10,620.00 received on 22 Oct 2026 against invoice TW/26-27/0042.");
    expect(paid).toContain("Please find receipt TW-R/26-27/0007 from TaxWise Consultants attached.");
    expect(paid).toContain("fully paid");
    expect(paid).not.toContain("Form 16A");
    const part = receiptShareText({ ...base, contactName: null, tds: "₹1,180.00", balance: "₹2,000.00" });
    expect(part.startsWith("Hello, thank you")).toBe(true);
    expect(part).toContain("(and TDS of ₹1,180.00)");
    expect(part).toContain("₹2,000.00 is still to pay on the invoice.");
    expect(part).toContain("Form 16A");
  });

  it("sends decimals to record_receipt and no section without TDS", () => {
    const v = RecordReceiptSchema.parse({ invoiceId: INVOICE, paymentDate: "2026-10-22", amountReceived: "10,620.5", tdsAmount: "", tdsSection: "194J:professional", method: "bank_transfer", reference: "UTR123", claimId: "" });
    const p = receiptPayload(v);
    expect(p.amount_received).toBe("10620.50");
    expect(p.tds_amount).toBe("0.00");
    expect(p.tds_section).toBeNull();
    expect(p.claim_id).toBeNull();
    expect(paiseOf("abc")).toBe(0);
    expect(referenceLabel("bank_transfer")).toBe("UTR");
    expect(referenceLabel("cheque")).toBe("Cheque no.");
  });
});

describe("Credit notes (§7.9.7, §6.4 s.34)", () => {
  const items = [
    { amount: 10000, tax_rate: 18, is_reimbursement: false },
    { amount: 2000, tax_rate: 5, is_reimbursement: false },
    { amount: 600, tax_rate: 0, is_reimbursement: true },
  ];

  it("knows the taxable value still creditable at each rate", () => {
    const rates = creditableRates(items, [
      { taxable_amount: 4000, tax_rate: 18, reduces_gst: true },
      { taxable_amount: 500, tax_rate: null, reduces_gst: false },
    ]);
    expect(rates.map((r) => r.ratePercent)).toEqual([18, 5]);
    expect(rates[0].remainingPaise).toBe(600_000);
    expect(rates[1].remainingPaise).toBe(200_000);
  });

  const preview = (over: Partial<Parameters<typeof creditNotePreview>[0]> = {}) =>
    creditNotePreview({
      taxableText: "1000",
      ratePercent: 18,
      reducesGst: true,
      invoiceDate: "2026-06-15",
      creditNoteDate: "2026-10-22",
      annualReturnFiledOn: null,
      placeOfSupplyCode: "29",
      firmStateCode: "29",
      remainingTaxablePaise: 600_000,
      outstandingPaise: 1_180_000,
      ...over,
    });

  it("splits the GST the invoice's way", () => {
    const intra = preview();
    expect(intra.amounts?.cgstPaise).toBe(9_000);
    expect(intra.amounts?.sgstPaise).toBe(9_000);
    expect(intra.amounts?.totalPaise).toBe(118_000);
    const inter = preview({ placeOfSupplyCode: "27" });
    expect(inter.amounts?.igstPaise).toBe(18_000);
  });

  it("refuses more than the remaining taxable value, and a commercial credit above the outstanding", () => {
    expect(preview({ taxableText: "7000" }).amountError).toContain("₹6,000.00");
    expect(preview({ reducesGst: false, ratePercent: null, taxableText: "20000" }).amountError).toContain("outstanding");
  });

  it("warns from 30 days before the s.34 deadline and refuses a tax-reducing note after it (§18.3 Partner 6)", () => {
    // Supply in FY 2026-27 → deadline 30 Nov 2027.
    expect(preview({ creditNoteDate: "2027-10-01" }).check.level).toBe("ok");
    expect(preview({ creditNoteDate: "2027-11-10" }).check.level).toBe("warn");
    expect(preview({ creditNoteDate: "2027-11-30" }).check.allowed).toBe(true);
    const late = preview({ creditNoteDate: "2027-12-01" });
    expect(late.check.level).toBe("refuse");
    expect(late.check.allowed).toBe(false);
    const commercial = preview({ creditNoteDate: "2027-12-01", reducesGst: false, ratePercent: null });
    expect(commercial.check.allowed).toBe(true);
    expect(commercial.check.level).toBe("commercial");
  });

  it("uses the annual return's filing date when it is earlier", () => {
    const filed = preview({ annualReturnFiledOn: "2027-09-15", creditNoteDate: "2027-09-20" });
    expect(filed.check.deadline).toBe("2027-09-15");
    expect(filed.check.level).toBe("refuse");
  });

  it("works out what the firm would owe back when the client has paid more than the note leaves due", () => {
    expect(preview({ outstandingPaise: 50_000 }).refundPaise).toBe(68_000);
    expect(preview().refundPaise).toBe(0);
  });

  it("validates the form and builds the jsonb for issue_credit_note", () => {
    expect(CREDIT_NOTE_REASON_OPTIONS.length).toBeGreaterThan(0);
    const bad = IssueCreditNoteSchema.safeParse({ invoiceId: INVOICE, reasonCode: "", reason: "", taxableAmount: "0", taxRate: "", reducesGst: true, issueDate: "2026-10-22" });
    expect(bad.success).toBe(false);
    const v = IssueCreditNoteSchema.parse({
      invoiceId: INVOICE,
      reasonCode: CREDIT_NOTE_REASON_OPTIONS[0].value,
      reason: "Scope reduced",
      taxableAmount: "1000.5",
      taxRate: "18",
      reducesGst: true,
      issueDate: "2026-10-22",
    });
    const p = creditNotePayload(v);
    expect(p.taxable_amount).toBe("1000.50");
    expect(p.tax_rate).toBe("18");
    expect(p.annual_return_filed_on).toBeNull();
    const commercial = creditNotePayload(IssueCreditNoteSchema.parse({ ...v, reducesGst: false, taxRate: "" }));
    expect(commercial.tax_rate).toBeNull();
  });
});

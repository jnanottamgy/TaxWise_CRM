import { describe, expect, it } from "vitest";
import {
  claimStatus,
  deadlineStatus,
  explainDeadline,
  firstName,
  formCopy,
  homeSummary,
  invoiceStatus,
  isDeadlineProgress,
  isPayable,
  outstandingItemCount,
  paymentNote,
  periodInWords,
  periodShort,
  requestItemStatus,
  whatWeNeed,
} from "@/lib/domain/portal-copy";

describe("periodInWords", () => {
  it.each([
    ["Sep 2026", "September 2026"],
    ["Mar 2027", "March 2027"],
    ["Q1 2026-27", "April to June 2026"],
    ["Q2 2026-27", "July to September 2026"],
    ["Q3 2026-27", "October to December 2026"],
    ["Q4 2026-27", "January to March 2027"],
    ["H1 2026-27", "April to September 2026"],
    ["H2 2026-27", "October 2026 to March 2027"],
    ["FY 2026-27", "the year 2026-27 (April 2026 to March 2027)"],
    ["AY 2026-27", "assessment year 2026-27 (income earned in 2025-26)"],
    ["Tax year 2026-27", "tax year 2026-27 (April 2026 to March 2027)"],
    ["FY 2026-27 (DIN 01234567)", "the year 2026-27 (April 2026 to March 2027) (DIN 01234567)"],
  ])("%s → %s", (label, words) => {
    expect(periodInWords(label)).toBe(words);
  });

  it("leaves unknown shapes, and an FY that doesn't add up, as they are", () => {
    expect(periodInWords("Sept-Oct 2026")).toBe("Sept-Oct 2026");
    expect(periodInWords("Q2 2026-29")).toBe("Q2 2026-29");
    expect(periodInWords("")).toBeNull();
    expect(periodInWords(null)).toBeNull();
  });

  it("keeps year labels short for headlines", () => {
    expect(periodShort("AY 2026-27")).toBe("AY 2026-27");
    expect(periodShort("FY 2026-27")).toBe("FY 2026-27");
    expect(periodShort("Sep 2026")).toBe("September 2026");
  });
});

describe("explainDeadline (§7.22 plain language)", () => {
  it("GSTR-3B for September: your monthly GST summary return", () => {
    const d = explainDeadline({ formCode: "GSTR-3B", type: "gstr_3b", filingPeriod: "Sep 2026", title: "GSTR-3B (monthly) for Sep 2026" });
    expect(d.headline).toBe("GSTR-3B for September 2026");
    expect(d.sentence).toBe("GSTR-3B for September 2026: your monthly GST summary return, where the tax for the month is paid");
    expect(d.needs.length).toBeGreaterThan(0);
  });

  it("a quarterly period picks the QRMP wording", () => {
    const d = explainDeadline({ formCode: "GSTR-3B", type: "gstr_3b", filingPeriod: "Q2 2026-27", title: "GSTR-3B (quarterly, QRMP) for Q2 2026-27" });
    expect(d.headline).toBe("GSTR-3B for July to September 2026");
    expect(d.explanation).toMatch(/quarterly GST summary return under the QRMP scheme/);
    expect(explainDeadline({ formCode: "GSTR-1", type: "gstr_1", filingPeriod: "Q2 2026-27", title: null }).explanation).toMatch(/quarterly/);
  });

  it("knows every form code the statutory calendar generates", () => {
    const codes = [
      "GSTR-1", "IFF", "GSTR-3B", "PMT-06", "CMP-08", "GSTR-4", "GSTR-7", "GSTR-8", "GSTR-9", "GSTR-9C", "ITR", "ITR (belated)",
      "ITR (revised)", "ITR-U", "Form 3CA/3CB-3CD", "Form 3CEB", "Advance tax", "TDS deposit", "24Q/26Q/27Q", "Form 16", "Form 16A",
      "AGM", "ADT-1", "AOC-4", "MGT-7/MGT-7A", "DPT-3", "MSME-1", "DIR-3 KYC Web", "LLP Form 11", "LLP Form 8", "PF/ESIC",
      "PT (Karnataka)", "PT enrolment (Karnataka)",
    ];
    for (const code of codes) {
      const c = formCopy(code, "Sep 2026");
      expect(c, code).not.toBeNull();
      expect(c!.explanation, code).toMatch(/^[a-z]/);
      expect(c!.explanation.endsWith("."), code).toBe(false);
    }
  });

  it("matches form codes regardless of case and spacing", () => {
    expect(formCopy("  gstr-3b ")?.name).toBe("GSTR-3B");
    expect(formCopy("dir-3   kyc web")?.name).toBe("Director KYC");
  });

  it("income tax returns read as years, with what we usually need", () => {
    const d = explainDeadline({ formCode: "ITR", type: "itr", filingPeriod: "AY 2026-27", title: "Income tax return, non-audit (ITR-1 / ITR-2) for AY 2026-27" });
    expect(d.headline).toBe("Income tax return for AY 2026-27");
    expect(d.needs.some((n) => n.includes("Form 16"))).toBe(true);
  });

  it("falls back to the compliance type, then to the deadline's own title", () => {
    const byType = explainDeadline({ formCode: "GSTR-11", type: "gstr_1", filingPeriod: "Sep 2026", title: "GSTR-11 for Sep 2026" });
    expect(byType.name).toBe("GSTR-11");
    expect(byType.explanation).toBe("your GST return of sales");

    const custom = explainDeadline({ formCode: null, type: "custom", filingPeriod: "FY 2026-27", title: "Shops licence renewal for FY 2026-27" });
    expect(custom.name).toBe("Shops licence renewal");
    expect(custom.headline).toBe("Shops licence renewal for FY 2026-27");
    expect(custom.explanation).toBeNull();
    expect(custom.sentence).toBe("Shops licence renewal for FY 2026-27");

    expect(explainDeadline({ formCode: null, type: null, filingPeriod: null, title: null }).headline).toBe("Deadline");
  });
});

describe("deadlineStatus", () => {
  it("overdue wins while it isn't filed, and says what to do when we're waiting on the client", () => {
    expect(deadlineStatus("not_started", true)).toMatchObject({ label: "Overdue", tone: "danger" });
    expect(deadlineStatus("waiting_on_you", true).meaning).toMatch(/waiting for your documents/);
    expect(deadlineStatus("filed", true)).toMatchObject({ label: "Filed", tone: "success" });
    expect(deadlineStatus("cancelled", true)).toMatchObject({ label: "Cancelled", tone: "muted" });
  });

  it("uses the §3.6 labels", () => {
    expect(deadlineStatus("waiting_on_you", false)).toMatchObject({ label: "Documents awaited", tone: "warning" });
    expect(deadlineStatus("in_progress", false)).toMatchObject({ label: "In progress", tone: "info" });
    expect(deadlineStatus("not_started", false)).toMatchObject({ label: "Not started", tone: "muted" });
    expect(deadlineStatus(null, false).label).toBe("Not started");
  });

  it("recognises the progress values of the view", () => {
    expect(isDeadlineProgress("waiting_on_you")).toBe(true);
    expect(isDeadlineProgress("under_review")).toBe(false);
  });
});

describe("whatWeNeed (§7.22 Home)", () => {
  const formNeeds = ["Your sales invoices", "Your purchase invoices"];

  it("asks for nothing once filed, cancelled or in hand", () => {
    expect(whatWeNeed({ progress: "filed", formNeeds, openRequestItems: ["Bank statement"] }).kind).toBe("nothing");
    expect(whatWeNeed({ progress: "cancelled", formNeeds, openRequestItems: [] }).kind).toBe("nothing");
    const inHand = whatWeNeed({ progress: "in_progress", formNeeds, openRequestItems: ["Bank statement"] });
    expect(inHand).toMatchObject({ kind: "nothing" });
    expect(inHand.note).toMatch(/nothing for you to do/);
  });

  it("lists what the firm asked for first, up to five, de-duplicated", () => {
    const asked = ["Bank statement", "Bank statement", "Sales register", "Purchase register", "GSTR-2B", "Credit notes", "Expense bills"];
    const r = whatWeNeed({ progress: "waiting_on_you", formNeeds, openRequestItems: asked });
    expect(r.source).toBe("asked");
    expect(r.items).toEqual(["Bank statement", "Sales register", "Purchase register", "GSTR-2B", "Credit notes"]);
    expect(r.note).toBe("And 1 more we've asked for under Documents.");
  });

  it("otherwise says what that return usually needs", () => {
    expect(whatWeNeed({ progress: "not_started", formNeeds, openRequestItems: [] })).toMatchObject({ kind: "list", source: "usual", items: formNeeds });
    expect(whatWeNeed({ progress: "not_started", formNeeds: [], openRequestItems: [] })).toMatchObject({ kind: "nothing" });
  });
});

describe("invoices and payments in the client's words", () => {
  it("labels every portal display status", () => {
    for (const s of ["sent", "partially_paid", "paid", "overdue", "disputed", "waived", "cancelled"]) {
      expect(invoiceStatus(s).meaning.startsWith(`${invoiceStatus(s).label}:`), s).toBe(true);
    }
    expect(invoiceStatus("overdue").tone).toBe("danger");
    expect(invoiceStatus("disputed").tone).toBe("violet");
  });

  it("is payable only while issued, live and with something due", () => {
    expect(isPayable({ status: "sent", cancelledAt: null, outstandingPaise: 590000 })).toBe(true);
    expect(isPayable({ status: "partially_paid", cancelledAt: null, outstandingPaise: 1 })).toBe(true);
    expect(isPayable({ status: "disputed", cancelledAt: null, outstandingPaise: 100 })).toBe(true);
    expect(isPayable({ status: "paid", cancelledAt: null, outstandingPaise: 0 })).toBe(false);
    expect(isPayable({ status: "sent", cancelledAt: "2026-10-01T00:00:00Z", outstandingPaise: 100 })).toBe(false);
    expect(isPayable({ status: "sent", cancelledAt: null, outstandingPaise: 0 })).toBe(false);
    expect(isPayable({ status: "waived", cancelledAt: null, outstandingPaise: 100 })).toBe(false);
    expect(isPayable({ status: "sent", cancelledAt: null, outstandingPaise: 12.5 })).toBe(false);
  });

  it("a reported payment never reads as paid", () => {
    expect(claimStatus("pending")).toMatchObject({ label: "Payment reported", tone: "info" });
    expect(claimStatus("pending").meaning).toMatch(/changes to Paid when we record the receipt/);
    expect(claimStatus("verified").label).toBe("Confirmed");
    expect(claimStatus("rejected").label).toBe("Not matched");
  });

  it("the UPI note is the invoice number", () => {
    expect(paymentNote(" TW/26-27/0042 ")).toBe("TW/26-27/0042");
    expect(paymentNote(null)).toBeNull();
  });
});

describe("document requests", () => {
  it("explains each item status to the client", () => {
    expect(requestItemStatus("pending")).toMatchObject({ label: "Pending", tone: "warning" });
    expect(requestItemStatus("uploaded").meaning).toMatch(/replace it/);
    expect(requestItemStatus("accepted").tone).toBe("success");
    expect(requestItemStatus("rejected").meaning).toMatch(/upload it again/);
  });

  it("counts what is still to do: pending and rejected", () => {
    expect(outstandingItemCount([{ status: "pending" }, { status: "rejected" }, { status: "uploaded" }, { status: "accepted" }])).toBe(2);
  });
});

describe("firstName", () => {
  it("skips honorifics", () => {
    expect(firstName("CA Vinay Karlagere")).toBe("Vinay");
    expect(firstName("Anita Rao")).toBe("Anita");
    expect(firstName("  ")).toBeNull();
  });
});

describe("homeSummary", () => {
  it("lists what needs the client, in order", () => {
    expect(homeSummary({ overdue: 1, toUpload: 3, due: "₹11,800.00", unread: 2, next: null })).toBe(
      "1 deadline overdue · 3 documents to upload · ₹11,800.00 due · 2 new messages",
    );
    expect(homeSummary({ overdue: 0, toUpload: 1, due: null, unread: 1, next: null })).toBe("1 document to upload · 1 new message");
  });

  it("says when nothing needs them, with the next deadline", () => {
    expect(homeSummary({ overdue: 0, toUpload: 0, due: null, unread: 0, next: "GSTR-3B for October 2026, due 20 Nov 2026" })).toBe(
      "Nothing needs you right now. Next: GSTR-3B for October 2026, due 20 Nov 2026.",
    );
    expect(homeSummary({ overdue: 0, toUpload: 0, due: null, unread: 0, next: null })).toBe("Nothing needs you right now.");
  });
});

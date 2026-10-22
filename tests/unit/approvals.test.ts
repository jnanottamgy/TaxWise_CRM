import { describe, expect, it } from "vitest";
import {
  canApprove,
  canSendInvoice,
  canSendQuotation,
  initialInvoiceStatus,
  invoiceNeedsApproval,
  quotationNeedsApproval,
} from "@/lib/domain/approvals";
import { QUOTATION_STATUSES, type AppRole } from "@/lib/domain/enums";
import { invoiceTotals } from "@/lib/domain/gst";

const LAKH = 1_00_000_00; // ₹1,00,000 in paise

describe("invoiceNeedsApproval (§7.9.2)", () => {
  it("never gates a Partner's invoice", () => {
    expect(invoiceNeedsApproval("partner", 50 * LAKH, LAKH)).toBe(false);
    expect(invoiceNeedsApproval("partner", 50 * LAKH, 0)).toBe(false);
  });

  it("needs no approvals when the limit is null", () => {
    expect(invoiceNeedsApproval("manager", 50 * LAKH, null)).toBe(false);
  });

  it("gates a Manager's invoice whose total exceeds the limit (strictly)", () => {
    expect(invoiceNeedsApproval("manager", LAKH + 1, LAKH)).toBe(true);
    expect(invoiceNeedsApproval("manager", LAKH, LAKH)).toBe(false);
    expect(invoiceNeedsApproval("manager", LAKH - 1, LAKH)).toBe(false);
  });

  it("compares the total including GST", () => {
    // ₹90,000 fee + 18% GST = ₹1,06,200 > ₹1,00,000 limit, though the fee alone is under it.
    const t = invoiceTotals([{ quantity: 1, ratePaise: 90_000_00, taxRate: 18 }], "29", "29", { roundOff: false });
    expect(t.totalPaise).toBe(1_06_200_00);
    expect(invoiceNeedsApproval("manager", t.taxablePaise, LAKH)).toBe(false);
    expect(invoiceNeedsApproval("manager", t.totalPaise, LAKH)).toBe(true);
  });

  it("with a limit of 0, gates every Manager invoice with a value", () => {
    expect(invoiceNeedsApproval("manager", 1, 0)).toBe(true);
    expect(invoiceNeedsApproval("manager", 0, 0)).toBe(false);
  });

  it("holds anything raised by a role that can't raise invoices", () => {
    for (const role of ["employee", "client"] as AppRole[]) expect(invoiceNeedsApproval(role, 1, null)).toBe(true);
  });

  it("saves gated invoices as Awaiting approval, others as Draft", () => {
    expect(initialInvoiceStatus(true)).toBe("awaiting_approval");
    expect(initialInvoiceStatus(false)).toBe("draft");
  });
});

describe("the invoice gate is frozen at creation (§7.9.2)", () => {
  it("sending follows the stored requires_approval, not today's limit", () => {
    // Created under a ₹1 lakh limit and gated; the limit is later raised, but the gate stays.
    const requiresApproval = invoiceNeedsApproval("manager", 2 * LAKH, LAKH);
    expect(requiresApproval).toBe(true);
    expect(invoiceNeedsApproval("manager", 2 * LAKH, 5 * LAKH)).toBe(false); // a fresh check would release it…
    expect(canSendInvoice({ status: "draft", requiresApproval, approvedAt: null }).ok).toBe(false); // …but it stays held
    expect(canSendInvoice({ status: "draft", requiresApproval, approvedAt: "2026-10-22T10:00:00+05:30" }).ok).toBe(true);
    // And an invoice created ungated is not re-gated when the limit drops.
    expect(canSendInvoice({ status: "draft", requiresApproval: false, approvedAt: null }).ok).toBe(true);
  });
});

describe("canSendInvoice (§7.9.2, §7.9.3)", () => {
  it("refuses an invoice awaiting approval", () => {
    const r = canSendInvoice({ status: "awaiting_approval", requiresApproval: true, approvedAt: null });
    expect(r).toEqual({ ok: false, error: "This invoice is over the approval limit and waits for a Partner's approval before it can be sent." });
  });

  it("allows Draft (issue) and resending Sent / Partially paid", () => {
    expect(canSendInvoice({ status: "draft", requiresApproval: false, approvedAt: null })).toEqual({ ok: true });
    expect(canSendInvoice({ status: "sent", requiresApproval: false, approvedAt: null })).toEqual({ ok: true });
    expect(canSendInvoice({ status: "partially_paid", requiresApproval: true, approvedAt: "2026-10-01T00:00:00Z" })).toEqual({ ok: true });
  });

  it("refuses Paid, Waived and Disputed invoices", () => {
    expect(canSendInvoice({ status: "paid", requiresApproval: false, approvedAt: null }).ok).toBe(false);
    expect(canSendInvoice({ status: "waived", requiresApproval: false, approvedAt: null }).ok).toBe(false);
    expect(canSendInvoice({ status: "disputed", requiresApproval: false, approvedAt: null }).ok).toBe(false);
  });
});

describe("quotationNeedsApproval (§7.5.2, §5.2)", () => {
  it("lets Partners' own quotations skip approval", () => {
    expect(quotationNeedsApproval("partner", 100 * LAKH, null)).toBe(false);
    expect(quotationNeedsApproval("partner", 100 * LAKH, LAKH)).toBe(false);
  });

  it("with a null limit, Managers' quotations always need approval", () => {
    expect(quotationNeedsApproval("manager", 0, null)).toBe(true);
    expect(quotationNeedsApproval("manager", 1, null)).toBe(true);
  });

  it("with a limit of 0, Managers' quotations never need approval", () => {
    expect(quotationNeedsApproval("manager", 0, 0)).toBe(false);
    expect(quotationNeedsApproval("manager", 1_000 * LAKH, 0)).toBe(false);
  });

  it("otherwise, only above the limit", () => {
    expect(quotationNeedsApproval("manager", LAKH + 1, LAKH)).toBe(true);
    expect(quotationNeedsApproval("manager", LAKH, LAKH)).toBe(false);
    expect(quotationNeedsApproval("manager", 1, LAKH)).toBe(false);
  });

  it("holds anything from a role that can't create quotations", () => {
    expect(quotationNeedsApproval("employee", 1, 0)).toBe(true);
    expect(quotationNeedsApproval("client", 1, 0)).toBe(true);
  });
});

describe("canApprove (§4.1)", () => {
  it("is Partner only", () => {
    expect((["partner", "manager", "employee", "client"] as AppRole[]).filter(canApprove)).toEqual(["partner"]);
  });
});

describe("canSendQuotation (§4.1, §7.5.2, §7.5.3)", () => {
  it("answers for every quotation status", () => {
    const answers = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, canSendQuotation({ status: s, needsApproval: false }).ok]));
    expect(answers).toEqual({
      draft: true,
      pending_approval: false,
      approved: true,
      sent: true,
      viewed: true,
      accepted: false,
      rejected: false,
      expired: false,
      superseded: false,
    });
  });

  it("holds a Manager's draft over the limit until a Partner approves it", () => {
    const held = canSendQuotation({ status: "draft", needsApproval: true });
    expect(held).toEqual({ ok: false, error: "This quotation is over the quotation approval limit. Submit it for a Partner's approval first." });
    expect(canSendQuotation({ status: "approved", needsApproval: true })).toEqual({ ok: true });
    const superseded = canSendQuotation({ status: "superseded", needsApproval: false });
    if (!superseded.ok) expect(superseded.error).toBe("This quotation is superseded. Revise it to send a new version.");
  });
});

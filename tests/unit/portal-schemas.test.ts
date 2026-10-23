import { describe, expect, it } from "vitest";
import { addDays, todayIST } from "@/lib/domain/fy";
import { AcknowledgeNoticeSchema, CONSENT_PURPOSE_KEYS, MarkReadSchema, PaymentClaimSchema, PortalMessageSchema, resolveFy } from "@/lib/schemas/portal";

const INVOICE = "5f0e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("PaymentClaimSchema (§7.22 I've paid)", () => {
  it("needs a reference and a date that isn't in the future", () => {
    const today = todayIST();
    expect(PaymentClaimSchema.safeParse({ invoiceId: INVOICE, reference: "UTR412345678901", paidOn: today }).success).toBe(true);
    const future = PaymentClaimSchema.safeParse({ invoiceId: INVOICE, reference: "UTR1", paidOn: addDays(today, 1) });
    expect(future.success).toBe(false);
    expect(future.error?.issues[0]?.path).toEqual(["paidOn"]);
    expect(PaymentClaimSchema.safeParse({ invoiceId: INVOICE, reference: "   ", paidOn: today }).success).toBe(false);
    expect(PaymentClaimSchema.safeParse({ invoiceId: INVOICE, reference: "UTR1", paidOn: "22/10/2026" }).success).toBe(false);
    expect(PaymentClaimSchema.safeParse({ invoiceId: INVOICE, reference: "x".repeat(101), paidOn: today }).success).toBe(false);
  });

  it("treats an empty note and upload as none", () => {
    const r = PaymentClaimSchema.parse({ invoiceId: INVOICE, reference: " UTR1 ", paidOn: todayIST(), note: "", uploadId: "" });
    expect(r).toMatchObject({ reference: "UTR1", note: null, uploadId: null });
  });
});

describe("PortalMessageSchema", () => {
  it("needs words and allows at most five attachments", () => {
    expect(PortalMessageSchema.safeParse({ body: "  " }).success).toBe(false);
    expect(PortalMessageSchema.parse({ body: " Hello " })).toEqual({ body: "Hello", uploadIds: [] });
    expect(PortalMessageSchema.safeParse({ body: "Files", uploadIds: Array.from({ length: 6 }, () => INVOICE) }).success).toBe(false);
    expect(PortalMessageSchema.safeParse({ body: "x".repeat(5001) }).success).toBe(false);
  });
});

describe("AcknowledgeNoticeSchema", () => {
  it("needs the box ticked and the version shown", () => {
    expect(AcknowledgeNoticeSchema.safeParse({ noticeVersion: "v1", accepted: true }).success).toBe(true);
    expect(AcknowledgeNoticeSchema.safeParse({ noticeVersion: "v1", accepted: false }).success).toBe(false);
    expect(AcknowledgeNoticeSchema.safeParse({ noticeVersion: "", accepted: true }).success).toBe(false);
  });

  it("records every purpose the notice explains", () => {
    expect(CONSENT_PURPOSE_KEYS).toEqual(["service_delivery", "statutory_filings", "legal_obligations", "reminders_and_billing", "security"]);
  });
});

describe("MarkReadSchema and resolveFy", () => {
  it("an empty list means every unread message", () => {
    expect(MarkReadSchema.parse({})).toEqual({ messageIds: null });
    expect(MarkReadSchema.parse({ messageIds: [] })).toEqual({ messageIds: null });
  });

  it("keeps a valid FY and falls back otherwise", () => {
    expect(resolveFy("2025-26", "2026-27")).toBe("2025-26");
    expect(resolveFy("2025-27", "2026-27")).toBe("2026-27");
    expect(resolveFy(null, "2026-27")).toBe("2026-27");
  });
});

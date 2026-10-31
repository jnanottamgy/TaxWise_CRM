import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/notify", () => ({ notify: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getSession: vi.fn(async () => ({ status: "anonymous" })) }));

import { scrubMoneyMetadata } from "@/server/activity";
import { defaultFirmProfile, displayWebsite, formatFirmAddress, toFirmProfile } from "@/server/firm";

describe("history never carries fees for non-money events (§4.1)", () => {
  it("drops money-named keys, nested too, and reports them", () => {
    const { metadata, dropped } = scrubMoneyMetadata(
      { status: "filed", agreed_fee: 5000, amount: 1, details: { total_amount: 2, arn: "AA29" }, lines: [{ rate: 18, title: "x" }], tds: 3 },
      false,
    );
    expect(metadata).toEqual({ status: "filed", details: { arn: "AA29" }, lines: [{ title: "x" }] });
    expect(dropped.sort()).toEqual(["agreed_fee", "amount", "details.total_amount", "lines[0].rate", "tds"]);
  });

  it("keeps everything for money-side events, and null stays null", () => {
    expect(scrubMoneyMetadata({ amount: 5900 }, true)).toEqual({ metadata: { amount: 5900 }, dropped: [] });
    expect(scrubMoneyMetadata(null, false)).toEqual({ metadata: null, dropped: [] });
  });
});

describe("the firm as documents show it (§1, §4.6)", () => {
  it("shapes the public profile, with bank and UPI only when filled in", () => {
    const row = {
      firm_name: "TaxWise Consultants",
      legal_name: null,
      tagline: "Chartered Accountants · Bengaluru",
      address: "307, 14th Main Rd",
      city: "Bengaluru",
      state_code: "29",
      pincode: "560080",
      phone: "+91 97405 40239",
      email: "info@twchartered.com",
      website: "https://www.twchartered.com/",
      gstin: "29AAXFT1811B1Z3",
      logo_path: null,
      logo_updated_at: null,
      bank_name: " ",
      bank_account_name: null,
      bank_account_number: null,
      bank_ifsc: null,
      bank_branch: null,
      upi_id: "taxwise@hdfcbank",
      upi_payee_name: null,
    };
    const p = toFirmProfile(row, null);
    expect(p).toMatchObject({ stateName: "Karnataka", bank: null, upi: { id: "taxwise@hdfcbank", payeeName: "TaxWise Consultants" } });
    expect(formatFirmAddress(p)).toBe("307, 14th Main Rd, Bengaluru, Karnataka 560080");
    expect(toFirmProfile({ ...row, bank_ifsc: "HDFC0001234", upi_id: null }, null)).toMatchObject({ bank: { ifsc: "HDFC0001234", name: null }, upi: null });
  });

  it("falls back to the §1 identity", () => {
    expect(defaultFirmProfile()).toMatchObject({ firmName: "TaxWise Consultants", gstin: "29AAXFT1811B1Z3", stateName: "Karnataka" });
    expect(displayWebsite("https://www.twchartered.com/")).toBe("www.twchartered.com");
    expect(displayWebsite("  ")).toBeNull();
  });
});

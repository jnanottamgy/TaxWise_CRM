import { describe, expect, it } from "vitest";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import {
  expectedTds,
  isTdsNature,
  outstandingAmount,
  RECORD_ADVANCE_SEPARATELY,
  settlementFrom,
  suggestReceiptTds,
  TDS_BASE_PARAM_KEY,
  TDS_DEFAULTS,
  TDS_NATURES,
  TDS_PARAM_KEYS,
  TDS_SEED_PARAMETERS,
  tdsBase,
  tdsDifference,
  tdsRuleFor,
  tdsRuleLabel,
  tdsRulesOn,
  tdsThresholdExceeded,
  validateReceipt,
} from "@/lib/domain/tds";

const R = (rupees: number) => Math.round(rupees * 100); // test helper: whole-rupee figures to paise

// -------------------------------------------------------------------------------------------------
// Rates and thresholds by payment date (§6.5)
// -------------------------------------------------------------------------------------------------

describe("TDS parameter keys (§5.12)", () => {
  it("uses the spec's key shape, e.g. tds.professional_fees.rate", () => {
    expect(TDS_PARAM_KEYS.professional).toEqual({ rate: "tds.professional_fees.rate", threshold: "tds.professional_fees.threshold" });
    expect(TDS_BASE_PARAM_KEY).toBe("tds.base_excludes_gst");
    expect(TDS_NATURES).toEqual([
      "professional",
      "technical",
      "commission",
      "rent_land_building",
      "rent_plant_machinery",
      "contract_individual_huf",
      "contract_others",
    ]);
    expect(isTdsNature("professional")).toBe(true);
    expect(isTdsNature("salary")).toBe(false);
  });
});

describe("tdsRuleFor (§6.5: 1961 Act up to 31 Mar 2026, s.393 from 1 Apr 2026)", () => {
  it("professional fees: 194J 10% above ₹50,000 a year until 31 Mar 2026", () => {
    const r = tdsRuleFor("professional", "2026-03-31");
    expect(r).toEqual({
      nature: "professional",
      label: "Fees for professional services",
      section: "194J",
      statute: "Income-tax Act, 1961",
      ratePercent: 10,
      threshold: { amountPaise: R(50_000), per: "year", annualPaise: null },
      verified: true,
      sourceRef: "Income-tax Act, 1961",
    });
  });

  it("professional fees: s.393 10% above ₹50,000 from 1 Apr 2026, awaiting partner confirmation", () => {
    const r = tdsRuleFor("professional", "2026-04-01");
    expect(r).toMatchObject({ section: "393", statute: "Income-tax Act, 2025", ratePercent: 10, verified: false });
    expect(r?.threshold).toEqual({ amountPaise: R(50_000), per: "year", annualPaise: null });
  });

  it("technical services: 2% under both Acts", () => {
    expect(tdsRuleFor("technical", "2025-12-01")).toMatchObject({ section: "194J", ratePercent: 2, verified: true });
    expect(tdsRuleFor("technical", "2026-10-22")).toMatchObject({ section: "393", ratePercent: 2, verified: false });
  });

  it("commission: 194H 2% from 1 Oct 2024, threshold ₹15,000 then ₹20,000 from 1 Apr 2025", () => {
    expect(tdsRuleFor("commission", "2024-09-30")).toBeNull(); // the 5% era isn't seeded
    expect(tdsRuleFor("commission", "2024-10-01")).toMatchObject({ section: "194H", ratePercent: 2 });
    expect(tdsRuleFor("commission", "2025-03-31")?.threshold?.amountPaise).toBe(R(15_000));
    expect(tdsRuleFor("commission", "2025-04-01")?.threshold?.amountPaise).toBe(R(20_000));
    expect(tdsRuleFor("commission", "2026-04-01")).toMatchObject({ section: "393", ratePercent: 2, threshold: { amountPaise: R(20_000) } });
  });

  it("rent: 10% land/building, 2% plant/machinery, above ₹50,000 a month", () => {
    expect(tdsRuleFor("rent_land_building", "2025-06-01")).toMatchObject({
      section: "194I",
      ratePercent: 10,
      threshold: { amountPaise: R(50_000), per: "month" },
    });
    expect(tdsRuleFor("rent_plant_machinery", "2025-06-01")).toMatchObject({ section: "194I", ratePercent: 2 });
    expect(tdsRuleFor("rent_land_building", "2026-06-01")).toMatchObject({ section: "393", ratePercent: 10, threshold: { per: "month" } });
    expect(tdsRuleFor("rent_plant_machinery", "2026-06-01")).toMatchObject({ section: "393", ratePercent: 2 });
  });

  it("contract work: 1% individuals/HUF, 2% others", () => {
    const ind = tdsRuleFor("contract_individual_huf", "2025-06-01");
    expect(ind).toMatchObject({ section: "194C", ratePercent: 1 });
    expect(ind?.threshold).toEqual({ amountPaise: R(30_000), per: "payment", annualPaise: R(1_00_000) });
    expect(tdsRuleFor("contract_others", "2025-06-01")).toMatchObject({ section: "194C", ratePercent: 2 });
    expect(tdsRuleFor("contract_individual_huf", "2026-06-01")).toMatchObject({ section: "393", ratePercent: 1 });
    expect(tdsRuleFor("contract_others", "2026-06-01")).toMatchObject({ section: "393", ratePercent: 2 });
  });

  it("covers every nature on both sides of the switch, with no gap or overlap", () => {
    for (const nature of TDS_NATURES) {
      const old = tdsRuleFor(nature, "2026-03-31");
      const next = tdsRuleFor(nature, "2026-04-01");
      expect(old?.statute).toBe("Income-tax Act, 1961");
      expect(old?.verified).toBe(true);
      expect(old?.threshold).not.toBeNull();
      expect(next?.statute).toBe("Income-tax Act, 2025");
      expect(next?.section).toBe("393");
      expect(next?.verified).toBe(false);
      expect(next?.threshold).not.toBeNull();
      expect(next?.ratePercent).toBe(old?.ratePercent);
    }
    for (const row of TDS_SEED_PARAMETERS) {
      if (row.statute === "Income-tax Act, 2025") expect([row.effectiveFrom, row.effectiveTo, row.verified]).toEqual(["2026-04-01", null, false]);
      else if (row.key === "tds.commission.threshold" && row.effectiveFrom === "2024-10-01") expect(row.effectiveTo).toBe("2025-03-31");
      else if (row.key !== TDS_BASE_PARAM_KEY) expect(row.effectiveTo).toBe("2026-03-31");
    }
  });

  it("starts the 1961 rows on 1 Apr 2025 (1 Oct 2024 for 194H)", () => {
    const starts = new Set(TDS_SEED_PARAMETERS.filter((r) => r.statute === "Income-tax Act, 1961" && r.key !== TDS_BASE_PARAM_KEY).map((r) => `${r.key.split(".")[1]}:${r.effectiveFrom}`));
    expect(starts.has("professional_fees:2025-04-01")).toBe(true);
    expect(starts.has("commission:2024-10-01")).toBe(true);
    expect(tdsRuleFor("professional", "2025-03-31")).toBeNull();
  });

  it("reads Partner-edited rows, a missing threshold, and a rate without a section", () => {
    const rows: StatutoryParameterRow[] = [
      { key: "tds.professional_fees.rate", value: { rate: 7.5, section: "194J" }, effectiveFrom: "2026-04-01", verified: true },
      { key: "tds.technical_services.rate", value: 2, effectiveFrom: "2026-04-01" },
      { key: "tds.technical_services.threshold", value: { amount: "30000" }, effectiveFrom: "2026-04-01", verified: false },
    ];
    expect(tdsRuleFor("professional", "2026-10-22", rows)).toMatchObject({ ratePercent: 7.5, threshold: null, verified: true });
    expect(tdsRuleFor("technical", "2026-10-22", rows)).toMatchObject({
      section: "OTHER",
      threshold: { amountPaise: R(30_000), per: "year", annualPaise: null },
      verified: false,
    });
    expect(tdsRuleFor("commission", "2026-10-22", rows)).toBeNull();
  });

  it("lists every nature for the receipt form", () => {
    const rules = tdsRulesOn("2026-10-22");
    expect(rules.map((r) => r.nature)).toEqual([...TDS_NATURES]);
    expect(tdsRuleLabel(rules[0])).toBe("s.393 · Fees for professional services · 10%");
    expect(tdsRuleLabel(tdsRulesOn("2025-10-22")[0])).toBe("194J · Fees for professional services · 10%");
    expect(tdsRulesOn("2020-01-01")).toEqual([]);
  });
});

describe("tdsThresholdExceeded (§6.5: deduct only above the threshold)", () => {
  const yearly = tdsRuleFor("professional", "2026-10-22")?.threshold ?? null;
  const monthly = tdsRuleFor("rent_land_building", "2026-10-22")?.threshold ?? null;
  const contract = tdsRuleFor("contract_others", "2026-10-22")?.threshold ?? null;

  it("compares the FY's payments with an annual threshold (strictly above)", () => {
    expect(tdsThresholdExceeded(yearly, { paymentPaise: R(50_000) })).toBe(false);
    expect(tdsThresholdExceeded(yearly, { paymentPaise: R(50_000) + 1 })).toBe(true);
    expect(tdsThresholdExceeded(yearly, { paymentPaise: R(20_000), fyTotalPaise: R(60_000) })).toBe(true);
    expect(tdsThresholdExceeded(yearly, { paymentPaise: R(20_000), fyTotalPaise: R(45_000) })).toBe(false);
  });

  it("compares a month's rent with a monthly threshold", () => {
    expect(tdsThresholdExceeded(monthly, { paymentPaise: R(50_000) })).toBe(false);
    expect(tdsThresholdExceeded(monthly, { paymentPaise: R(10_000), monthPaise: R(55_000) })).toBe(true);
  });

  it("applies a contract's single-payment and FY-aggregate limits", () => {
    expect(tdsThresholdExceeded(contract, { paymentPaise: R(30_000) })).toBe(false);
    expect(tdsThresholdExceeded(contract, { paymentPaise: R(30_001) })).toBe(true);
    expect(tdsThresholdExceeded(contract, { paymentPaise: R(25_000), fyTotalPaise: R(1_00_000) })).toBe(false);
    expect(tdsThresholdExceeded(contract, { paymentPaise: R(25_000), fyTotalPaise: R(1_00_001) })).toBe(true);
  });

  it("with no threshold, any amount is subject to TDS", () => {
    expect(tdsThresholdExceeded(null, { paymentPaise: 1 })).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// Expected TDS (§6.5, Circular 23/2017)
// -------------------------------------------------------------------------------------------------

describe("tdsBase and expectedTds (§6.5, CBDT Circular 23/2017)", () => {
  it("computes on the fee excluding GST shown separately", () => {
    // ₹1,00,000 fee + ₹18,000 GST: TDS @10% is ₹10,000, not ₹11,800.
    const invoice = { taxablePaise: R(1_00_000), gstPaise: R(18_000) };
    expect(tdsBase(invoice)).toBe(R(1_00_000));
    expect(expectedTds(tdsBase(invoice), 10)).toBe(R(10_000));
  });

  it("includes GST when it isn't shown separately, or when the parameter says so", () => {
    const invoice = { taxablePaise: R(1_00_000), gstPaise: R(18_000) };
    expect(tdsBase(invoice, { gstShownSeparately: false })).toBe(R(1_18_000));
    expect(tdsBase(invoice, { baseExcludesGst: false })).toBe(R(1_18_000));
    expect(TDS_DEFAULTS.baseExcludesGst).toBe(true);
    expect(TDS_SEED_PARAMETERS.find((r) => r.key === TDS_BASE_PARAM_KEY)?.value).toBe(true);
  });

  it("rounds half-up to the paisa, or to whole rupees when asked", () => {
    expect(expectedTds(12_345, 10)).toBe(1_235); // 1234.5 → 1235
    expect(expectedTds(100_050, 2)).toBe(2_001);
    expect(expectedTds(R(12_345.67), "10.00")).toBe(R(1_234.57));
    expect(expectedTds(R(12_345.67), 10, { roundToRupee: true })).toBe(R(1_235));
    // Rounded once: ₹1,234.499 → ₹1,234 (rounding to paise first would give ₹1,234.50 → ₹1,235).
    expect(expectedTds(R(12_344.99), 10, { roundToRupee: true })).toBe(R(1_234));
    expect(expectedTds(R(12_345), 10, { roundToRupee: true })).toBe(R(1_235)); // ₹1,234.50 → ₹1,235
    expect(expectedTds(R(1_000), 7.5, { roundToRupee: true })).toBe(R(75));
    expect(expectedTds(R(1_010), "7.5", { roundToRupee: true })).toBe(R(76)); // ₹75.75 → ₹76
    expect(expectedTds(R(500), 100, { roundToRupee: true })).toBe(R(500));
    expect(expectedTds(R(1_234), 0.5, { roundToRupee: true })).toBe(R(6)); // ₹6.17 → ₹6
    expect(expectedTds(0, 10)).toBe(0);
    expect(() => expectedTds(-1, 10)).toThrow(RangeError);
  });

  it("suggests the TDS still expected on a receipt", () => {
    expect(suggestReceiptTds({ taxablePaise: R(1_00_000), ratePercent: 10 })).toBe(R(10_000));
    expect(suggestReceiptTds({ taxablePaise: R(1_00_000), ratePercent: 10, tdsAlreadyPaise: R(4_000) })).toBe(R(6_000));
    expect(suggestReceiptTds({ taxablePaise: R(1_00_000), ratePercent: 10, tdsAlreadyPaise: R(12_000) })).toBe(0);
  });

  it("shows the difference between expected and actual TDS", () => {
    expect(tdsDifference(R(10_000), R(10_000))).toEqual({ differencePaise: 0, kind: "matches", message: null });
    expect(tdsDifference(R(10_000), R(9_000))).toEqual({
      differencePaise: -R(1_000),
      kind: "short",
      message: "The client deducted ₹1,000.00 less TDS than expected (₹10,000.00).",
    });
    expect(tdsDifference(R(2_000), R(10_000))).toEqual({
      differencePaise: R(8_000),
      kind: "excess",
      message: "The client deducted ₹8,000.00 more TDS than expected (₹2,000.00).",
    });
    expect(tdsDifference(123_450, 123_500).kind).toBe("excess");
  });
});

// -------------------------------------------------------------------------------------------------
// Settlement (§6.5, §7.9.4)
// -------------------------------------------------------------------------------------------------

describe("outstandingAmount and settlementFrom (§6.5)", () => {
  it("is total − received − TDS − credit noted", () => {
    expect(outstandingAmount({ totalPaise: R(1_18_000), receivedPaise: R(1_00_000), tdsPaise: R(10_000), creditNotedPaise: R(5_000) })).toBe(R(3_000));
    expect(outstandingAmount({ totalPaise: R(1_18_000), receivedPaise: R(1_08_000), tdsPaise: R(10_000), creditNotedPaise: 0 })).toBe(0);
    expect(outstandingAmount({ totalPaise: R(100), receivedPaise: R(101), tdsPaise: 0, creditNotedPaise: 0 })).toBe(-R(1));
  });

  it("sums receipts and credit notes, ignoring reversed receipts", () => {
    const s = settlementFrom(
      R(1_18_000),
      [
        { amountReceivedPaise: R(50_000), tdsPaise: R(5_000) },
        { amountReceivedPaise: R(40_000), tdsPaise: 0, reversed: true }, // bounced cheque
        { amountReceivedPaise: 0, tdsPaise: R(5_000) }, // settled by TDS alone
      ],
      [{ totalPaise: R(11_800) }],
    );
    expect(s).toEqual({
      totalPaise: R(1_18_000),
      receivedPaise: R(50_000),
      tdsPaise: R(10_000),
      creditNotedPaise: R(11_800),
      outstandingPaise: R(46_200),
    });
    expect(settlementFrom(R(500), [])).toMatchObject({ receivedPaise: 0, tdsPaise: 0, creditNotedPaise: 0, outstandingPaise: R(500) });
  });
});

describe("validateReceipt (§7.9.4: received + TDS ≤ outstanding + ₹1)", () => {
  const outstanding = R(1_18_000);

  it("accepts a full, a partial and a TDS-only settlement", () => {
    expect(validateReceipt({ amountReceivedPaise: R(1_08_000), tdsPaise: R(10_000), outstandingPaise: outstanding })).toEqual({ ok: true });
    expect(validateReceipt({ amountReceivedPaise: R(50_000), tdsPaise: 0, outstandingPaise: outstanding })).toEqual({ ok: true });
    expect(validateReceipt({ amountReceivedPaise: 0, tdsPaise: R(10_000), outstandingPaise: outstanding })).toEqual({ ok: true });
  });

  it("allows up to ₹1 over the outstanding amount", () => {
    expect(validateReceipt({ amountReceivedPaise: outstanding + 100, tdsPaise: 0, outstandingPaise: outstanding })).toEqual({ ok: true });
  });

  it("refuses anything more, with the record-the-advance guidance", () => {
    const r = validateReceipt({ amountReceivedPaise: outstanding + 101, tdsPaise: 0, outstandingPaise: outstanding });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(`₹1,18,001.01 received and deducted is more than the ₹1,18,000.00 outstanding. ${RECORD_ADVANCE_SEPARATELY}`);
      expect(r.fieldErrors.amount_received).toEqual([r.error]);
      expect(r.error).toContain("record the advance separately");
    }
    const split = validateReceipt({ amountReceivedPaise: R(1_10_000), tdsPaise: R(10_000), outstandingPaise: outstanding });
    expect(split.ok).toBe(false);
  });

  it("refuses a receipt on an invoice with nothing outstanding", () => {
    const r = validateReceipt({ amountReceivedPaise: R(500), tdsPaise: 0, outstandingPaise: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`Nothing is outstanding on this invoice. ${RECORD_ADVANCE_SEPARATELY}`);
  });

  it("refuses negative amounts and an empty receipt", () => {
    const neg = validateReceipt({ amountReceivedPaise: -1, tdsPaise: -1, outstandingPaise: outstanding });
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(Object.keys(neg.fieldErrors).sort()).toEqual(["amount_received", "tds_amount"]);
    const empty = validateReceipt({ amountReceivedPaise: 0, tdsPaise: 0, outstandingPaise: outstanding });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe("Enter the amount received, the TDS deducted, or both.");
    expect(validateReceipt({ amountReceivedPaise: 1.5, tdsPaise: 0, outstandingPaise: outstanding }).ok).toBe(false);
  });

  it("takes the tolerance as a parameter", () => {
    expect(validateReceipt({ amountReceivedPaise: outstanding + 1, tdsPaise: 0, outstandingPaise: outstanding }, { tolerancePaise: 0 }).ok).toBe(false);
    expect(TDS_DEFAULTS.receiptTolerancePaise).toBe(100);
  });
});

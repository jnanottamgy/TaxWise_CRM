import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPlaceOfSupplyOverride,
  checkCreditNote,
  checkSacCode,
  computeLine,
  creditNoteAmounts,
  creditNoteDeadline,
  eInvoiceReportingDays,
  eInvoicingApplies,
  GST_DEFAULTS,
  GST_PARAM_KEYS,
  GST_SEED_PARAMETERS,
  invoiceTotals,
  isIntraState,
  MISSING_RECIPIENT_GSTIN_MESSAGE,
  needsB2cAddress,
  parameterInForce,
  placeOfSupply,
  rateOptions,
  readParameterNumber,
  reimbursementDescription,
  resolveGstParams,
  rule47Warning,
  sacDigitsRequired,
  sacFor,
  splitTax,
  validateCreditNoteTaxable,
  validateRule46,
  validateTaxRate,
  type GstParams,
  type SeedParameterRow,
  type StatutoryParameterRow,
} from "@/lib/domain/gst";
import { TDS_SEED_PARAMETERS } from "@/lib/domain/tds";

const TAXWISE_GSTIN = "29AAXFT1811B1Z3"; // Karnataka (§6.2)
const MH_GSTIN = "27AAPFU0939F1ZV"; // Maharashtra
const KA_GSTIN = "29ABCDE1234F1ZW"; // Karnataka
const TN_GSTIN = "33AAACT2727Q1Z3"; // Tamil Nadu

const CRORE = 1_00_00_000_00; // ₹1 crore in paise
const RUPEE = 100;

// -------------------------------------------------------------------------------------------------
// Parameters (§5.12)
// -------------------------------------------------------------------------------------------------

describe("parameterInForce (§5.12: the row in force on the date wins)", () => {
  const rows: StatutoryParameterRow[] = [
    { key: "k", value: 1, effectiveFrom: "2024-04-01", effectiveTo: "2025-03-31" },
    { key: "k", value: 2, effectiveFrom: "2025-04-01", effectiveTo: null },
    { key: "k", value: 3, effectiveFrom: "2025-10-01" }, // overlaps the open-ended row: later start wins
    { key: "other", value: 9, effectiveFrom: "2000-01-01" },
  ];

  it("includes both boundary dates", () => {
    expect(parameterInForce(rows, "k", "2024-04-01")?.value).toBe(1);
    expect(parameterInForce(rows, "k", "2025-03-31")?.value).toBe(1);
    expect(parameterInForce(rows, "k", "2025-04-01")?.value).toBe(2);
  });

  it("prefers the latest effective_from among rows in force", () => {
    expect(parameterInForce(rows, "k", "2025-09-30")?.value).toBe(2);
    expect(parameterInForce(rows, "k", "2025-10-01")?.value).toBe(3);
    expect(parameterInForce(rows, "k", "2030-01-01")?.value).toBe(3);
  });

  it("returns null before the first row and for unknown keys", () => {
    expect(parameterInForce(rows, "k", "2024-03-31")).toBeNull();
    expect(parameterInForce(rows, "missing", "2026-01-01")).toBeNull();
  });
});

describe("readParameterNumber (same reading as SQL jsonb_to_numeric)", () => {
  it("reads numbers, numeric strings and the known object keys", () => {
    expect(readParameterNumber(18)).toBe(18);
    expect(readParameterNumber("18")).toBe(18);
    expect(readParameterNumber(" 2.5 ")).toBe(2.5);
    expect(readParameterNumber({ value: 60 })).toBe(60);
    expect(readParameterNumber({ limit: 20 })).toBe(20);
    expect(readParameterNumber({ rate: 10, section: "194J" })).toBe(10);
    expect(readParameterNumber({ amount: 50000, per: "year" })).toBe(50000);
    expect(readParameterNumber({ max: 7 })).toBe(7);
  });

  it("returns null for anything else", () => {
    expect(readParameterNumber(null)).toBeNull();
    expect(readParameterNumber("18%")).toBeNull();
    expect(readParameterNumber([18])).toBeNull();
    expect(readParameterNumber({ other: 1 })).toBeNull();
    expect(readParameterNumber(Number.NaN)).toBeNull();
    expect(readParameterNumber(true)).toBeNull();
  });
});

describe("resolveGstParams", () => {
  it("resolves the seed rows to exactly GST_DEFAULTS today, flagging the [verify] rows", () => {
    const r = resolveGstParams(GST_SEED_PARAMETERS, "2026-10-22");
    expect(r.params).toEqual(GST_DEFAULTS);
    expect(r.missing).toEqual([]);
    expect(r.unverified.sort()).toEqual(
      [GST_PARAM_KEYS.defaultRateServices, GST_PARAM_KEYS.sacByService, GST_PARAM_KEYS.b2cAddressThreshold].sort(),
    );
  });

  it("uses the 0/5/12/18/28 slabs before 22 Sep 2025 and 0/5/18/40 from that day", () => {
    expect(resolveGstParams(GST_SEED_PARAMETERS, "2025-09-21").params.slabs).toEqual([0, 5, 12, 18, 28]);
    expect(resolveGstParams(GST_SEED_PARAMETERS, "2025-09-22").params.slabs).toEqual([0, 5, 18, 40]);
    expect(resolveGstParams(GST_SEED_PARAMETERS, "2025-09-21").params.defaultRateServices).toBe(18);
  });

  it("falls back to GST_DEFAULTS and lists every key as missing when there are no rows", () => {
    const r = resolveGstParams([], "2026-10-22");
    expect(r.params).toEqual(GST_DEFAULTS);
    expect(r.missing.sort()).toEqual(Object.values(GST_PARAM_KEYS).sort());
  });

  it("reads Partner-edited values (rupees → paise) and an unreadable value counts as missing", () => {
    const rows: StatutoryParameterRow[] = [
      { key: GST_PARAM_KEYS.defaultRateServices, value: "12", effectiveFrom: "2026-01-01", verified: true },
      { key: GST_PARAM_KEYS.b2cAddressThreshold, value: { amount: 25000, inclusive: true }, effectiveFrom: "2026-01-01", verified: true },
      { key: GST_PARAM_KEYS.eInvoicingThreshold, value: { amount: "oops" }, effectiveFrom: "2026-01-01", verified: true },
      { key: GST_PARAM_KEYS.sacByService, value: { default: "9983", byService: { gst: "998231" } }, effectiveFrom: "2026-01-01" },
    ];
    const r = resolveGstParams(rows, "2026-10-22");
    expect(r.params.defaultRateServices).toBe(12);
    expect(r.params.b2cAddressThreshold).toEqual({ amountPaise: 25_000_00, inclusive: true });
    expect(r.params.eInvoicingThresholdPaise).toBe(GST_DEFAULTS.eInvoicingThresholdPaise);
    expect(r.missing).toContain(GST_PARAM_KEYS.eInvoicingThreshold);
    expect(r.params.defaultSac).toBe("9983");
    expect(r.params.sacByService).toEqual({ gst: "998231" });
    expect(r.unverified).toEqual([]); // verified undefined is not "false"
  });
});

// -------------------------------------------------------------------------------------------------
// Place of supply (§6.4)
// -------------------------------------------------------------------------------------------------

describe("placeOfSupply (§6.4)", () => {
  it("takes the state from the client's GSTIN first", () => {
    expect(placeOfSupply({ gstin: MH_GSTIN, stateCode: "29" })).toEqual({
      code: "27",
      name: "Maharashtra",
      source: "gstin",
      intraState: false,
    });
    expect(placeOfSupply({ gstin: KA_GSTIN }).intraState).toBe(true);
    expect(placeOfSupply({ gstin: TN_GSTIN, stateCode: "27" })).toMatchObject({ code: "33", name: "Tamil Nadu", source: "gstin" });
    expect(placeOfSupply({ gstin: ` ${MH_GSTIN.toLowerCase()} ` }).code).toBe("27");
  });

  it("falls back to the client's state code, then to Karnataka for an unregistered local client", () => {
    expect(placeOfSupply({ stateCode: "33" })).toMatchObject({ code: "33", name: "Tamil Nadu", source: "client_state", intraState: false });
    expect(placeOfSupply({ gstin: null, stateCode: null })).toEqual({ code: "29", name: "Karnataka", source: "firm_state", intraState: true });
    expect(placeOfSupply({})).toMatchObject({ code: "29", source: "firm_state" });
  });

  it("ignores an invalid GSTIN and an unknown state code", () => {
    expect(placeOfSupply({ gstin: "27AAPFU0939F1ZA", stateCode: "33" })).toMatchObject({ code: "33", source: "client_state" });
    expect(placeOfSupply({ stateCode: "45" })).toMatchObject({ code: "29", source: "firm_state" });
    expect(placeOfSupply({ gstin: "  ", stateCode: " 07 " })).toMatchObject({ code: "07", name: "Delhi" });
  });

  it("works for another firm state", () => {
    expect(placeOfSupply({ gstin: MH_GSTIN }, "27").intraState).toBe(true);
    expect(placeOfSupply({}, "27")).toMatchObject({ code: "27", intraState: true });
    expect(isIntraState("29")).toBe(true);
    expect(isIntraState("27")).toBe(false);
  });
});

describe("applyPlaceOfSupplyOverride (§7.9.2: overridable with a reason)", () => {
  const derived = placeOfSupply({ gstin: KA_GSTIN });

  it("keeps the derived value with no override or the same state", () => {
    expect(applyPlaceOfSupplyOverride(derived, null)).toEqual({ ok: true, value: derived });
    expect(applyPlaceOfSupplyOverride(derived, { stateCode: "29", reason: "" })).toEqual({ ok: true, value: derived });
  });

  it("needs a valid state and a reason", () => {
    const noReason = applyPlaceOfSupplyOverride(derived, { stateCode: "27", reason: "  " });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.fieldErrors.place_of_supply_reason?.[0]).toContain("Maharashtra (27)");
    const badCode = applyPlaceOfSupplyOverride(derived, { stateCode: "77", reason: "x" });
    expect(badCode.ok).toBe(false);
    if (!badCode.ok) expect(badCode.fieldErrors.place_of_supply_code).toBeDefined();
  });

  it("applies the override and recomputes intra/inter-state", () => {
    const r = applyPlaceOfSupplyOverride(derived, { stateCode: "27", reason: "Service delivered at the Pune branch" });
    expect(r).toEqual({ ok: true, value: { code: "27", name: "Maharashtra", source: "override", intraState: false } });
  });
});

// -------------------------------------------------------------------------------------------------
// Lines and totals (§6.3, §6.4)
// -------------------------------------------------------------------------------------------------

describe("computeLine (§6.3: round half-up at the line)", () => {
  it("multiplies quantity by rate and takes the tax on the rounded amount", () => {
    expect(computeLine(1, 1_000_000, 18)).toEqual({ amountPaise: 1_000_000, taxPaise: 180_000 });
    expect(computeLine(1, 100_050, 18)).toEqual({ amountPaise: 100_050, taxPaise: 18_009 }); // ₹180.09
    expect(computeLine("2", 50_000, "18.00")).toEqual({ amountPaise: 100_000, taxPaise: 18_000 });
  });

  it("rounds a fractional quantity's amount half-up", () => {
    // 1.5 × ₹333.33 = ₹499.995 → ₹500.00
    expect(computeLine("1.5", 33_333, 18).amountPaise).toBe(50_000);
    // 0.25 × ₹0.10 = 2.5 paise → 3 paise
    expect(computeLine(0.25, 10, 0)).toEqual({ amountPaise: 3, taxPaise: 0 });
  });

  it("rounds the tax half-up (odd paise)", () => {
    // ₹100.03 × 18% = ₹18.0054 → 1801 paise; ₹0.25 × 18% = 4.5 → 5
    expect(computeLine(1, 10_003, 18).taxPaise).toBe(1_801);
    expect(computeLine(1, 25, 18).taxPaise).toBe(5);
    expect(computeLine(1, 10_000, 5).taxPaise).toBe(500);
    expect(computeLine(1, 10_000, 0).taxPaise).toBe(0);
  });

  it("refuses impossible input", () => {
    expect(() => computeLine(0, 100, 18)).toThrow(RangeError);
    expect(() => computeLine(-1, 100, 18)).toThrow(RangeError);
    expect(() => computeLine(1, -1, 18)).toThrow(RangeError);
    expect(() => computeLine(1, 1.5, 18)).toThrow(RangeError);
    expect(() => computeLine(1, 100, 101)).toThrow(RangeError);
    expect(() => computeLine(1, 100, -5)).toThrow(RangeError);
    expect(() => computeLine("abc", 100, 18)).toThrow(TypeError);
  });
});

describe("splitTax (§6.4: cgst = round(tax/2), sgst = tax − cgst)", () => {
  it("halves an even tax", () => {
    expect(splitTax(180_000, true)).toEqual({ cgstPaise: 90_000, sgstPaise: 90_000, igstPaise: 0 });
  });

  it("gives the odd paisa to CGST (half-up) so the two add up exactly", () => {
    expect(splitTax(1_801, true)).toEqual({ cgstPaise: 901, sgstPaise: 900, igstPaise: 0 });
    expect(splitTax(1, true)).toEqual({ cgstPaise: 1, sgstPaise: 0, igstPaise: 0 });
    expect(splitTax(0, true)).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  });

  it("puts the full amount in IGST for an inter-state supply", () => {
    expect(splitTax(1_801, false)).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1_801 });
  });

  it("always adds up, for every tax amount", () => {
    for (let tax = 0; tax <= 5_000; tax += 1) {
      const s = splitTax(tax, true);
      expect(s.cgstPaise + s.sgstPaise).toBe(tax);
      expect(s.cgstPaise - s.sgstPaise === 0 || s.cgstPaise - s.sgstPaise === 1).toBe(true);
    }
  });
});

describe("invoiceTotals (§5.7, §6.3, §6.4)", () => {
  const lines = [
    { quantity: 1, ratePaise: 1_000_050, taxRate: 18 }, // ₹10,000.50 → tax ₹1,800.09
    { quantity: 3, ratePaise: 33_333, taxRate: 18 }, // ₹999.99 → tax ₹180.00
    { quantity: 1, ratePaise: 150_000, taxRate: 18, isReimbursement: true }, // ROC fee paid as pure agent
  ];

  it("splits an intra-state invoice into CGST + SGST line by line", () => {
    const t = invoiceTotals(lines, "29", "29", { roundOff: false });
    expect(t.intraState).toBe(true);
    expect(t.lines[0]).toMatchObject({ amountPaise: 1_000_050, taxPaise: 180_009, cgstPaise: 90_005, sgstPaise: 90_004, igstPaise: 0 });
    expect(t.lines[1]).toMatchObject({ amountPaise: 99_999, taxPaise: 18_000, cgstPaise: 9_000, sgstPaise: 9_000 });
    expect(t.taxablePaise).toBe(1_100_049);
    expect(t.cgstPaise).toBe(99_005);
    expect(t.sgstPaise).toBe(99_004);
    expect(t.igstPaise).toBe(0);
    expect(t.taxPaise).toBe(198_009);
    expect(t.reimbursementPaise).toBe(150_000);
    expect(t.grossPaise).toBe(1_448_058);
    expect(t.roundOffPaise).toBe(0);
    expect(t.totalPaise).toBe(1_448_058);
  });

  it("keeps reimbursements out of the taxable value and charges them no GST, whatever rate is passed", () => {
    const t = invoiceTotals(lines, "29", "29", { roundOff: false });
    expect(t.lines[2]).toEqual({
      amountPaise: 150_000,
      taxPaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      isReimbursement: true,
      taxRate: 0,
    });
    const onlyReimbursement = invoiceTotals([lines[2]], "29");
    expect(onlyReimbursement).toMatchObject({ taxablePaise: 0, taxPaise: 0, reimbursementPaise: 150_000, totalPaise: 150_000 });
  });

  it("charges IGST for another state", () => {
    const t = invoiceTotals(lines, "27", "29", { roundOff: false });
    expect(t.intraState).toBe(false);
    expect(t).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 198_009, taxPaise: 198_009, totalPaise: 1_448_058 });
  });

  it("rounds to whole rupees with a round-off line when enabled (§6.3)", () => {
    const t = invoiceTotals(lines, "29", "29", { roundOff: true });
    expect(t.grossPaise).toBe(1_448_058);
    expect(t.roundOffPaise).toBe(42);
    expect(t.totalPaise).toBe(1_448_100);
    const down = invoiceTotals([{ quantity: 1, ratePaise: 10_003, taxRate: 18 }], "29", "29", { roundOff: true });
    // ₹100.03 + ₹18.01 = ₹118.04 → ₹118.00
    expect(down).toMatchObject({ grossPaise: 11_804, roundOffPaise: -4, totalPaise: 11_800 });
    const half = invoiceTotals([{ quantity: 1, ratePaise: 50, taxRate: 0 }], "29", "29", { roundOff: true });
    expect(half).toMatchObject({ roundOffPaise: 50, totalPaise: 100 });
  });

  it("sums rounded lines rather than rounding the sum (§6.3)", () => {
    const two = [
      { quantity: 1, ratePaise: 10_003, taxRate: 18 },
      { quantity: 1, ratePaise: 10_003, taxRate: 18 },
    ];
    const t = invoiceTotals(two, "29");
    // Each line: tax 1801 (cgst 901 + sgst 900). One-shot would be 20006 × 18% = 3601.
    expect(t.taxPaise).toBe(3_602);
    expect(t.cgstPaise).toBe(1_802);
    expect(t.sgstPaise).toBe(1_800);
  });

  it("always satisfies total = taxable + tax + reimbursements + round-off, with |round-off| ≤ ₹0.99", () => {
    for (let rate = 1; rate < 3_000; rate += 37) {
      for (const pos of ["29", "27"]) {
        const t = invoiceTotals(
          [
            { quantity: "1.75", ratePaise: rate, taxRate: 18 },
            { quantity: 2, ratePaise: rate * 3 + 1, taxRate: 5 },
            { quantity: 1, ratePaise: rate, taxRate: 0, isReimbursement: true },
          ],
          pos,
          "29",
          { roundOff: true },
        );
        expect(t.cgstPaise + t.sgstPaise + t.igstPaise).toBe(t.taxPaise);
        expect(t.totalPaise).toBe(t.taxablePaise + t.taxPaise + t.reimbursementPaise + t.roundOffPaise);
        expect(Math.abs(t.roundOffPaise)).toBeLessThanOrEqual(99);
        expect(t.totalPaise % RUPEE).toBe(0);
      }
    }
  });

  it("handles an empty invoice and defaults round-off off", () => {
    expect(invoiceTotals([], "29")).toMatchObject({ taxablePaise: 0, taxPaise: 0, totalPaise: 0, roundOffPaise: 0, lines: [] });
    expect(invoiceTotals([{ quantity: 1, ratePaise: 10_003, taxRate: 18 }], "29").roundOffPaise).toBe(0);
  });
});

describe("reimbursementDescription (§6.4: the line must say it's a reimbursement)", () => {
  it("adds the pure-agent wording unless the text already says reimbursement", () => {
    expect(reimbursementDescription("ROC filing fee for AOC-4")).toBe("ROC filing fee for AOC-4 (reimbursement of expenses incurred as pure agent)");
    expect(reimbursementDescription("Reimbursement: MCA fees")).toBe("Reimbursement: MCA fees");
    expect(reimbursementDescription("  Govt fee reimbursed  ")).toBe("Govt fee reimbursed");
    expect(reimbursementDescription("")).toBe("Reimbursement of expenses incurred as pure agent");
  });
});

// -------------------------------------------------------------------------------------------------
// Rate picker (§6.4)
// -------------------------------------------------------------------------------------------------

describe("rateOptions and validateTaxRate (§6.4)", () => {
  it("offers 18% (default), 5%, 0% / exempt and other", () => {
    expect(rateOptions()).toEqual([
      { value: 18, label: "18% (default)", isDefault: true },
      { value: 5, label: "5%", isDefault: false },
      { value: 0, label: "0% / exempt", isDefault: false },
      { value: "other", label: "Other (give a reason)", isDefault: false },
    ]);
    expect(rateOptions({ ...GST_DEFAULTS, allowOtherRate: false }).map((o) => o.value)).toEqual([18, 5, 0]);
  });

  it("accepts the offered rates without a reason", () => {
    expect(validateTaxRate(18)).toEqual({ ok: true, rate: 18, isOther: false });
    expect(validateTaxRate("18.00")).toEqual({ ok: true, rate: 18, isOther: false });
    expect(validateTaxRate(5)).toEqual({ ok: true, rate: 5, isOther: false });
    expect(validateTaxRate(0)).toEqual({ ok: true, rate: 0, isOther: false });
  });

  it("requires a reason for any other rate, and warns when it isn't a current slab", () => {
    const noReason = validateTaxRate(12);
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error).toContain("reason");
    expect(validateTaxRate(12, { reason: "Old FY correction at the rate first charged" })).toEqual({
      ok: true,
      rate: 12,
      isOther: true,
      warning: "12% isn't one of the current GST slabs (0% / 5% / 18% / 40%).",
    });
    expect(validateTaxRate(40, { reason: "Per notification" })).toEqual({ ok: true, rate: 40, isOther: true });
  });

  it("refuses other rates when the picker doesn't allow them", () => {
    const r = validateTaxRate(12, { reason: "x", params: { ...GST_DEFAULTS, allowOtherRate: false } });
    expect(r).toEqual({ ok: false, error: "Use one of the GST rates offered: 18%, 5%, 0%." });
  });

  it("insists on 0% for reimbursements", () => {
    expect(validateTaxRate(0, { isReimbursement: true })).toEqual({ ok: true, rate: 0, isOther: false });
    expect(validateTaxRate(18, { isReimbursement: true }).ok).toBe(false);
  });

  it("refuses malformed rates", () => {
    expect(validateTaxRate("18%").ok).toBe(false);
    expect(validateTaxRate("-5").ok).toBe(false);
    expect(validateTaxRate("101").ok).toBe(false);
    expect(validateTaxRate("2.555").ok).toBe(false);
    expect(validateTaxRate("").ok).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// SAC (§6.4)
// -------------------------------------------------------------------------------------------------

describe("sacFor and checkSacCode (§6.4)", () => {
  it("maps services to the seeded SACs", () => {
    expect(sacFor("audit")).toMatchObject({ sac: "998221", source: "map", ok: true });
    expect(sacFor("bookkeeping").sac).toBe("998222");
    expect(sacFor("income_tax").sac).toBe("998231");
    expect(sacFor("income_tax", undefined, null, { individual: true }).sac).toBe("998232");
    expect(sacFor("other").sac).toBe("9982");
  });

  it("falls back to the default SAC for unmapped services, and income_tax for individuals without their own entry", () => {
    expect(sacFor("gst")).toMatchObject({ sac: "9982", source: "default", ok: true, minDigits: 4 });
    expect(sacFor(null)).toMatchObject({ sac: "9982", source: "default" });
    expect(sacFor("payroll", {}, null, { defaultSac: "998223" }).sac).toBe("998223");
    expect(sacFor("income_tax", { income_tax: "998231" }, null, { individual: true }).sac).toBe("998231");
    expect(sacFor("audit", { audit: "  " }).source).toBe("default");
  });

  it("allows a 4-digit SAC up to ₹5 crore turnover and needs 6 digits above it", () => {
    const fiveCrore = 5 * CRORE;
    expect(sacDigitsRequired(null)).toBe(4);
    expect(sacDigitsRequired(fiveCrore)).toBe(4);
    expect(sacDigitsRequired(fiveCrore + 1)).toBe(6);
    expect(sacFor("gst", undefined, fiveCrore).ok).toBe(true);
    const above = sacFor("gst", undefined, fiveCrore + 1);
    expect(above).toMatchObject({ sac: "9982", ok: false, minDigits: 6 });
    expect(above.error).toContain("6-digit SAC");
    expect(sacFor("audit", undefined, 10 * CRORE)).toMatchObject({ sac: "998221", ok: true, minDigits: 6 });
  });

  it("checks the SAC's form", () => {
    expect(checkSacCode("9982", null)).toBeNull();
    expect(checkSacCode("998221", null)).toBeNull();
    expect(checkSacCode("9982 21", null)).toBeNull();
    expect(checkSacCode("99821", null)).not.toBeNull();
    expect(checkSacCode("1234", null)).not.toBeNull();
    expect(checkSacCode("99", null)).not.toBeNull();
    expect(checkSacCode("abcd", null)).not.toBeNull();
    expect(checkSacCode("99822100", null)).not.toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Rule 46 (§6.4)
// -------------------------------------------------------------------------------------------------

describe("validateRule46 (§6.4, §7.9.2)", () => {
  const registered = { name: "Acme Pvt Ltd", address: "MG Road, Bengaluru", stateCode: "29", gstRegistration: "registered" as const, gstin: KA_GSTIN };
  const unregistered = { name: "Ravi Kumar", address: null, stateCode: null, gstRegistration: "unregistered" as const, gstin: null };

  it("passes a complete registered recipient", () => {
    expect(validateRule46({ recipient: registered, invoiceValuePaise: 10 * CRORE })).toEqual({ ok: true, fieldErrors: {}, warnings: [] });
  });

  it("blocks a registered client with no GSTIN, and says why", () => {
    const r = validateRule46({ recipient: { ...registered, gstin: null }, invoiceValuePaise: 1_000_00 });
    expect(r.ok).toBe(false);
    expect(r.fieldErrors.client_gstin).toEqual([MISSING_RECIPIENT_GSTIN_MESSAGE]);
    expect(r.error).toBe(MISSING_RECIPIENT_GSTIN_MESSAGE);
    expect(MISSING_RECIPIENT_GSTIN_MESSAGE).toContain("costs a registered client their input tax credit");
    expect(validateRule46({ recipient: { ...registered, gstin: "   " }, invoiceValuePaise: 1 }).ok).toBe(false);
  });

  it("blocks an invalid GSTIN", () => {
    const r = validateRule46({ recipient: { ...registered, gstin: "29ABCDE1234F1ZA" }, invoiceValuePaise: 1 });
    expect(r.ok).toBe(false);
    expect(r.fieldErrors.client_gstin?.[0]).toContain("check character");
  });

  it("warns (doesn't block) when a registered client's address is missing", () => {
    const r = validateRule46({ recipient: { ...registered, address: "" }, invoiceValuePaise: 1 });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain("address");
  });

  it("needs the address and state of an unregistered recipient only when the value exceeds ₹50,000", () => {
    expect(validateRule46({ recipient: unregistered, invoiceValuePaise: 50_000_00 }).ok).toBe(true);
    const over = validateRule46({ recipient: unregistered, invoiceValuePaise: 50_000_01 });
    expect(over.ok).toBe(false);
    expect(Object.keys(over.fieldErrors).sort()).toEqual(["client_address", "client_state_code"]);
    expect(over.fieldErrors.client_address?.[0]).toContain("₹50,000");
    const complete = validateRule46({ recipient: { ...unregistered, address: "Jayanagar", stateCode: "29" }, invoiceValuePaise: 1_00_000_00 });
    expect(complete.ok).toBe(true);
    const badState = validateRule46({ recipient: { ...unregistered, address: "Jayanagar", stateCode: "88" }, invoiceValuePaise: 1_00_000_00 });
    expect(badState.fieldErrors.client_state_code).toBeDefined();
  });

  it("applies the threshold inclusively when the parameter says so", () => {
    const params: Pick<GstParams, "b2cAddressThreshold"> = { b2cAddressThreshold: { amountPaise: 50_000_00, inclusive: true } };
    expect(needsB2cAddress(50_000_00)).toBe(false);
    expect(needsB2cAddress(50_000_00, params)).toBe(true);
    expect(validateRule46({ recipient: unregistered, invoiceValuePaise: 50_000_00 }, params).ok).toBe(false);
  });

  it("treats an unknown registration like unregistered, with a warning", () => {
    const r = validateRule46({ recipient: { ...unregistered, gstRegistration: "unknown" }, invoiceValuePaise: 60_000_00 });
    expect(r.ok).toBe(false);
    expect(r.warnings[0]).toContain("unknown");
    expect(validateRule46({ recipient: { ...unregistered, gstRegistration: "unknown" }, invoiceValuePaise: 100 }).ok).toBe(true);
  });

  it("needs the recipient's name, a valid place of supply, and each line's description and SAC", () => {
    const r = validateRule46({
      recipient: { ...registered, name: " " },
      invoiceValuePaise: 1,
      placeOfSupplyCode: "00",
      lines: [{ description: "Audit fee", sacCode: "998221" }, { description: "", sacCode: null }],
    });
    expect(Object.keys(r.fieldErrors).sort()).toEqual(["client_name", "items.1.description", "items.1.sac_code", "place_of_supply_code"]);
    expect(validateRule46({ recipient: registered, invoiceValuePaise: 1, placeOfSupplyCode: "29" }).ok).toBe(true);
  });

  it("checks the supplier's name, address and GSTIN when given", () => {
    const ok = validateRule46({ recipient: registered, invoiceValuePaise: 1, supplier: { name: "TaxWise Consultants", address: "Bengaluru", gstin: TAXWISE_GSTIN } });
    expect(ok.ok).toBe(true);
    const missing = validateRule46({ recipient: registered, invoiceValuePaise: 1, supplier: { name: "TaxWise Consultants", address: "", gstin: null } });
    expect(Object.keys(missing.fieldErrors).sort()).toEqual(["firm", "firm_gstin"]);
    const bad = validateRule46({ recipient: registered, invoiceValuePaise: 1, supplier: { name: "T", address: "B", gstin: "29AAXFT1811B1Z4" } });
    expect(bad.fieldErrors.firm_gstin?.[0]).toContain("isn't valid");
  });
});

// -------------------------------------------------------------------------------------------------
// Rule 47 (§6.4)
// -------------------------------------------------------------------------------------------------

describe("rule47Warning (§6.4, §7.9.2)", () => {
  const done = "2026-09-20";

  it("says nothing up to 25 days after completion", () => {
    expect(rule47Warning(done, "2026-09-20")).toBeNull();
    expect(rule47Warning(done, "2026-10-15")).toBeNull(); // 25 days
  });

  it("flags unbilled work after 25 days, with the Rule 47 date", () => {
    const r = rule47Warning(done, "2026-10-16"); // 26 days
    expect(r).toMatchObject({ level: "due_soon", daysSinceCompletion: 26, invoiceBy: "2026-10-20" });
    expect(r?.message).toBe(
      "Work completed 26 days ago (20 Sep 2026) has no invoice. Rule 47 requires the tax invoice within 30 days: issue it by 20 Oct 2026.",
    );
    expect(rule47Warning(done, "2026-10-20")?.level).toBe("due_soon"); // day 30 is still in time
  });

  it("is late once more than 30 days have passed", () => {
    const r = rule47Warning(done, "2026-10-21"); // 31 days
    expect(r).toMatchObject({ level: "late", daysSinceCompletion: 31, invoiceBy: "2026-10-20" });
    expect(r?.message).toContain("required the tax invoice within 30 days, by 20 Oct 2026. Invoice it now.");
  });

  it("takes the day counts from parameters", () => {
    expect(rule47Warning(done, "2026-09-30", { invoiceIssueDays: 15, unbilledFlagDays: 5 })?.level).toBe("due_soon");
    expect(rule47Warning(done, "2026-10-06", { invoiceIssueDays: 15, unbilledFlagDays: 5 })?.level).toBe("late");
  });
});

// -------------------------------------------------------------------------------------------------
// Credit notes (s.34; §6.4, §7.9.7)
// -------------------------------------------------------------------------------------------------

describe("creditNoteDeadline (s.34(2))", () => {
  it("is 30 November after the end of the FY of supply", () => {
    expect(creditNoteDeadline("2026-05-10")).toBe("2027-11-30"); // FY 2026-27
    expect(creditNoteDeadline("2026-04-01")).toBe("2027-11-30");
    expect(creditNoteDeadline("2027-03-31")).toBe("2027-11-30");
    expect(creditNoteDeadline("2026-03-15")).toBe("2026-11-30"); // FY 2025-26
  });

  it("is the annual return date when that is earlier", () => {
    expect(creditNoteDeadline("2026-03-15", "2026-10-15")).toBe("2026-10-15");
    expect(creditNoteDeadline("2026-03-15", "2026-12-31")).toBe("2026-11-30");
    expect(creditNoteDeadline("2026-03-15", null)).toBe("2026-11-30");
  });

  it("reads the month and day from parameters", () => {
    expect(creditNoteDeadline("2026-03-15", null, { creditNoteDeadline: { month: 9, day: 30 } })).toBe("2026-09-30");
  });
});

describe("checkCreditNote (§6.4: warn from 30 days before, refuse after)", () => {
  const invoiceDate = "2026-03-15"; // deadline 30 Nov 2026

  it("is fine well before the deadline", () => {
    expect(checkCreditNote({ invoiceDate, creditNoteDate: "2026-10-30", reducesTax: true })).toEqual({
      deadline: "2026-11-30",
      daysLeft: 31,
      level: "ok",
      allowed: true,
      message: null,
    });
  });

  it("warns from 30 days before the deadline up to the day itself", () => {
    const warn = checkCreditNote({ invoiceDate, creditNoteDate: "2026-10-31", reducesTax: true });
    expect(warn).toMatchObject({ level: "warn", allowed: true, daysLeft: 30 });
    expect(warn.message).toBe("A credit note that reduces GST must be issued by 30 Nov 2026 (s.34 deadline): 30 days left.");
    const lastDay = checkCreditNote({ invoiceDate, creditNoteDate: "2026-11-30", reducesTax: true });
    expect(lastDay).toMatchObject({ level: "warn", allowed: true, daysLeft: 0 });
    expect(lastDay.message).toContain("today is the last day");
  });

  it("refuses a tax-reducing credit note after the deadline, pointing to a commercial credit", () => {
    const r = checkCreditNote({ invoiceDate, creditNoteDate: "2026-12-01", reducesTax: true });
    expect(r).toMatchObject({ level: "refuse", allowed: false, daysLeft: -1 });
    expect(r.message).toContain("commercial credit");
  });

  it("still allows a commercial (non-GST) credit after the deadline, with a notice", () => {
    const r = checkCreditNote({ invoiceDate, creditNoteDate: "2027-06-01", reducesTax: false });
    expect(r).toMatchObject({ level: "commercial", allowed: true });
    expect(r.message).toContain("doesn't go into GSTR-1");
  });

  it("uses the annual return filing date when earlier, and says so", () => {
    const r = checkCreditNote({ invoiceDate, annualReturnFiledOn: "2026-10-15", creditNoteDate: "2026-10-16", reducesTax: true });
    expect(r).toMatchObject({ deadline: "2026-10-15", level: "refuse", allowed: false });
    expect(r.message).toContain("the annual return was filed");
  });
});

describe("creditNoteAmounts and validateCreditNoteTaxable (§7.9.7)", () => {
  it("computes GST at the invoice's rate and split", () => {
    expect(creditNoteAmounts(10_003, 18, "29")).toEqual({
      taxablePaise: 10_003,
      taxPaise: 1_801,
      cgstPaise: 901,
      sgstPaise: 900,
      igstPaise: 0,
      totalPaise: 11_804,
    });
    expect(creditNoteAmounts(10_003, 18, "27")).toMatchObject({ igstPaise: 1_801, cgstPaise: 0, totalPaise: 11_804 });
    expect(() => creditNoteAmounts(0, 18, "29")).toThrow(RangeError);
  });

  it("allows at most the remaining taxable value", () => {
    expect(validateCreditNoteTaxable(5_000_00, 5_000_00)).toBeNull();
    expect(validateCreditNoteTaxable(5_000_01, 5_000_00)).toBe("You can credit at most ₹5,000.00, the taxable value not yet credited on this invoice.");
    expect(validateCreditNoteTaxable(0, 5_000_00)).toBe("Enter the taxable amount to credit.");
  });
});

// -------------------------------------------------------------------------------------------------
// E-invoicing (§6.4)
// -------------------------------------------------------------------------------------------------

describe("eInvoicingApplies and eInvoiceReportingDays (§6.4)", () => {
  it("applies only above ₹5 crore aggregate turnover", () => {
    expect(eInvoicingApplies(null)).toBe(false);
    expect(eInvoicingApplies(5 * CRORE)).toBe(false);
    expect(eInvoicingApplies(5 * CRORE + 1)).toBe(true);
  });

  it("has a 30-day IRP window from ₹10 crore turnover", () => {
    expect(eInvoiceReportingDays(4 * CRORE)).toBeNull();
    expect(eInvoiceReportingDays(10 * CRORE - 1)).toBeNull();
    expect(eInvoiceReportingDays(10 * CRORE)).toBe(30);
    expect(eInvoiceReportingDays(null)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Seed file (supabase/seed/40_params_gst_tds.sql) matches the TS seed rows
// -------------------------------------------------------------------------------------------------

type SqlRow = { key: string; value: unknown; effectiveFrom: string; effectiveTo: string | null; verified: boolean; rest: string };

function readSeedRows(): { sql: string; rows: SqlRow[] } {
  const sql = readFileSync(join(process.cwd(), "supabase/seed/40_params_gst_tds.sql"), "utf8");
  const ROW = /^\s*\('([^']+)', '((?:[^']|'')*)'::jsonb, '(\d{4}-\d{2}-\d{2})', (null|'\d{4}-\d{2}-\d{2}'), (.*), (true|false)\),?$/;
  const rows: SqlRow[] = [];
  for (const line of sql.split("\n")) {
    const m = ROW.exec(line);
    if (!m) continue;
    rows.push({
      key: m[1],
      value: JSON.parse(m[2].replace(/''/g, "'")),
      effectiveFrom: m[3],
      effectiveTo: m[4] === "null" ? null : m[4].slice(1, -1),
      verified: m[6] === "true",
      rest: m[5],
    });
  }
  return { sql, rows };
}

function sqlQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

describe("seed SQL 40_params_gst_tds.sql (§16)", () => {
  const { sql, rows } = readSeedRows();
  const expected: readonly SeedParameterRow[] = [...GST_SEED_PARAMETERS, ...TDS_SEED_PARAMETERS];

  it("has exactly the TS seed rows, in order, with the same values, dates and verification", () => {
    expect(rows.length).toBe(expected.length);
    rows.forEach((row, i) => {
      const e = expected[i];
      expect({ key: row.key, value: row.value, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, verified: row.verified }).toEqual({
        key: e.key,
        value: e.value,
        effectiveFrom: e.effectiveFrom,
        effectiveTo: e.effectiveTo,
        verified: e.verified,
      });
      expect(row.rest).toBe([e.statute, e.sectionRef, e.sourceRef, e.notes].map(sqlQuote).join(", "));
    });
  });

  it("fills statute, section, source and notes on every row, and keeps (key, effective_from) unique", () => {
    for (const r of expected) {
      expect(r.statute.length).toBeGreaterThan(0);
      expect(r.sectionRef.length).toBeGreaterThan(0);
      expect(r.sourceRef.length).toBeGreaterThan(0);
      expect(r.notes.length).toBeGreaterThan(0);
    }
    const ids = expected.map((r) => `${r.key}@${r.effectiveFrom}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags every [verify] row as unverified and nothing else as unverified without saying why", () => {
    for (const r of expected) {
      if (r.notes.includes("[verify]") || r.sectionRef.includes("[verify]")) expect(r.verified).toBe(false);
      if (!r.verified) expect(`${r.notes} ${r.sectionRef}`).toMatch(/\[verify\]|confirm with the partners/);
    }
  });

  it("documents every key it seeds, and only inserts statutory_parameters idempotently", () => {
    for (const key of new Set(expected.map((r) => r.key))) {
      const documented = sql.includes(key) || sql.includes(key.replace(/^tds\.[a-z_]+\./, "tds.<nature>."));
      expect(documented).toBe(true);
    }
    for (const key of Object.values(GST_PARAM_KEYS)) expect(sql).toContain(`--   ${key}`);
    expect(sql.match(/insert into/gi)?.length).toBe(1);
    expect(sql).toContain("insert into public.statutory_parameters");
    expect(sql).toContain("on conflict (key, effective_from) do nothing;");
    // No other table is touched: no clients, users or demo data (§0.1 rule 14, §16).
    expect(Array.from(new Set(sql.match(/\b(public|auth)\.[a-z_]+/g)))).toEqual(["public.statutory_parameters"]);
  });
});

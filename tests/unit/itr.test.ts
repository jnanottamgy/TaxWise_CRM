import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SeedParameterRow } from "@/lib/domain/gst";
import {
  computeItr,
  interest234A,
  interest234B,
  interest234C,
  itrYearLabel,
  ItrInputError,
  monthsOrPartOfMonth,
  roundDownToRupees,
  roundToNearestRupees,
  sectionCite,
  sectionLabel,
  slabTax,
  validateItrInputs,
  type ItrDates,
  type ItrInputs,
  type RegimeComputation,
} from "@/lib/domain/itr";
import {
  ITR_RULESET_FY2024_25,
  ITR_RULESET_FY2025_26,
  ITR_RULESET_FY2026_27,
  ITR_RULESET_PARAM_KEY,
  ITR_RULESET_SEED_PARAMETERS,
  ITR_RULESETS,
  parseRuleSet,
  resolveItrRuleSet,
  seededRuleSetFor,
  type ItrRuleSet,
} from "@/lib/domain/itr-rulesets";

// Every amount below is worked by hand in the comments, in rupees; `R()` converts to paise.
const R = (rupees: number) => rupees * 100;

const DATES_FY25: ItrDates = { filingDate: "2026-07-15", dueDate: "2026-07-31" };
const DATES_FY24: ItrDates = { filingDate: "2025-07-15", dueDate: "2025-09-15" };

function inputs(over: Partial<ItrInputs> & { financialYear?: string } = {}): ItrInputs {
  return { financialYear: "2025-26", assesseeType: "individual", ageBand: "below_60", income: {}, ...over };
}

function compute(over: Partial<ItrInputs> = {}, ruleSet: ItrRuleSet = ITR_RULESET_FY2025_26, dates: ItrDates = DATES_FY25) {
  return computeItr(inputs({ financialYear: ruleSet.financialYear, ...over }), ruleSet, dates);
}

function line(c: RegimeComputation, code: string) {
  const l = c.lines.find((x) => x.code === code);
  if (!l) throw new Error(`No line ${code}`);
  return l;
}

// -------------------------------------------------------------------------------------------------
// Rule sets (§6.11)
// -------------------------------------------------------------------------------------------------

describe("rule sets (§6.11)", () => {
  it("FY 2025-26 new regime: slabs 4/8/12/16/20/24 L at 0-30%, ₹60,000 rebate to ₹12 lakh with marginal relief, ₹75,000 standard deduction", () => {
    const n = ITR_RULESET_FY2025_26.regimes.new;
    expect(n.slabs).toEqual([
      { upTo: 400000, rate: 0 },
      { upTo: 800000, rate: 5 },
      { upTo: 1200000, rate: 10 },
      { upTo: 1600000, rate: 15 },
      { upTo: 2000000, rate: 20 },
      { upTo: 2400000, rate: 25 },
      { upTo: null, rate: 30 },
    ]);
    expect(n.rebate).toEqual({ limit: 1200000, max: 60000, marginalRelief: true, notAgainst: ["111A", "112", "112A"] });
    expect(n.standardDeduction).toBe(75000);
    expect(n.chapterVIA).toBeNull();
    expect(n.houseProperty.lossSetOff).toBe(false);
    // The new regime caps surcharge at 25%: no 37% band.
    expect(n.surcharge.bands.map((b) => [b.above, b.rate])).toEqual([
      [5000000, 10],
      [10000000, 15],
      [20000000, 25],
    ]);
  });

  it("old regime: exemption 2.5 / 3 / 5 lakh by age, 5-20-30%, ₹12,500 rebate to ₹5 lakh, Chapter VI-A caps, HP loss cap ₹2 lakh", () => {
    const o = ITR_RULESET_FY2025_26.regimes.old;
    expect(o.slabs.map((s) => [s.upTo, s.rate])).toEqual([
      [250000, 0],
      [500000, 5],
      [1000000, 20],
      [null, 30],
    ]);
    expect(o.seniorSlabs?.["60_to_79"][0]).toEqual({ upTo: 300000, rate: 0 });
    expect(o.seniorSlabs?.["80_plus"][0]).toEqual({ upTo: 500000, rate: 0 });
    expect(o.rebate).toMatchObject({ limit: 500000, max: 12500, marginalRelief: false });
    expect(o.standardDeduction).toBe(50000);
    expect(o.chapterVIA).toMatchObject({ sec80CBasket: 150000, sec80CCD1B: 50000, sec80TTA: 10000, sec80TTB: 50000 });
    expect(o.houseProperty).toEqual({ lossSetOff: true, lossSetOffCap: 200000 });
    expect(o.surcharge.bands.map((b) => b.rate)).toEqual([10, 15, 25, 37]);
    expect(o.surcharge.specialIncomeCap).toBe(15);
  });

  it("FY 2024-25: new slabs 3/7/10/12/15 L, ₹25,000 rebate to ₹7 lakh, capital-gains rates change on 23 Jul 2024", () => {
    const n = ITR_RULESET_FY2024_25.regimes.new;
    expect(n.slabs.map((s) => s.upTo)).toEqual([300000, 700000, 1000000, 1200000, 1500000, null]);
    expect(n.slabs.map((s) => s.rate)).toEqual([0, 5, 10, 15, 20, 30]);
    expect(n.rebate).toMatchObject({ limit: 700000, max: 25000, marginalRelief: true });
    expect(n.standardDeduction).toBe(75000);
    expect(ITR_RULESET_FY2024_25.capitalGains).toEqual({
      rates: { "111A": 20, "112": 12.5, "112A": 12.5 },
      ltcg112aExemption: 125000,
      cutoverDate: "2024-07-23",
      earlierRates: { "111A": 15, "112": 20, "112A": 10 },
    });
  });

  it("tax year 2026-27 keeps FY 2025-26's numbers (2026 Budget left slabs unchanged) under the 2025 Act", () => {
    const numbers = (rs: ItrRuleSet) => ({ regimes: rs.regimes, capitalGains: rs.capitalGains, cessRate: rs.cessRate, interest: rs.interest, rounding: rs.rounding });
    expect([ITR_RULESET_FY2026_27.financialYear, ITR_RULESET_FY2026_27.statute]).toEqual(["2026-27", "2025"]);
    expect([ITR_RULESET_FY2025_26.financialYear, ITR_RULESET_FY2025_26.statute]).toEqual(["2025-26", "1961"]);
    expect(numbers(ITR_RULESET_FY2026_27)).toEqual(numbers(ITR_RULESET_FY2025_26));
    expect(ITR_RULESET_FY2026_27.cessRate).toBe(4);
    expect(ITR_RULESET_FY2026_27.interest.ratePerMonth).toBe(1);
    expect(ITR_RULESET_FY2026_27.interest.instalments.map((i) => i.safeHarbourPercent)).toEqual([12, 36, null, null]);
    expect(seededRuleSetFor("2026-27")).toBe(ITR_RULESET_FY2026_27);
    expect(seededRuleSetFor("2023-24")).toBeNull();
  });

  it("parseRuleSet accepts every seeded rule set after a JSON round trip, unchanged", () => {
    for (const rs of Object.values(ITR_RULESETS)) {
      const parsed = parseRuleSet(JSON.parse(JSON.stringify(rs)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.ruleSet).toEqual(rs);
    }
  });

  it("parseRuleSet lists every problem with its path", () => {
    expect(parseRuleSet(null)).toEqual({ ok: false, errors: ["ruleSet: expected an object."] });
    const bad = JSON.parse(JSON.stringify(ITR_RULESET_FY2025_26)) as Record<string, unknown> & { regimes: { new: { slabs: unknown[]; rebate: Record<string, unknown> } } };
    bad.version = 2;
    bad.cessRate = "4";
    bad.regimes.new.slabs = [{ upTo: 800000, rate: 0 }, { upTo: 400000, rate: 5 }, { upTo: 900000, rate: 150 }];
    bad.regimes.new.rebate.notAgainst = ["111A", "115BBH"];
    const r = parseRuleSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("ruleSet.version: expected 1.");
      expect(r.errors).toContain("ruleSet.cessRate: expected a number.");
      expect(r.errors).toContain("ruleSet.regimes.new.slabs[1]: slab limits must increase.");
      expect(r.errors).toContain("ruleSet.regimes.new.slabs[2].rate: must be at most 100.");
      expect(r.errors).toContain("ruleSet.regimes.new.slabs: the last slab must have no upper limit (upTo null).");
      expect(r.errors).toContain('ruleSet.regimes.new.rebate.notAgainst: unknown special-rate section "115BBH".');
    }
    const cut = JSON.parse(JSON.stringify(ITR_RULESET_FY2025_26)) as Record<string, Record<string, unknown>>;
    cut.capitalGains.cutoverDate = "2024-07-23";
    const c = parseRuleSet(cut);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.errors).toContain("ruleSet.capitalGains: cutoverDate and earlierRates must both be set or both be null.");
      expect(c.errors).toContain("ruleSet.capitalGains.cutoverDate: must fall inside the financial year (after 1 April).");
    }
  });

  it("resolveItrRuleSet picks the row in force on 1 April of the FY and reports its verification", () => {
    const rows = ITR_RULESET_SEED_PARAMETERS;
    const fy25 = resolveItrRuleSet(rows, "2025-26");
    expect(fy25.ok && fy25.ruleSet.financialYear === "2025-26" && fy25.verified).toBe(true);
    const fy26 = resolveItrRuleSet(rows, "2026-27");
    expect(fy26.ok && fy26.verified).toBe(false);
    expect(fy26.ok && fy26.ruleSet.statute).toBe("2025");
    expect(resolveItrRuleSet(rows, "2023-24")).toEqual({
      ok: false,
      error: "No income-tax rule set is recorded for FY 2023-24. Add it under Settings → Law & rules.",
    });
    const broken = resolveItrRuleSet([{ ...rows[1], value: { version: 1 } }], "2025-26");
    expect(broken.ok).toBe(false);
    const misfiled = resolveItrRuleSet([{ ...rows[1], value: ITR_RULESET_FY2024_25 }], "2025-26");
    expect(misfiled).toEqual({ ok: false, error: "The rule set in force on 2025-04-01 is for FY 2024-25, not FY 2025-26." });
  });
});

// -------------------------------------------------------------------------------------------------
// Helpers: slabs, rounding (s.288A / s.288B, Rule 119A), months
// -------------------------------------------------------------------------------------------------

describe("helpers", () => {
  it("slabTax works slab by slab", () => {
    // 14,25,000 at FY 2025-26 new slabs: 0 + 20,000 + 40,000 + 15% of 2,25,000 (33,750) = 93,750.
    const { tax, lines } = slabTax(R(1425000), ITR_RULESET_FY2025_26.regimes.new.slabs);
    expect(tax).toBe(R(93750));
    expect(lines.map((l) => l.tax)).toEqual([0, R(20000), R(40000), R(33750)]);
    expect(slabTax(0, ITR_RULESET_FY2025_26.regimes.new.slabs)).toEqual({ tax: 0, lines: [] });
  });

  it("rounds total income and tax to the nearest ₹10 (₹5 up), interest bases down to ₹100", () => {
    expect(roundToNearestRupees(R(1210004), 10)).toBe(R(1210000));
    expect(roundToNearestRupees(R(1210005), 10)).toBe(R(1210010));
    expect(roundToNearestRupees(R(1210004) + 99, 10)).toBe(R(1210000));
    expect(roundToNearestRupees(-R(12805), 10)).toBe(-R(12810));
    expect(roundDownToRupees(R(68099), 100)).toBe(R(68000));
    expect(roundDownToRupees(-R(500), 100)).toBe(0);
  });

  it("counts a month or part of a month from the start date", () => {
    expect(monthsOrPartOfMonth("2026-08-01", "2026-08-01")).toBe(1);
    expect(monthsOrPartOfMonth("2026-08-01", "2026-08-31")).toBe(1);
    expect(monthsOrPartOfMonth("2026-08-01", "2026-09-01")).toBe(2);
    expect(monthsOrPartOfMonth("2026-04-01", "2026-07-31")).toBe(4);
    expect(monthsOrPartOfMonth("2026-09-16", "2026-10-15")).toBe(1);
    expect(monthsOrPartOfMonth("2026-09-16", "2026-10-16")).toBe(2);
    expect(monthsOrPartOfMonth("2026-08-01", "2026-07-31")).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// New regime, FY 2025-26: the ₹12 lakh rebate edge
// -------------------------------------------------------------------------------------------------

describe("new regime FY 2025-26: rebate and marginal relief (§6.11)", () => {
  it("salary ₹12,75,000: standard deduction ₹75,000 brings income to ₹12 lakh; tax ₹60,000 is fully rebated", () => {
    // 12,75,000 − 75,000 = 12,00,000. Tax: 4-8 L 20,000 + 8-12 L 40,000 = 60,000. Rebate 60,000. Nil.
    const n = compute({ income: { salaryGross: R(1275000) } }).regimes.new;
    expect(n.income.standardDeduction).toBe(R(75000));
    expect(n.totalIncome).toBe(R(1200000));
    expect(n.normalTax).toBe(R(60000));
    expect(n.rebate).toBe(R(60000));
    expect(n.cess).toBe(0);
    expect(n.taxLiabilityRounded).toBe(0);
    expect(n.interest.total).toBe(0);
    expect(n.balance).toBe(0);
  });

  it("salary ₹12,85,000: income ₹12,10,000 gets marginal relief, tax limited to the ₹10,000 above ₹12 lakh", () => {
    // TI 12,10,000. Tax 60,000 + 15% of 10,000 = 61,500. Excess over 12 L = 10,000 < 61,500, so
    // rebate (marginal relief) = 61,500 − 10,000 = 51,500. Tax 10,000 + cess 400 = 10,400.
    const n = compute({ income: { salaryGross: R(1285000) }, taxesPaid: { tdsTcs: R(10400) } }).regimes.new;
    expect(n.totalIncome).toBe(R(1210000));
    expect(n.normalTax).toBe(R(61500));
    expect(n.rebate).toBe(R(51500));
    expect(n.taxAfterRebate).toBe(R(10000));
    expect(n.cess).toBe(R(400));
    expect(n.taxLiabilityRounded).toBe(R(10400));
    expect(line(n, "tax.rebate").note).toContain("Marginal relief");
    expect(n.balance).toBe(0);
  });

  it("marginal relief ends where slab tax falls below the excess (about ₹12,70,588)", () => {
    // TI 12,70,000: tax 60,000 + 10,500 = 70,500 > 70,000 → relief 500, tax 70,000.
    const a = compute({ income: { businessProfession: R(1270000) } }).regimes.new;
    expect(a.rebate).toBe(R(500));
    expect(a.taxAfterRebate).toBe(R(70000));
    // TI 12,71,000: tax 60,000 + 10,650 = 70,650 < 71,000 → no relief.
    const b = compute({ income: { businessProfession: R(1271000) } }).regimes.new;
    expect(b.rebate).toBe(0);
    expect(b.taxAfterRebate).toBe(R(70650));
  });

  it("with special-rate gains, relief limits only the normal-rate tax; the gains' tax stays on top", () => {
    // Business 12,00,000 + STCG 10,000 = TI 12,10,000. Normal tax 60,000, cut to 10,000 (excess);
    // STCG 20% of 10,000 = 2,000 is never rebated. Tax 12,000 + cess 480 = 12,480.
    const n = compute({ income: { businessProfession: R(1200000), stcg111a: R(10000) } }).regimes.new;
    expect(n.rebate).toBe(R(50000));
    expect(n.specialTax).toBe(R(2000));
    expect(n.taxLiabilityRounded).toBe(R(12480));
  });
});

// -------------------------------------------------------------------------------------------------
// Both regimes side by side
// -------------------------------------------------------------------------------------------------

describe("both regimes side by side", () => {
  it("salary ₹15 lakh with full old-regime deductions: new regime saves ₹89,700", () => {
    // New: 15,00,000 − 75,000 = 14,25,000; tax 93,750 (see slabTax); cess 3,750 → 97,500.
    // Old: 15,00,000 − 50,000 = 14,50,000 − (80C 1,50,000 + 80CCD(1B) 50,000 + 80D 25,000) = 12,25,000;
    //      tax 12,500 + 1,00,000 + 30% of 2,25,000 (67,500) = 1,80,000; cess 7,200 → 1,87,200.
    // TDS 2,00,000 covers both, so no interest: refunds 1,02,500 (new) and 12,800 (old).
    const r = compute({
      income: { salaryGross: R(1500000) },
      deductions: { sec80CBasket: R(200000), sec80CCD1B: R(50000), sec80D: { selfFamily: R(25000) } },
      taxesPaid: { tdsTcs: R(200000) },
    });
    expect(r.regimes.new.totalIncome).toBe(R(1425000));
    expect(r.regimes.new.taxLiabilityRounded).toBe(R(97500));
    expect(r.regimes.new.deductions.notAllowedInRegime).toBe(R(275000));
    expect(r.regimes.old.deductions.total).toBe(R(225000));
    expect(r.regimes.old.deductions.lines.find((l) => l.code === "deduction.80c")?.note).toBe("Limited to ₹1,50,000.");
    expect(r.regimes.old.totalIncome).toBe(R(1225000));
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(187200));
    expect(r.regimes.new.refund).toBe(R(102500));
    expect(r.regimes.old.refund).toBe(R(12800));
    expect(r.recommendedRegime).toBe("new");
    expect(r.saving).toBe(R(89700));
    expect(r.comparison.note).toBe("The new regime saves ₹89,700 (tax and interest ₹97,500 against ₹1,87,200).");
  });

  it("a tie (both nil) goes to the default new regime", () => {
    const r = compute({ income: { salaryGross: R(500000) } });
    expect([r.regimes.new.taxLiabilityRounded, r.regimes.old.taxLiabilityRounded]).toEqual([0, 0]);
    expect(r.recommendedRegime).toBe("new");
    expect(r.saving).toBe(0);
  });

  it("old regime rebate edge: ₹5 lakh exactly is nil; no marginal relief above it", () => {
    // Salary 5,50,000 − 50,000 = 5,00,000; tax 12,500; rebate 12,500 → nil.
    expect(compute({ income: { salaryGross: R(550000) } }).regimes.old.taxLiabilityRounded).toBe(0);
    // Business 5,10,000: tax 12,500 + 20% of 10,000 = 14,500, no rebate; cess 580 → 15,080.
    const o = compute({ income: { businessProfession: R(510000) } }).regimes.old;
    expect(o.rebate).toBe(0);
    expect(o.taxLiabilityRounded).toBe(R(15080));
  });

  it("senior citizen (60-79), old regime: ₹3 lakh exemption, 80D and 80TTB senior caps, no advance tax", () => {
    // Pension 9,00,000 − 50,000 = 8,50,000 + interest 1,20,000 = GTI 9,70,000.
    // 80C 1,50,000 + 80D 50,000 (60,000 claimed, senior cap) + 80TTB 50,000 (70,000 claimed) = 2,50,000.
    // TI 7,20,000: 5% of 2,00,000 (10,000) + 20% of 2,20,000 (44,000) = 54,000; cess 2,160 → 56,160.
    // A resident senior with no business income pays no advance tax: no 234B/234C.
    const deductions = { sec80CBasket: R(150000), sec80D: { selfFamily: R(60000) }, sec80TTA_TTB: R(70000) };
    const s = compute({ ageBand: "60_to_79", income: { salaryGross: R(900000), otherSources: R(120000) }, deductions });
    const o = s.regimes.old;
    expect(o.deductions.total).toBe(R(250000));
    expect(o.deductions.lines.find((l) => l.code === "deduction.80tta_ttb")?.label).toBe("Interest (80TTB)");
    expect(o.totalIncome).toBe(R(720000));
    expect(o.normalTax).toBe(R(54000));
    expect(o.taxLiabilityRounded).toBe(R(56160));
    expect(o.interest.s234B.applies).toBe(false);
    expect(o.interest.s234C.interest).toBe(0);
    expect(o.interest.s234B.reason).toContain("resident senior citizen");
    // New regime: 8,25,000 + 1,20,000 = 9,45,000; tax 34,500 rebated in full → nil, recommended.
    expect(s.regimes.new.taxLiabilityRounded).toBe(0);
    expect(s.recommendedRegime).toBe("new");
    // The same person below 60: 80D cap 25,000, 80TTA cap 10,000 → deductions 1,85,000, TI 7,85,000;
    // tax 12,500 + 20% of 2,85,000 (57,000) = 69,500; cess 2,780 → 72,280.
    const y = compute({ ageBand: "below_60", income: { salaryGross: R(900000), otherSources: R(120000) }, deductions }).regimes.old;
    expect(y.deductions.total).toBe(R(185000));
    expect(y.taxLiabilityRounded).toBe(R(72280));
  });

  it("super senior citizen (80+), old regime: ₹5 lakh exemption, then 20%", () => {
    // Pension 7,50,000 − 50,000 = 7,00,000; 20% of 2,00,000 = 40,000; cess 1,600 → 41,600.
    expect(compute({ ageBand: "80_plus", income: { salaryGross: R(750000) } }).regimes.old.taxLiabilityRounded).toBe(R(41600));
  });

  it("house-property loss: old regime sets off up to ₹2 lakh and carries the rest; new regime allows none", () => {
    // Old: 14,50,000 − 2,00,000 = 12,50,000; tax 1,12,500 + 75,000 = 1,87,500; cess 7,500 → 1,95,000.
    const r = compute({ income: { salaryGross: R(1500000), houseProperty: -R(300000) } });
    expect(r.regimes.old.income.houseProperty).toEqual({ entered: -R(300000), allowed: -R(200000), lossSetOff: R(200000), lossCarriedForward: R(100000), lossNotAllowed: 0 });
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(195000));
    expect(r.regimes.new.income.houseProperty.lossNotAllowed).toBe(R(300000));
    expect(r.regimes.new.totalIncome).toBe(R(1425000));
  });

  it("Chapter VI-A deductions never reduce special-rate gains; a resident's unused exemption does", () => {
    // Old: other sources 1,00,000 + STCG 5,00,000; 80C 1,50,000 limited to 1,00,000 → TI 5,00,000.
    // Normal income nil, so 2,50,000 of exemption goes against STCG: 20% of 2,50,000 = 50,000.
    // Old-regime rebate is allowed against s.111A tax (only s.112A is excluded): 50,000 − 12,500 =
    // 37,500; cess 1,500 → 39,000.
    const r = compute({ income: { otherSources: R(100000), stcg111a: R(500000) }, deductions: { sec80CBasket: R(150000) } });
    const o = r.regimes.old;
    expect(o.deductions.total).toBe(R(100000));
    expect(o.deductions.limitedToNormalIncome).toBe(true);
    expect(o.special[0]).toMatchObject({ kind: "111A", basicExemptionUsed: R(250000), taxable: R(250000), tax: R(50000) });
    expect(o.rebate).toBe(R(12500));
    expect(o.taxLiabilityRounded).toBe(R(39000));
    // New: TI 6,00,000; 3,00,000 of the ₹4 lakh exemption against STCG → 20% of 2,00,000 = 40,000,
    // never rebated; cess 1,600 → 41,600.
    expect(r.regimes.new.rebate).toBe(0);
    expect(r.regimes.new.taxLiabilityRounded).toBe(R(41600));
  });

  it("a HUF gets no rebate and no senior slabs; a non-resident gets no rebate", () => {
    // HUF, business 7,00,000. New: 5% of 3,00,000 = 15,000 + cess 600 = 15,600 (no rebate).
    const h = compute({ assesseeType: "huf", ageBand: "80_plus", income: { businessProfession: R(700000) } });
    expect(h.regimes.new.rebate).toBe(0);
    expect(h.regimes.new.taxLiabilityRounded).toBe(R(15600));
    // Old: 12,500 + 20% of 2,00,000 = 52,500 + 2,100 = 54,600 (normal slabs despite the age band).
    expect(h.regimes.old.taxLiabilityRounded).toBe(R(54600));
    const nr = compute({ resident: false, income: { salaryGross: R(1275000) } });
    expect(nr.regimes.new.rebate).toBe(0);
    expect(nr.regimes.new.taxLiabilityRounded).toBe(R(62400));
    expect(nr.notes.some((n) => n.startsWith("Non-resident"))).toBe(true);
  });

  it("employer NPS 80CCD(2) is allowed in both regimes: 14% (new) / 10% (old) of basic + DA", () => {
    // Salary 20,00,000, basic + DA 10,00,000, employer NPS 1,50,000.
    // New cap 14% = 1,40,000; old cap 10% = 1,00,000.
    const r = compute({ income: { salaryGross: R(2000000) }, deductions: { employerNps80CCD2: R(150000), basicPlusDa: R(1000000) } });
    expect(r.regimes.new.deductions.total).toBe(R(140000));
    expect(r.regimes.old.deductions.total).toBe(R(100000));
    const g = compute({ income: { salaryGross: R(2000000) }, deductions: { employerNps80CCD2: R(150000), basicPlusDa: R(1000000), governmentEmployer: true } });
    expect(g.regimes.old.deductions.total).toBe(R(140000));
  });
});

// -------------------------------------------------------------------------------------------------
// Surcharge, its caps and marginal relief
// -------------------------------------------------------------------------------------------------

describe("surcharge (§6.11)", () => {
  it("₹60 lakh: 10% surcharge, no marginal relief", () => {
    // New: 3,00,000 (to 24 L) + 30% of 36,00,000 (10,80,000) = 13,80,000; surcharge 1,38,000;
    //      cess 4% of 15,18,000 = 60,720 → 15,78,720.
    // Old: 1,12,500 + 30% of 50,00,000 (15,00,000) = 16,12,500; surcharge 1,61,250; cess 70,950 → 18,44,700.
    const r = compute({ income: { businessProfession: R(6000000) } });
    expect(r.regimes.new.surcharge).toEqual({ rate: 10, threshold: R(5000000), gross: R(138000), marginalRelief: 0, net: R(138000) });
    expect(r.regimes.new.taxLiabilityRounded).toBe(R(1578720));
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(1844700));
  });

  it("₹50,10,000: marginal relief at ₹50 lakh keeps tax + surcharge to tax on ₹50 lakh + ₹10,000", () => {
    // New: tax 10,83,000; surcharge 1,08,300. Tax on 50 L = 10,80,000; ceiling 10,90,000.
    //      Relief = 11,91,300 − 10,90,000 = 1,01,300; net surcharge 7,000; cess 43,600 → 11,33,600.
    const r = compute({ income: { businessProfession: R(5010000) } });
    const n = r.regimes.new;
    expect(n.normalTax).toBe(R(1083000));
    expect(n.surcharge.gross).toBe(R(108300));
    expect(n.surcharge.marginalRelief).toBe(R(101300));
    expect(n.surcharge.net).toBe(R(7000));
    expect(n.taxLiabilityRounded).toBe(R(1133600));
    expect(line(n, "tax.marginal_relief").note).toContain("ceiling is ₹10,90,000");
    // Old: tax 13,15,500; surcharge 1,31,550; ceiling 13,12,500 + 10,000 = 13,22,500;
    //      relief 1,24,550; cess 52,900 → 13,75,400.
    expect(r.regimes.old.surcharge.marginalRelief).toBe(R(124550));
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(1375400));
  });

  it("₹2.5 crore: 25% in both regimes", () => {
    // New: 3,00,000 + 30% of 2,26,00,000 = 70,80,000; surcharge 17,70,000; cess 3,54,000 → 92,04,000.
    // Old: 1,12,500 + 30% of 2,40,00,000 = 73,12,500; surcharge 18,28,125; cess 3,65,625 → 95,06,250.
    const r = compute({ income: { businessProfession: R(25000000) } });
    expect(r.regimes.new.surcharge.rate).toBe(25);
    expect(r.regimes.old.surcharge.rate).toBe(25);
    expect(r.regimes.new.taxLiabilityRounded).toBe(R(9204000));
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(9506250));
    expect(r.recommendedRegime).toBe("new");
  });

  it("₹6 crore: old regime 37%, new regime capped at 25%", () => {
    // New: 3,00,000 + 30% of 5,76,00,000 = 1,75,80,000; 25% = 43,95,000; cess 8,79,000 → 2,28,54,000.
    // Old: 1,12,500 + 30% of 5,90,00,000 = 1,78,12,500; 37% = 65,90,625; cess 9,76,125 → 2,53,79,250.
    const r = compute({ income: { businessProfession: R(60000000) } });
    expect(r.regimes.new.surcharge).toMatchObject({ rate: 25, gross: R(4395000) });
    expect(r.regimes.old.surcharge).toMatchObject({ rate: 37, gross: R(6590625) });
    expect(r.regimes.new.taxLiabilityRounded).toBe(R(22854000));
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(25379250));
  });

  it("₹5,00,10,000, old regime: marginal relief at ₹5 crore", () => {
    // Tax 1,48,15,500; 37% = 54,81,735. On 5 Cr: 1,48,12,500 + 25% (37,03,125) = 1,85,15,625;
    // ceiling 1,85,25,625. Relief = 2,02,97,235 − 1,85,25,625 = 17,71,610. Cess 7,41,025 → 1,92,66,650.
    const o = compute({ income: { businessProfession: R(50010000) } }).regimes.old;
    expect(o.surcharge.marginalRelief).toBe(R(1771610));
    expect(o.taxLiabilityRounded).toBe(R(19266650));
  });

  it("surcharge on capital-gains tax is capped at 15%", () => {
    // New: business 1,50,00,000 + STCG 1,00,00,000 = 2.5 Cr (25% band).
    // Normal tax 3,00,000 + 30% of 1,26,00,000 = 40,80,000 → 25% = 10,20,000.
    // STCG 20% of 1 Cr = 20,00,000 → capped 15% = 3,00,000. Surcharge 13,20,000.
    // Cess 4% of 74,00,000 = 2,96,000 → 76,96,000.
    const n = compute({ income: { businessProfession: R(15000000), stcg111a: R(10000000) } }).regimes.new;
    expect(n.surcharge.gross).toBe(R(1320000));
    expect(n.surcharge.marginalRelief).toBe(0);
    expect(n.taxLiabilityRounded).toBe(R(7696000));
  });

  it("surcharge on dividends is capped at 15% (dividends taken as the top slice)", () => {
    // Old: other sources 5.5 Cr incl. dividends 1 Cr. Tax 1,12,500 + 30% of 5,40,00,000 = 1,63,12,500.
    // Dividend tax 30% of 1 Cr = 30,00,000 at 15% = 4,50,000; the rest 1,33,12,500 at 37% = 49,25,625.
    // Surcharge 53,75,625; cess 4% of 2,16,88,125 = 8,67,525 → 2,25,55,650.
    const o = compute({ income: { otherSources: R(55000000), dividends: R(10000000) } }).regimes.old;
    expect(o.surcharge.gross).toBe(R(5375625));
    expect(o.taxLiabilityRounded).toBe(R(22555650));
  });
});

// -------------------------------------------------------------------------------------------------
// Capital gains at special rates
// -------------------------------------------------------------------------------------------------

describe("capital gains (§6.11)", () => {
  it("LTCG s.112A: 12.5% above ₹1.25 lakh; income over ₹12 lakh, so no rebate", () => {
    // Salary 10,75,000 − 75,000 = 10,00,000 + LTCG 3,25,000 = TI 13,25,000 (> 12 L).
    // Normal tax 20,000 + 20,000 = 40,000; excess 1,25,000 > 40,000, no relief.
    // LTCG (3,25,000 − 1,25,000) × 12.5% = 25,000. Tax 65,000 + cess 2,600 = 67,600.
    const n = compute({ income: { salaryGross: R(1075000), ltcg112a: R(325000) } }).regimes.new;
    expect(n.totalIncome).toBe(R(1325000));
    expect(n.special.find((s) => s.kind === "112A")).toMatchObject({ exemption: R(125000), taxable: R(200000), tax: R(25000) });
    expect(n.rebate).toBe(0);
    expect(n.taxLiabilityRounded).toBe(R(67600));
  });

  it("STCG s.111A: the rebate covers slab tax only, never the 20% on the gain", () => {
    // Salary 9,75,000 − 75,000 = 9,00,000 + STCG 1,00,000 = TI 10,00,000 (≤ 12 L).
    // Slab tax 20,000 + 10,000 = 30,000, rebated. STCG 20,000 stays; cess 800 → 20,800.
    const n = compute({ income: { salaryGross: R(975000), stcg111a: R(100000) } }).regimes.new;
    expect(n.normalTax).toBe(R(30000));
    expect(n.rebate).toBe(R(30000));
    expect(n.specialTax).toBe(R(20000));
    expect(n.taxLiabilityRounded).toBe(R(20800));
    expect(line(n, "tax.rebate").note).toContain("not against tax under s.111A, s.112, s.112A");
  });

  it("LTCG s.112A alone: exemption, then the unused basic exemption, then 12.5%; no rebate against it", () => {
    // New: 6,00,000 − 1,25,000 − 4,00,000 = 75,000 × 12.5% = 9,375; cess 375 → 9,750.
    // Old: 6,00,000 − 1,25,000 − 2,50,000 = 2,25,000 × 12.5% = 28,125; TI 6 L > 5 L; cess 1,125 → 29,250.
    const r = compute({ income: { ltcg112a: R(600000) } });
    expect(r.regimes.new.special[1]).toMatchObject({ kind: "112A", exemption: R(125000), basicExemptionUsed: R(400000), tax: R(9375) });
    expect(r.regimes.new.taxLiabilityRounded).toBe(R(9750));
    expect(r.regimes.old.taxLiabilityRounded).toBe(R(29250));
  });

  it("FY 2024-25: transfers before 23 Jul 2024 use the earlier rates (s.111A 15%)", () => {
    // Salary 15,75,000 − 75,000 = 15,00,000; STCG 1,00,000 (from 23 Jul) + 1,00,000 (before).
    // FY 2024-25 new slabs on 15 L: 20,000 + 30,000 + 30,000 + 60,000 = 1,40,000.
    // STCG 20,000 + 15,000 = 35,000. Tax 1,75,000 + cess 7,000 = 1,82,000.
    const n = compute(
      { income: { salaryGross: R(1575000), stcg111a: R(100000), earlierTransfers: { stcg111a: R(100000) } } },
      ITR_RULESET_FY2024_25,
      DATES_FY24,
    ).regimes.new;
    expect(n.normalTax).toBe(R(140000));
    expect(n.special.filter((s) => s.income > 0).map((s) => [s.period, s.rate, s.tax])).toEqual([
      ["current", 20, R(20000)],
      ["earlier", 15, R(15000)],
    ]);
    expect(n.taxLiabilityRounded).toBe(R(182000));
    expect(line(n, "income.capital_gains.111A.earlier").label).toContain("transfers before 23 Jul 2024");
  });
});

// -------------------------------------------------------------------------------------------------
// FY 2024-25 new regime: the ₹7 lakh rebate edge
// -------------------------------------------------------------------------------------------------

describe("FY 2024-25 new regime (§6.11)", () => {
  it("salary ₹7,75,000: income ₹7 lakh, tax ₹20,000 fully rebated", () => {
    // 7,75,000 − 75,000 = 7,00,000; 5% of 4,00,000 = 20,000; rebate 20,000 → nil.
    const r = compute({ income: { salaryGross: R(775000) } }, ITR_RULESET_FY2024_25, DATES_FY24);
    expect(r.regimes.new.normalTax).toBe(R(20000));
    expect(r.regimes.new.taxLiabilityRounded).toBe(0);
    expect(r.yearLabel).toBe("AY 2025-26");
  });

  it("salary ₹7,85,000: income ₹7,10,000, marginal relief limits tax to ₹10,000", () => {
    // Tax 20,000 + 10% of 10,000 = 21,000; excess 10,000 → rebate 11,000; cess 400 → 10,400.
    const n = compute({ income: { salaryGross: R(785000) } }, ITR_RULESET_FY2024_25, DATES_FY24).regimes.new;
    expect(n.totalIncome).toBe(R(710000));
    expect(n.rebate).toBe(R(11000));
    expect(n.taxLiabilityRounded).toBe(R(10400));
  });

  it("the same ₹12 lakh income is taxed under the FY 2024-25 slabs with no rebate", () => {
    // 12,75,000 − 75,000 = 12,00,000: 20,000 + 30,000 + 30,000 = 80,000; cess 3,200 → 83,200.
    const n = compute({ income: { salaryGross: R(1275000) } }, ITR_RULESET_FY2024_25, DATES_FY24).regimes.new;
    expect(n.rebate).toBe(0);
    expect(n.taxLiabilityRounded).toBe(R(83200));
  });
});

// -------------------------------------------------------------------------------------------------
// Interest u/s 234A / 234B / 234C
// -------------------------------------------------------------------------------------------------

describe("interest u/s 234A, 234B, 234C (§6.11)", () => {
  // New regime, business 20,00,000: tax 20,000 + 40,000 + 60,000 + 80,000 = 2,00,000; cess 8,000 → 2,08,000.
  const business = { businessProfession: R(2000000) };
  const advance = { q1: R(20000), q2: R(40000), q3: R(50000), q4: R(30000) }; // 1,40,000 in all

  it("234C instalment shortfalls and 234B up to a self-assessment payment", () => {
    // 234C on 2,08,000: 15 Jun 15% = 31,200 − 20,000 (12% = 24,960 not met) = 11,200 × 3% = 336;
    //   15 Sep 45% = 93,600 − 60,000 (36% = 74,880 not met) = 33,600 × 3% = 1,008;
    //   15 Dec 75% = 1,56,000 − 1,10,000 = 46,000 × 3% = 1,380; 15 Mar 2,08,000 − 1,40,000 = 68,000 × 1% = 680.
    //   Total 3,404.
    // 234B: 1,40,000 < 90% of 2,08,000 (1,87,200). Shortfall 68,000, paid 10 Jun 2026: Apr, May, Jun
    //   = 3 months × 1% = 2,040.
    // Balance 2,08,000 + 2,040 + 3,404 − 2,08,000 = 5,444 → 5,440 (s.288B).
    const n = compute(
      { income: business, taxesPaid: { advanceTax: advance, selfAssessment: [{ amount: R(68000), paidOn: "2026-06-10" }] } },
      ITR_RULESET_FY2025_26,
      { filingDate: "2026-07-31", dueDate: "2026-07-31" },
    ).regimes.new;
    expect(n.taxLiabilityRounded).toBe(R(208000));
    expect(n.interest.s234C.instalments.map((i) => [i.dueDate, i.base, i.months, i.interest])).toEqual([
      ["2025-06-15", R(11200), 3, R(336)],
      ["2025-09-15", R(33600), 3, R(1008)],
      ["2025-12-15", R(46000), 3, R(1380)],
      ["2026-03-15", R(68000), 1, R(680)],
    ]);
    expect(n.interest.s234C.interest).toBe(R(3404));
    expect(n.interest.s234B.segments).toEqual([{ from: "2026-04-01", to: "2026-06-10", months: 3, shortfall: R(68000), base: R(68000), interest: R(2040) }]);
    expect(n.interest.s234A.applies).toBe(false);
    expect(n.balance).toBe(R(5440));
  });

  it("234C safe harbours: 12% by 15 June and 36% by 15 September mean no interest for those instalments", () => {
    // 25,000 ≥ 24,960 (12%) and 75,000 ≥ 74,880 (36%), though below 15% / 45%; then 75% and 100% paid.
    const n = compute(
      { income: business, taxesPaid: { advanceTax: { q1: R(25000), q2: R(50000), q3: R(81000), q4: R(52000) } } },
      ITR_RULESET_FY2025_26,
      { filingDate: "2026-07-31", dueDate: "2026-07-31" },
    ).regimes.new;
    expect(n.interest.s234C.instalments.map((i) => i.safeHarbourMet)).toEqual([true, true, false, false]);
    expect(n.interest.s234C.interest).toBe(0);
    expect(n.interest.s234B.applies).toBe(false);
    expect(n.balance).toBe(0);
  });

  it("late return: 234A from the day after the due date, 234B to the filing date", () => {
    // Filed 20 Sep 2026, due 31 Jul 2026, no self-assessment tax. Unpaid 68,000.
    // 234A: 1 Aug - 20 Sep = 2 months × 1% × 68,000 = 1,360.
    // 234B: 1 Apr - 20 Sep = 6 months × 1% × 68,000 = 4,080. 234C as before 3,404.
    // Balance 2,08,000 + 8,844 − 1,40,000 = 76,844 → 76,840.
    const n = compute({ income: business, taxesPaid: { advanceTax: advance } }, ITR_RULESET_FY2025_26, {
      filingDate: "2026-09-20",
      dueDate: "2026-07-31",
    }).regimes.new;
    expect(n.interest.s234A).toMatchObject({ applies: true, base: R(68000), from: "2026-08-01", months: 2, interest: R(1360) });
    expect(n.interest.s234B.interest).toBe(R(4080));
    expect(n.interest.total).toBe(R(8844));
    expect(n.balance).toBe(R(76840));
    expect(n.payable).toBe(R(76840));
  });

  it("234A after an extended due date counts months from the day after it", () => {
    // Due 15 Sep 2026 (extended), filed 16 Oct 2026: 16 Sep - 15 Oct = 1, 16 Oct = part → 2 months.
    const a = interest234A(
      { tax: R(50000), advanceTax: 0, tdsTcs: R(20000), selfAssessment: [{ amount: R(5050), paidOn: "2026-09-10" }], dueDate: "2026-09-15", filingDate: "2026-10-16" },
      ITR_RULESET_FY2025_26.interest,
    );
    // Unpaid 50,000 − 20,000 − 5,050 = 24,950 → rounded down to 24,900 × 2% = 498.
    expect(a).toMatchObject({ from: "2026-09-16", months: 2, base: R(24900), interest: R(498) });
  });

  it("no advance tax (so no 234B/234C) when tax less TDS is below ₹10,000", () => {
    // Salary 12,85,000 → tax 10,400 (see above); TDS 1,000 → 9,400 < 10,000.
    const n = compute({ income: { salaryGross: R(1285000) }, taxesPaid: { tdsTcs: R(1000) } }).regimes.new;
    expect(n.interest.s234B.applies).toBe(false);
    expect(n.interest.s234C.interest).toBe(0);
    expect(n.interest.s234B.reason).toContain("below ₹10,000");
  });

  it("presumptive income: one instalment of 100% by 15 March", () => {
    const c = interest234C(
      { liable: true, taxDue: R(208000), advanceTax: { q4: R(150000) }, presumptive: true, financialYear: "2025-26" },
      ITR_RULESET_FY2025_26.interest,
    );
    // 2,08,000 − 1,50,000 = 58,000 × 1% = 580.
    expect(c.instalments).toHaveLength(1);
    expect(c.instalments[0]).toMatchObject({ dueDate: "2026-03-15", base: R(58000), months: 1, interest: R(580) });
  });

  it("234B: advance tax paid in late March counts; nothing before 1 April of the next year", () => {
    const b = interest234B(
      { liable: true, assessedTax: R(100000), advanceTaxPaid: R(95000), selfAssessment: [], financialYear: "2025-26", filingDate: "2026-07-31" },
      ITR_RULESET_FY2025_26.interest,
    );
    expect(b.applies).toBe(false);
    const early = interest234B(
      { liable: true, assessedTax: R(100000), advanceTaxPaid: 0, selfAssessment: [], financialYear: "2026-27", filingDate: "2026-10-22" },
      ITR_RULESET_FY2026_27.interest,
    );
    expect(early.interest).toBe(0);
    expect(early.reason).toContain("1 Apr 2027");
  });
});

// -------------------------------------------------------------------------------------------------
// Statute labels (§6.1), validation and determinism
// -------------------------------------------------------------------------------------------------

describe("statute labels (§6.1)", () => {
  it("1961-Act years say AY and cite the 1961 sections", () => {
    const r = compute({ income: { salaryGross: R(1000000) } });
    expect(r.yearLabel).toBe("AY 2026-27");
    expect(r.actName).toBe("Income-tax Act, 1961");
    expect(line(r.regimes.new, "interest.234B").section?.label).toBe("s.234B");
    expect(line(r.regimes.new, "tax.rebate").section?.label).toBe("s.87A");
  });

  it("tax year 2026-27 cites ss.423/424/425 and s.156 as unverified; PDFs print the old section", () => {
    const r = compute({ income: { salaryGross: R(1000000) } }, ITR_RULESET_FY2026_27, { filingDate: "2027-07-15", dueDate: "2027-07-31" });
    expect(r.yearLabel).toBe("Tax year 2026-27");
    expect(r.actName).toBe("Income-tax Act, 2025");
    const s234C = line(r.regimes.new, "interest.234C").section;
    expect(s234C?.label).toBe("s.425 (s.234C of the 1961 Act; mapping not yet verified)");
    expect(s234C?.pdfLabel).toBe("s.234C (corresponding provision of the Income-tax Act, 2025)");
    expect(s234C?.verified).toBe(false);
    expect(sectionCite(ITR_RULESET_FY2026_27, "interest234A").label).toContain("s.423");
    expect(sectionCite(ITR_RULESET_FY2026_27, "rebate").label).toContain("s.156");
    expect(r.notes.some((n) => n.includes("not yet confirmed"))).toBe(true);
    // Once a Partner verifies the mapping, the 2025 number stands alone.
    expect(sectionLabel({ act1961: "234B", act2025: "424", verified: true }, "2025", "pdf")).toBe("s.424");
    expect(sectionLabel({ act1961: "80D", act2025: null, verified: false }, "2025", "screen")).toBe("s.80D (corresponding provision of the Income-tax Act, 2025)");
    expect(itrYearLabel({ financialYear: "2024-25", statute: "1961" })).toBe("AY 2025-26");
  });
});

describe("validation and determinism", () => {
  it("rejects inputs the engine can't compute, with field errors", () => {
    const errors = validateItrInputs(
      inputs({
        financialYear: "2024-25",
        income: { salaryGross: R(100000), dividends: R(5000), otherSources: R(1000), stcg111a: -1, earlierTransfers: { ltcg112: R(1000) } },
        taxesPaid: { selfAssessment: [{ amount: R(100), paidOn: "2026-03-01" }] },
      }),
      ITR_RULESET_FY2025_26,
      { filingDate: "2026-07-31", dueDate: "2026-03-31" },
    );
    expect(Object.keys(errors).sort()).toEqual([
      "dueDate",
      "financialYear",
      "income.dividends",
      "income.earlierTransfers",
      "income.stcg111a",
      "taxesPaid.selfAssessment.0.paidOn",
    ]);
    expect(() => compute({ assesseeType: "huf", income: { salaryGross: R(100000) } })).toThrow(ItrInputError);
    let caught: unknown = null;
    try {
      compute({ income: { salaryGross: 10.5 } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ItrInputError);
    expect((caught as ItrInputError).fieldErrors["income.salaryGross"]).toEqual(["Enter the amount in rupees and paise."]);
    expect((caught as ItrInputError).message).toBe("Enter the amount in rupees and paise.");
  });

  it("is deterministic and explains every line in whole paise", () => {
    const over: Partial<ItrInputs> = {
      income: { salaryGross: R(1834567) + 89, houseProperty: -R(12345), otherSources: R(54321), dividends: R(10000), stcg111a: R(33333), ltcg112a: R(222222) },
      deductions: { sec80CBasket: R(150000), sec80D: { selfFamily: R(30000), parents: R(55000), parentsSenior: true } },
      taxesPaid: { tdsTcs: R(150000), advanceTax: { q3: R(20000) } },
    };
    const a = compute(over, ITR_RULESET_FY2025_26, { filingDate: "2026-08-20", dueDate: "2026-07-31" });
    const b = compute(over, ITR_RULESET_FY2025_26, { filingDate: "2026-08-20", dueDate: "2026-07-31" });
    expect(a).toEqual(b);
    for (const c of [a.regimes.new, a.regimes.old]) {
      for (const l of c.lines) expect(Number.isSafeInteger(l.amount)).toBe(true);
      expect(c.totalIncome % 1000).toBe(0); // s.288A: nearest ₹10
      expect(c.taxLiabilityRounded % 1000).toBe(0); // s.288B
      expect(c.balance % 1000).toBe(0);
      expect(c.lines.map((l) => l.code)).toEqual(expect.arrayContaining(["gti", "total_income", "tax.normal", "tax.special", "tax.rebate", "tax.surcharge", "tax.cess", "interest.234A", "interest.234B", "interest.234C", "paid.total", "balance"]));
    }
    // Old regime 80D: self 25,000 (cap) + senior parents 50,000 (cap) = 75,000.
    expect(a.regimes.old.deductions.lines.find((l) => l.code === "deduction.80d")?.allowed).toBe(R(75000));
  });
});

// -------------------------------------------------------------------------------------------------
// Seed file (supabase/seed/41_itr_rulesets.sql) matches the TS seed rows (§16)
// -------------------------------------------------------------------------------------------------

type SqlRow = { key: string; value: unknown; effectiveFrom: string; effectiveTo: string | null; verified: boolean; rest: string };

function readSeedRows(): { sql: string; rows: SqlRow[] } {
  const sql = readFileSync(join(process.cwd(), "supabase/seed/41_itr_rulesets.sql"), "utf8");
  const ROW = /^\s*\('([^']+)', '((?:[^']|'')*)'::jsonb, '(\d{4}-\d{2}-\d{2})', (null|'\d{4}-\d{2}-\d{2}'), (.*), (true|false)\),?$/;
  const rows: SqlRow[] = [];
  for (const l of sql.split("\n")) {
    const m = ROW.exec(l);
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

const sqlQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

describe("seed SQL 41_itr_rulesets.sql (§16)", () => {
  const { sql, rows } = readSeedRows();
  const expected: readonly SeedParameterRow[] = ITR_RULESET_SEED_PARAMETERS;

  it("has exactly the TS seed rows: one itr.ruleset per FY, 1 April to 31 March", () => {
    expect(rows.length).toBe(3);
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
      expect(parseRuleSet(row.value).ok).toBe(true);
    });
    expect(rows.map((r) => [r.key, r.effectiveFrom, r.effectiveTo, r.verified])).toEqual([
      [ITR_RULESET_PARAM_KEY, "2024-04-01", "2025-03-31", true],
      [ITR_RULESET_PARAM_KEY, "2025-04-01", "2026-03-31", true],
      [ITR_RULESET_PARAM_KEY, "2026-04-01", "2027-03-31", false],
    ]);
  });

  it("names the statute per year and flags the [verify] row", () => {
    expect(expected.map((r) => r.statute)).toEqual(["Income-tax Act, 1961", "Income-tax Act, 1961", "Income-tax Act, 2025"]);
    for (const r of expected) {
      expect(r.sourceRef.length).toBeGreaterThan(0);
      if (`${r.notes} ${r.sectionRef}`.includes("[verify]")) expect(r.verified).toBe(false);
      if (!r.verified) expect(`${r.notes} ${r.sectionRef}`).toContain("[verify]");
    }
  });

  it("only inserts statutory_parameters, idempotently", () => {
    expect(sql.match(/insert into/gi)?.length).toBe(1);
    expect(sql).toContain("insert into public.statutory_parameters");
    expect(sql).toContain("on conflict (key, effective_from) do nothing;");
    expect(Array.from(new Set(sql.match(/\b(public|auth)\.[a-z_]+/g)))).toEqual(["public.statutory_parameters"]);
  });
});

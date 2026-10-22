import { describe, expect, it } from "vitest";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { toPaise } from "@/lib/domain/money";
import {
  amountInPlainWords,
  gstSchemeDecision,
  normaliseStateCode,
  QRMP_22ND_STATE_CODES,
  qrmpGstr3bDay,
  resolveScaleParams,
  resolveStateDay,
  SCALE_DEFAULTS,
  SCALE_PARAM_KEYS,
  SCALE_SEED_PARAMETERS,
  TAX_AUDIT_DISCLAIMER,
  taxAuditIndication,
  type TaxAuditInput,
} from "@/lib/domain/scale";

const rupees = (r: number) => toPaise(r);
const LAKH = 1_00_000;
const CRORE = 1_00_00_000;

function sentenceCheck(reasons: string[]) {
  expect(reasons.length).toBeGreaterThan(0);
  for (const r of reasons) {
    expect(r).toMatch(/^[A-Z]/);
    expect(r).toMatch(/\.$/);
  }
}

describe("amountInPlainWords", () => {
  it("names round crore and lakh amounts", () => {
    expect(amountInPlainWords(rupees(5 * CRORE))).toBe("₹5 crore");
    expect(amountInPlainWords(rupees(1.25 * CRORE))).toBe("₹1.25 crore");
    expect(amountInPlainWords(rupees(1.2 * CRORE))).toBe("₹1.2 crore");
    expect(amountInPlainWords(rupees(75 * LAKH))).toBe("₹75 lakh");
    expect(amountInPlainWords(rupees(2.5 * LAKH))).toBe("₹2.5 lakh");
    expect(amountInPlainWords(rupees(10 * CRORE))).toBe("₹10 crore");
  });

  it("shows other amounts in full, so a figure under a limit never reads as the limit", () => {
    expect(amountInPlainWords(rupees(1_23_45_678))).toBe("₹1,23,45,678");
    expect(amountInPlainWords(rupees(99_99_999))).toBe("₹99,99,999");
    expect(amountInPlainWords(rupees(45_600))).toBe("₹45,600");
    expect(amountInPlainWords(toPaise("1234.50"))).toBe("₹1,234.50");
    expect(amountInPlainWords(0)).toBe("₹0");
  });
});

describe("gstSchemeDecision (§6.6)", () => {
  it("defaults to monthly when no turnover is recorded: over-filing is safer", () => {
    const d = gstSchemeDecision(null, null);
    expect(d).toMatchObject({ scheme: "monthly", basis: "no_turnover", qrmpEligible: null });
    expect(d.explanation).toContain("over-filing is safer than a missed return");
    expect(d.warning).toBeUndefined();
  });

  it("keeps a recorded choice when no turnover is recorded, warning that QRMP eligibility is unchecked", () => {
    const q = gstSchemeDecision(null, "qrmp");
    expect(q).toMatchObject({ scheme: "qrmp", basis: "choice", qrmpEligible: null });
    expect(q.warning).toContain("₹5 crore");
    expect(gstSchemeDecision(null, "monthly")).toMatchObject({ scheme: "monthly", basis: "choice" });
  });

  it("makes QRMP the automatic answer up to and including ₹5 crore", () => {
    const d = gstSchemeDecision(rupees(3 * CRORE), null);
    expect(d).toMatchObject({ scheme: "qrmp", basis: "turnover", qrmpEligible: true });
    expect(d.explanation).toBe(
      "Turnover of ₹3 crore is within ₹5 crore, so the client is eligible for QRMP: GSTR-1 and GSTR-3B are filed quarterly, and tax is paid monthly through PMT-06. Choose Monthly if the client prefers to file every month.",
    );
    expect(gstSchemeDecision(rupees(5 * CRORE), null).scheme).toBe("qrmp");
    expect(gstSchemeDecision(0, null).scheme).toBe("qrmp");
  });

  it("makes monthly mandatory above ₹5 crore, whatever was recorded", () => {
    const justAbove = gstSchemeDecision(rupees(5 * CRORE) + 1, null);
    expect(justAbove).toMatchObject({ scheme: "monthly", basis: "turnover", qrmpEligible: false });
    const chosen = gstSchemeDecision(rupees(6 * CRORE), "qrmp");
    expect(chosen.scheme).toBe("monthly");
    expect(chosen.explanation).toBe("Turnover of ₹6 crore is above ₹5 crore, so monthly filing is mandatory.");
    expect(chosen.warning).toContain("QRMP isn't available above ₹5 crore");
  });

  it("lets a client below the limit opt for monthly, and records the choice as the basis", () => {
    const d = gstSchemeDecision(rupees(2 * CRORE), "monthly");
    expect(d).toMatchObject({ scheme: "monthly", basis: "choice", qrmpEligible: true });
    expect(d.explanation).toContain("chosen to file monthly");
    expect(gstSchemeDecision(rupees(2 * CRORE), "qrmp")).toMatchObject({ scheme: "qrmp", basis: "choice" });
  });

  it("reads the limit from params, not from the code", () => {
    expect(gstSchemeDecision(rupees(6 * CRORE), null, { qrmpMaxTurnoverPaise: rupees(10 * CRORE) }).scheme).toBe("qrmp");
  });

  it("refuses a turnover that isn't whole, non-negative paise", () => {
    expect(() => gstSchemeDecision(-1, null)).toThrow(RangeError);
    expect(() => gstSchemeDecision(1.5, null)).toThrow(RangeError);
  });
});

describe("qrmpGstr3bDay (§6.6)", () => {
  it("is the 22nd for every listed state code 22–37, Karnataka (29) included", () => {
    for (let code = 22; code <= 37; code++) expect(qrmpGstr3bDay(String(code))).toBe(22);
    expect(qrmpGstr3bDay("29")).toBe(22);
    expect(QRMP_22ND_STATE_CODES).toHaveLength(16);
  });

  it("is the 24th for every other state code", () => {
    for (const code of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "38", "97", "99"]) {
      expect(qrmpGstr3bDay(code)).toBe(24);
    }
  });

  it("normalises codes, and uses the earlier day when no state is recorded", () => {
    expect(qrmpGstr3bDay(29)).toBe(22);
    expect(qrmpGstr3bDay("7")).toBe(24);
    expect(qrmpGstr3bDay(" 36 ")).toBe(22);
    expect(qrmpGstr3bDay(null)).toBe(22);
    expect(qrmpGstr3bDay("KA")).toBe(22);
    expect(resolveStateDay(null, SCALE_DEFAULTS.qrmpGstr3b)).toEqual({ day: 22, basis: "unknown_state" });
    expect(resolveStateDay("29", SCALE_DEFAULTS.qrmpGstr3b)).toEqual({ day: 22, basis: "state_list" });
    expect(resolveStateDay("07", SCALE_DEFAULTS.qrmpGstr3b)).toEqual({ day: 24, basis: "other_state" });
  });

  it("reads the days from params", () => {
    const params = { defaultDay: 25, stateDays: [{ day: 20, states: ["29"] }] };
    expect(qrmpGstr3bDay("29", params)).toBe(20);
    expect(qrmpGstr3bDay("27", params)).toBe(25);
  });

  it("normaliseStateCode", () => {
    expect(normaliseStateCode("9")).toBe("09");
    expect(normaliseStateCode(29)).toBe("29");
    expect(normaliseStateCode("")).toBeNull();
    expect(normaliseStateCode("290")).toBeNull();
    expect(normaliseStateCode(undefined)).toBeNull();
  });
});

describe("taxAuditIndication (§6.6): business", () => {
  const business = (turnoverRupees: number, extra: Partial<TaxAuditInput> = {}) =>
    taxAuditIndication({ nature: "business", turnover: rupees(turnoverRupees), ...extra });

  it("no audit up to and including ₹1 crore", () => {
    const r = business(1 * CRORE);
    expect(r).toMatchObject({ indication: "no", askCashRatio: false });
    expect(r.reasons).toEqual(["Turnover of ₹1 crore is within ₹1 crore, so no tax audit is indicated."]);
    expect(business(50 * LAKH).indication).toBe("no");
  });

  it("between ₹1 crore and ₹10 crore asks the cash-ratio question and waits for it", () => {
    const r = taxAuditIndication({ nature: "business", turnover: rupees(1 * CRORE) + 1 });
    expect(r).toMatchObject({ indication: "review", askCashRatio: true });
    expect(r.reasons[1]).toContain("Ask the client what share of receipts and of payments was in cash");
    expect(business(3 * CRORE, { cashReceiptsPct: 2 }).indication).toBe("review");
  });

  it("no audit up to ₹10 crore when cash receipts and payments are each 5% or less (inclusive)", () => {
    const r = business(8 * CRORE, { cashReceiptsPct: 5, cashPaymentsPct: 5 });
    expect(r).toMatchObject({ indication: "no", askCashRatio: true });
    expect(r.reasons.at(-1)).toBe("Cash receipts (5%) and cash payments (5%) are each within 5%, so the ₹10 crore limit applies and no tax audit is indicated.");
    expect(business(10 * CRORE, { cashReceiptsPct: 0, cashPaymentsPct: 1.5 }).indication).toBe("no");
  });

  it("audit between ₹1 crore and ₹10 crore when either cash share exceeds 5%", () => {
    expect(business(2 * CRORE, { cashReceiptsPct: 5.01, cashPaymentsPct: 1 }).indication).toBe("yes");
    expect(business(2 * CRORE, { cashReceiptsPct: 1, cashPaymentsPct: 6 }).indication).toBe("yes");
    const unknownOther = business(2 * CRORE, { cashReceiptsPct: 7 });
    expect(unknownOther).toMatchObject({ indication: "yes", askCashRatio: true });
    expect(unknownOther.reasons.at(-1)).toBe("Cash receipts are 7%, above 5%, so the ₹1 crore limit applies and a tax audit is indicated.");
  });

  it("audit above ₹10 crore whatever the cash share", () => {
    const r = taxAuditIndication({ nature: "business", turnover: rupees(10 * CRORE) + 1, cashReceiptsPct: 0, cashPaymentsPct: 0 });
    expect(r).toMatchObject({ indication: "yes", askCashRatio: false });
  });

  it("no turnover → review, asking for it", () => {
    expect(taxAuditIndication({ nature: "business", turnover: null })).toEqual({
      indication: "review",
      reasons: ["Enter the turnover to see whether a tax audit is indicated."],
      askCashRatio: false,
    });
    expect(taxAuditIndication({ nature: "profession", turnover: null }).reasons[0]).toContain("gross receipts");
  });
});

describe("taxAuditIndication (§6.6): profession", () => {
  const profession = (r: number, extra: Partial<TaxAuditInput> = {}) => taxAuditIndication({ nature: "profession", turnover: rupees(r), ...extra });

  it("no audit up to and including ₹50 lakh gross receipts", () => {
    expect(profession(50 * LAKH)).toMatchObject({ indication: "no", askCashRatio: false });
  });

  it("above ₹50 lakh: audit, unless eligible for s.44ADA (≤ ₹75 lakh, cash ≤ 5%) and declaring at least 50%", () => {
    expect(profession(60 * LAKH)).toMatchObject({ indication: "review", askCashRatio: true });
    const eligible = profession(75 * LAKH, { cashReceiptsPct: 5, declaredProfitPct: 50 });
    expect(eligible.indication).toBe("no");
    expect(eligible.reasons.at(-1)).toContain("presumptive scheme applies");
    expect(profession(60 * LAKH, { cashReceiptsPct: 6, declaredProfitPct: 60 }).indication).toBe("yes");
    expect(profession(60 * LAKH, { cashReceiptsPct: 1, declaredProfitPct: 49.99 }).indication).toBe("yes");
    expect(profession(60 * LAKH, { cashReceiptsPct: 1 }).reasons.at(-1)).toContain("the income declared as a share of receipts");
  });

  it("above ₹75 lakh: audit", () => {
    expect(profession(75 * LAKH + 1, { cashReceiptsPct: 0, declaredProfitPct: 90 })).toMatchObject({ indication: "yes", askCashRatio: false });
  });
});

describe("taxAuditIndication (§6.6): presumptive profession (s.44ADA)", () => {
  const ada = (r: number, extra: Partial<TaxAuditInput> = {}) => taxAuditIndication({ nature: "presumptive_44ada", turnover: rupees(r), ...extra });

  it("within ₹50 lakh: declaring 50% or more needs no audit", () => {
    expect(ada(40 * LAKH, { declaredProfitPct: 50 }).indication).toBe("no");
    expect(ada(40 * LAKH).indication).toBe("review");
  });

  it("declaring below 50% triggers an audit only with income above the basic exemption", () => {
    expect(ada(40 * LAKH, { declaredProfitPct: 30, incomeAboveBasicExemption: true }).indication).toBe("yes");
    expect(ada(40 * LAKH, { declaredProfitPct: 30, incomeAboveBasicExemption: false }).indication).toBe("no");
    const unknown = ada(40 * LAKH, { declaredProfitPct: 30 });
    expect(unknown.indication).toBe("review");
    expect(unknown.reasons.at(-1)).toContain("confirm the total income");
  });

  it("between ₹50 lakh and ₹75 lakh needs cash receipts ≤ 5%", () => {
    expect(ada(70 * LAKH, { cashReceiptsPct: 4, declaredProfitPct: 55 }).indication).toBe("no");
    expect(ada(70 * LAKH, { cashReceiptsPct: 9, declaredProfitPct: 55 }).indication).toBe("yes");
    expect(ada(70 * LAKH, { declaredProfitPct: 55 })).toMatchObject({ indication: "review", askCashRatio: true });
  });

  it("above ₹75 lakh the regular profession limits apply", () => {
    const r = ada(80 * LAKH, { cashReceiptsPct: 0, declaredProfitPct: 60 });
    expect(r.indication).toBe("yes");
    expect(r.reasons[0]).toContain("can't use the presumptive scheme");
  });
});

describe("taxAuditIndication (§6.6): presumptive business (s.44AD)", () => {
  const ad = (t: number, extra: Partial<TaxAuditInput> = {}) => taxAuditIndication({ nature: "presumptive_44ad", turnover: rupees(t), ...extra });

  it("within ₹2 crore: 8% or more needs no audit", () => {
    expect(ad(1.5 * CRORE, { declaredProfitPct: 8 }).indication).toBe("no");
    expect(ad(1.5 * CRORE).indication).toBe("review");
  });

  it("below 6% with income above the basic exemption triggers an audit", () => {
    expect(ad(1.5 * CRORE, { declaredProfitPct: 5, incomeAboveBasicExemption: true }).indication).toBe("yes");
    expect(ad(1.5 * CRORE, { declaredProfitPct: 5, incomeAboveBasicExemption: false }).indication).toBe("no");
    expect(ad(1.5 * CRORE, { declaredProfitPct: 5 }).indication).toBe("review");
  });

  it("between 6% and 8% depends on the cash share (6% of digital, 8% of other receipts)", () => {
    expect(ad(1.5 * CRORE, { declaredProfitPct: 7 })).toMatchObject({ indication: "review", askCashRatio: true });
    expect(ad(1.5 * CRORE, { declaredProfitPct: 7, cashReceiptsPct: 0 }).indication).toBe("no");
    expect(ad(1.5 * CRORE, { declaredProfitPct: 7, cashReceiptsPct: 50 }).indication).toBe("no"); // minimum 7%
    const below = ad(1.5 * CRORE, { declaredProfitPct: 7, cashReceiptsPct: 60, incomeAboveBasicExemption: true }); // minimum 7.2%
    expect(below.indication).toBe("yes");
    expect(below.reasons.join(" ")).toContain("the presumptive minimum is 7.2%");
  });

  it("between ₹2 crore and ₹3 crore needs cash receipts ≤ 5%", () => {
    expect(ad(2.5 * CRORE, { declaredProfitPct: 8 })).toMatchObject({ indication: "review", askCashRatio: true });
    expect(ad(3 * CRORE, { declaredProfitPct: 8, cashReceiptsPct: 5 }).indication).toBe("no");
    const tooMuchCash = ad(2.5 * CRORE, { declaredProfitPct: 8, cashReceiptsPct: 10 });
    expect(tooMuchCash).toMatchObject({ indication: "yes", askCashRatio: true });
    expect(tooMuchCash.reasons.join(" ")).toContain("regular business limits apply");
  });

  it("above ₹3 crore the regular business limits apply", () => {
    expect(ad(4 * CRORE, { cashReceiptsPct: 2, cashPaymentsPct: 2 }).indication).toBe("no");
    expect(ad(4 * CRORE).indication).toBe("review");
    expect(ad(11 * CRORE).indication).toBe("yes");
  });
});

describe("taxAuditIndication: wording and validation", () => {
  it("every reason is a plain sentence", () => {
    const cases: TaxAuditInput[] = [
      { nature: "business", turnover: rupees(3 * CRORE) },
      { nature: "business", turnover: rupees(3 * CRORE), cashReceiptsPct: 1, cashPaymentsPct: 2 },
      { nature: "profession", turnover: rupees(60 * LAKH), cashReceiptsPct: 1, declaredProfitPct: 70 },
      { nature: "presumptive_44ad", turnover: rupees(2.5 * CRORE), cashReceiptsPct: 1, declaredProfitPct: 4, incomeAboveBasicExemption: true },
      { nature: "presumptive_44ada", turnover: rupees(30 * LAKH), declaredProfitPct: 20 },
    ];
    for (const c of cases) sentenceCheck(taxAuditIndication(c).reasons);
    expect(TAX_AUDIT_DISCLAIMER).toContain("not a determination");
  });

  it("refuses impossible percentages and turnovers", () => {
    expect(() => taxAuditIndication({ nature: "business", turnover: rupees(CRORE), cashReceiptsPct: 101 })).toThrow(RangeError);
    expect(() => taxAuditIndication({ nature: "business", turnover: rupees(CRORE), declaredProfitPct: -1 })).toThrow(RangeError);
    expect(() => taxAuditIndication({ nature: "business", turnover: -5 })).toThrow(RangeError);
  });

  it("reads every threshold from params", () => {
    const params = { ...SCALE_DEFAULTS.taxAudit, businessLimitPaise: rupees(2 * CRORE) };
    expect(taxAuditIndication({ nature: "business", turnover: rupees(1.5 * CRORE) }, params).indication).toBe("no");
  });
});

describe("resolveScaleParams and the seed rows (§5.12, §16)", () => {
  const rows: StatutoryParameterRow[] = SCALE_SEED_PARAMETERS.map((r) => ({ ...r }));

  it("the seed rows resolve to the defaults under both statutes", () => {
    expect(resolveScaleParams(rows, "2025-04-01")).toEqual(SCALE_DEFAULTS);
    expect(resolveScaleParams(rows, "2026-04-01")).toEqual(SCALE_DEFAULTS);
  });

  it("missing keys keep the fallback; a row in force overrides it", () => {
    expect(resolveScaleParams([], "2026-10-22")).toEqual(SCALE_DEFAULTS);
    const custom: StatutoryParameterRow[] = [
      { key: SCALE_PARAM_KEYS.qrmpTurnoverLimit, value: { amount: 100000000 }, effectiveFrom: "2027-04-01" },
      { key: SCALE_PARAM_KEYS.taxAuditProfession, value: 7500000, effectiveFrom: "2027-04-01" },
    ];
    expect(resolveScaleParams(custom, "2027-03-31").qrmpMaxTurnoverPaise).toBe(SCALE_DEFAULTS.qrmpMaxTurnoverPaise);
    const later = resolveScaleParams(custom, "2027-04-01");
    expect(later.qrmpMaxTurnoverPaise).toBe(rupees(10 * CRORE));
    expect(later.taxAudit.professionLimitPaise).toBe(rupees(75 * LAKH));
  });

  it("1961-Act rows are settled; their 2025-Act copies are [verify]", () => {
    for (const row of SCALE_SEED_PARAMETERS) {
      expect(row.verified).toBe(!row.notes?.includes("[verify]"));
      if (row.statute === "Income-tax Act, 2025") expect(row.verified).toBe(false);
    }
  });
});

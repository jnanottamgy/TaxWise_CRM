import { describe, expect, it } from "vitest";
import { ITR_RULESET_FY2024_25, ITR_RULESET_FY2025_26, ITR_RULESET_FY2026_27 } from "@/lib/domain/itr-rulesets";
import {
  ItrFormSchema,
  ItrStatusSchema,
  ageBandFor,
  balanceWords,
  blankItrForm,
  computeStored,
  defaultReturnKind,
  engineErrorsToFormErrors,
  fixedRuleDate,
  formToStoredInputs,
  interestSectionLabels,
  itrActions,
  readFixedRule,
  readStoredInputs,
  returnDueDates,
  sameResult,
  shortSection,
  sideBySideRows,
  storedToForm,
  type ItrFormInput,
} from "@/lib/schemas/itr";
import { formatINR } from "@/lib/domain/money";

function form(overrides: (f: ItrFormInput) => void = () => {}): ReturnType<typeof ItrFormSchema.parse> {
  const f = blankItrForm({
    clientId: "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4e",
    financialYear: "2025-26",
    ageBand: "below_60",
    ageBandSource: "auto",
    filingDate: "2026-07-20",
    dueDate: "2026-07-31",
    returnKind: "non_business",
  });
  overrides(f);
  return ItrFormSchema.parse(f);
}

describe("formToStoredInputs", () => {
  it("turns rupee strings into paise and leaves out what wasn't entered", () => {
    const r = formToStoredInputs(
      form((f) => {
        f.income!.salaryGross = "12,75,000";
        f.income!.houseProperty = "-1,50,000.50";
        f.deductions!.sec80CBasket = "150000";
        f.taxesPaid!.advanceTax!.q2 = "5000";
      }),
      "individual",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stored.engine).toEqual({
      financialYear: "2025-26",
      assesseeType: "individual",
      ageBand: "below_60",
      income: { salaryGross: 127500000, houseProperty: -15000050 },
      deductions: { sec80CBasket: 15000000 },
      taxesPaid: { advanceTax: { q2: 500000 } },
    });
    expect(r.stored.dates).toEqual({ filingDate: "2026-07-20", dueDate: "2026-07-31" });
  });

  it("refuses a negative amount anywhere but house property, and too many decimals", () => {
    const r = formToStoredInputs(
      form((f) => {
        f.income!.otherSources = "-10";
        f.deductions!.sec80D!.selfFamily = "100.555";
      }),
      "individual",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(["deductions.sec80D.selfFamily", "income.otherSources"]);
  });

  it("needs both the amount and the date of a self-assessment payment, and skips blank rows", () => {
    const r = formToStoredInputs(
      form((f) => {
        f.taxesPaid!.selfAssessment = [
          { key: "a", amount: "2500", paidOn: "2026-07-10" },
          { key: "b", amount: "", paidOn: "" },
          { key: "c", amount: "100", paidOn: "" },
        ];
      }),
      "individual",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors).toEqual({ "taxesPaid.selfAssessment.2.paidOn": ["Enter the date it was paid."] });
  });

  it("takes the assessee type from the client and ignores the age band for a HUF", () => {
    const r = formToStoredInputs(form((f) => (f.age_band = "80_plus")), "huf");
    expect(r.ok && r.stored.engine.assesseeType).toBe("huf");
    expect(r.ok && r.stored.engine.ageBand).toBe("below_60");
  });

  it("round-trips through the stored shape", () => {
    const values = form((f) => {
      f.label = "Return as filed";
      f.income!.salaryGross = "900000";
      f.income!.otherSources = "25000";
      f.income!.dividends = "5000";
      f.deductions!.sec80D = { selfFamily: "25000", parents: "50000", parentsSenior: true };
      f.deductions!.governmentEmployer = true;
      f.taxesPaid!.selfAssessment = [{ key: "x", amount: "1200.50", paidOn: "2026-07-15" }];
      f.resident = false;
    });
    const r = formToStoredInputs(values, "individual");
    if (!r.ok) throw new Error("expected ok");
    const stored = readStoredInputs(JSON.parse(JSON.stringify(r.stored)));
    expect(stored).not.toBeNull();
    const back = storedToForm(stored!, { id: "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4f", updated_at: "2026-10-24T10:00:00Z", client_id: values.client_id, label: "Return as filed" });
    expect(back.income!.salaryGross).toBe("900000");
    expect(back.taxesPaid!.selfAssessment).toEqual([{ key: "sa0", amount: "1200.50", paidOn: "2026-07-15" }]);
    expect(back.deductions!.sec80D).toEqual({ selfFamily: "25000", parents: "50000", parentsSenior: true });
    expect(back.resident).toBe(false);
    expect(back.label).toBe("Return as filed");
  });

  it("refuses stored inputs of another version", () => {
    expect(readStoredInputs({ version: 2 })).toBeNull();
    expect(readStoredInputs(null)).toBeNull();
    expect(readStoredInputs({})).toBeNull();
  });
});

describe("computeStored (server recompute)", () => {
  it("salary of ₹12.75 lakh: nil under the new regime (₹60,000 rebate), ₹1,87,200 under the old", () => {
    const r = formToStoredInputs(form((f) => (f.income!.salaryGross = "1275000")), "individual");
    if (!r.ok) throw new Error("expected ok");
    const c = computeStored(r.stored, ITR_RULESET_FY2025_26);
    if (!c.ok) throw new Error("expected ok");
    expect(c.result.yearLabel).toBe("AY 2026-27");
    expect(c.result.regimes.new.totalIncome).toBe(120000000);
    expect(c.result.regimes.new.taxLiabilityRounded).toBe(0);
    expect(c.result.regimes.old.totalIncome).toBe(122500000);
    expect(c.result.regimes.old.taxLiabilityRounded).toBe(18720000);
    expect(c.result.recommendedRegime).toBe("new");
  });

  it("labels the 2025 Act year as a tax year", () => {
    const values = form((f) => {
      f.financial_year = "2026-27";
      f.filing_date = "2027-07-20";
      f.due_date = "2027-07-31";
      f.income!.salaryGross = "600000";
    });
    const r = formToStoredInputs(values, "individual");
    if (!r.ok) throw new Error("expected ok");
    const c = computeStored(r.stored, ITR_RULESET_FY2026_27);
    expect(c.ok && c.result.yearLabel).toBe("Tax year 2026-27");
  });

  it("moves the engine's errors onto the form's fields", () => {
    const values = form((f) => {
      f.income!.otherSources = "1000";
      f.income!.dividends = "5000";
      f.filing_date = "2026-07-20";
      f.due_date = "2026-03-15";
    });
    const r = formToStoredInputs(values, "individual");
    if (!r.ok) throw new Error("expected ok");
    const c = computeStored(r.stored, ITR_RULESET_FY2025_26);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(Object.keys(c.fieldErrors).sort()).toEqual(["due_date", "income.dividends"]);
  });

  it("refuses gains on earlier transfers in a year with one set of rates", () => {
    const values = form((f) => (f.income!.earlierTransfers = { stcg111a: "1000", ltcg112a: "", ltcg112: "" }));
    const r = formToStoredInputs(values, "individual");
    if (!r.ok) throw new Error("expected ok");
    const c = computeStored(r.stored, ITR_RULESET_FY2025_26);
    expect(!c.ok && Object.keys(c.fieldErrors)).toEqual(["income.earlierTransfers.stcg111a"]);
  });

  it("accepts earlier-transfer gains in FY 2024-25", () => {
    const values = form((f) => {
      f.financial_year = "2024-25";
      f.filing_date = "2025-07-20";
      f.due_date = "2025-07-31";
      f.income!.earlierTransfers = { stcg111a: "100000", ltcg112a: "", ltcg112: "" };
    });
    const r = formToStoredInputs(values, "individual");
    if (!r.ok) throw new Error("expected ok");
    expect(computeStored(r.stored, ITR_RULESET_FY2024_25).ok).toBe(true);
  });
});

describe("engineErrorsToFormErrors", () => {
  it("maps the engine's top-level names to the form's", () => {
    expect(engineErrorsToFormErrors({ filingDate: ["a"], dueDate: ["b"], "income.salaryGross": ["c"] })).toEqual({ filing_date: ["a"], due_date: ["b"], "income.salaryGross": ["c"] });
  });
});

describe("ageBandFor", () => {
  it("counts an age as attained the day before the birthday", () => {
    expect(ageBandFor("1966-04-01", "2025-26")).toBe("60_to_79");
    expect(ageBandFor("1966-04-02", "2025-26")).toBe("below_60");
    expect(ageBandFor("1946-03-31", "2025-26")).toBe("80_plus");
    expect(ageBandFor("1946-04-02", "2025-26")).toBe("60_to_79");
  });
  it("is null without a usable date of birth", () => {
    expect(ageBandFor(null, "2025-26")).toBeNull();
    expect(ageBandFor("not a date", "2025-26")).toBeNull();
    expect(ageBandFor("2030-01-01", "2025-26")).toBeNull();
  });
});

describe("return due dates", () => {
  const rules = [
    { code: "ITR_NON_AUDIT_1_2", title: "ITR-1/2", rule: { fixed: "07-31", yearOffset: 1, periodLabel: "taxYear" }, sourceRef: "s.139(1): 31 July" },
    { code: "ITR_NON_AUDIT_3_4", title: "ITR-3/4", rule: { fixed: "08-31", yearOffset: 1, periodLabel: "taxYear" }, sourceRef: null },
    { code: "ITR_AUDIT", title: "Audit case", rule: { fixed: "10-31", yearOffset: 1 }, sourceRef: "s.139(1): 31 October" },
  ];

  it("reads a fixed rule and gives the date after the year", () => {
    expect(readFixedRule({ fixed: "07-31", yearOffset: 1 })).toEqual({ fixed: "07-31", yearOffset: 1 });
    expect(readFixedRule({ monthOffset: 1, day: 20 })).toBeNull();
    expect(fixedRuleDate({ fixed: "07-31", yearOffset: 1 }, "2025-26")).toBe("2026-07-31");
  });

  it("applies a government extension recorded for the rule and the year's label", () => {
    const dates = returnDueDates({
      fy: "2025-26",
      yearLabel: "AY 2026-27",
      rules,
      overrides: [{ ruleCode: "ITR_AUDIT", periodLabel: "AY 2026-27", extendedDue: "2026-11-21", sourceRef: "CBDT Circular 07/2026" }],
    });
    expect(dates.non_business).toEqual({ date: "2026-07-31", basis: "s.139(1): 31 July", extended: false });
    expect(dates.business?.date).toBe("2026-08-31");
    expect(dates.audit).toEqual({ date: "2026-11-21", basis: "Extended by CBDT Circular 07/2026", extended: true });
  });

  it("defaults the kind of case from the tax audit decision and business income", () => {
    expect(defaultReturnKind({ taxAuditApplicable: "yes", businessIncome: false })).toBe("audit");
    expect(defaultReturnKind({ taxAuditApplicable: "review", businessIncome: true })).toBe("business");
    expect(defaultReturnKind({ taxAuditApplicable: null, businessIncome: false })).toBe("non_business");
  });
});

describe("the side-by-side sheet", () => {
  const values = form((f) => {
    f.income!.salaryGross = "2500000";
    f.deductions!.sec80CBasket = "150000";
    f.taxesPaid!.tdsTcs = "300000";
  });
  const stored = formToStoredInputs(values, "individual");
  if (!stored.ok) throw new Error("expected ok");
  const c = computeStored(stored.stored, ITR_RULESET_FY2025_26);
  if (!c.ok) throw new Error("expected ok");

  it("aligns both regimes row by row, with slab rows numbered and each regime's own wording", () => {
    const rows = sideBySideRows(c.result);
    const codes = rows.map((r) => r.code);
    expect(codes).toContain("gti");
    expect(codes.at(-1)).toBe("balance");
    expect(codes.indexOf("total_income")).toBeLessThan(codes.indexOf("tax.slab.1"));
    const slab2 = rows.find((r) => r.code === "tax.slab.2")!;
    expect(slab2.label).toBe("Tax on slab 2");
    expect(slab2.cells.new?.detail).toMatch(/^Tax at 5% on income/);
    expect(slab2.cells.old?.detail).toMatch(/^Tax at 5% on income/);
    // The new regime has seven slabs here (above ₹24 lakh), the old regime four.
    const slab7 = rows.find((r) => r.code === "tax.slab.7")!;
    expect(slab7.cells.new).toBeDefined();
    expect(slab7.cells.old).toBeUndefined();
    const ded = rows.find((r) => r.code === "deduction.80c")!;
    expect(ded.cells.old?.amount).toBe(-15000000);
    expect(ded.cells.new?.amount).toBe(0);
    expect(rows.find((r) => r.code === "salary.gross")?.group).toBe("Income");
    expect(rows.filter((r) => r.group).map((r) => r.group)).toEqual(["Income", "Deductions (Chapter VI-A)", "Tax", "Interest", "Taxes paid and balance"]);
  });

  it("leaves out lines that are nil in both regimes", () => {
    const rows = sideBySideRows(c.result);
    expect(rows.find((r) => r.code === "deduction.80g")).toBeUndefined();
    // An unclaimed 80D carries its cap note in the old regime but is still nil in both.
    expect(rows.find((r) => r.code === "deduction.80d")).toBeUndefined();
    expect(rows.find((r) => r.code === "tax.cess")).toBeDefined();
  });

  it("says payable or refund in words", () => {
    const f = (p: number) => formatINR(p, { decimals: 0 });
    expect(balanceWords(123400, f)).toBe("Tax payable ₹1,234");
    expect(balanceWords(-50000, f)).toBe("Refund due ₹500");
    expect(balanceWords(0, f)).toBe("Nothing payable or refundable");
  });

  it("names the interest sections by the year's statute", () => {
    expect(interestSectionLabels(c.result, "pdf")).toEqual({ s234A: "s.234A", s234B: "s.234B", s234C: "s.234C" });
    const v = form((f) => {
      f.financial_year = "2026-27";
      f.filing_date = "2027-07-20";
      f.due_date = "2027-07-31";
      f.income!.salaryGross = "600000";
    });
    const s = formToStoredInputs(v, "individual");
    if (!s.ok) throw new Error("expected ok");
    const c26 = computeStored(s.stored, ITR_RULESET_FY2026_27);
    if (!c26.ok) throw new Error("expected ok");
    const pdf = interestSectionLabels(c26.result, "pdf");
    expect(pdf.s234A).toBe("s.234A (corresponding provision of the Income-tax Act, 2025)");
    const screen = interestSectionLabels(c26.result, "screen");
    expect(screen.s234B).toMatch(/^s\.424 /);
    const cite = c26.result.regimes.new.lines.find((l) => l.code === "interest.234C")?.section;
    expect(shortSection(cite, "2025")).toBe("s.425 [verify]");
  });

  it("compares results regardless of key order", () => {
    expect(sameResult({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameResult({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameResult(c.result, JSON.parse(JSON.stringify(c.result)))).toBe(true);
  });
});

describe("status changes", () => {
  it("needs a regime to review and a note to send back", () => {
    const id = "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4e";
    expect(ItrStatusSchema.safeParse({ id, updatedAt: "x", status: "reviewed" }).success).toBe(false);
    expect(ItrStatusSchema.safeParse({ id, updatedAt: "x", status: "reviewed", regime: "old" }).success).toBe(true);
    expect(ItrStatusSchema.safeParse({ id, updatedAt: "x", status: "draft" }).success).toBe(false);
    expect(ItrStatusSchema.safeParse({ id, updatedAt: "x", status: "draft", note: "Add the 80D receipts." }).success).toBe(true);
    expect(ItrStatusSchema.safeParse({ id, updatedAt: "x", status: "final" }).success).toBe(true);
  });

  it("offers each person only the steps they may take", () => {
    const e = { id: "e", role: "employee" as const };
    const m = { id: "m", role: "manager" as const };
    const p = { id: "p", role: "partner" as const };
    expect(itrActions({ status: "draft", preparedBy: "e" }, e)).toMatchObject({ edit: true, review: false, delete: false });
    expect(itrActions({ status: "draft", preparedBy: "e" }, m)).toMatchObject({ review: true, delete: true });
    expect(itrActions({ status: "draft", preparedBy: "p" }, p)).toMatchObject({ review: true });
    expect(itrActions({ status: "reviewed", preparedBy: "e" }, e)).toMatchObject({ finalise: false, sendBack: true });
    expect(itrActions({ status: "reviewed", preparedBy: "e" }, m)).toMatchObject({ finalise: true, changeRegime: true });
    expect(itrActions({ status: "final", preparedBy: "e" }, e)).toMatchObject({ edit: false, reopen: false, delete: false });
    expect(itrActions({ status: "final", preparedBy: "e" }, p)).toMatchObject({ edit: false, reopen: true, delete: false });
  });
});

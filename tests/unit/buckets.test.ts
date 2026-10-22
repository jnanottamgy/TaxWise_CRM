import { describe, expect, it } from "vitest";
import {
  autoClassify,
  BUCKET_CODES,
  bucketDef,
  bucketsIn,
  isBucketCode,
  ledgerKey,
  normaliseLedgerText,
  rememberMapping,
  SCHEDULE3_BUCKETS,
  type BucketCode,
} from "@/lib/domain/buckets";

const kw = (name: string, group?: string | null, side?: "debit" | "credit") => autoClassify(name, group, null, { side });

describe("Schedule III Division I buckets (§6.13)", () => {
  it("lists equity and liabilities exactly as the spec, in order", () => {
    expect(bucketsIn("equity_liabilities").map((b) => b.label)).toEqual([
      "Share/partners'/proprietor's capital",
      "Reserves and surplus",
      "Long-term borrowings",
      "Long-term provisions",
      "Short-term borrowings",
      "Trade payables",
      "Other current liabilities",
      "Short-term provisions",
    ]);
  });

  it("lists assets exactly as the spec, in order", () => {
    expect(bucketsIn("assets").map((b) => b.label)).toEqual([
      "Property, plant and equipment",
      "Intangible assets",
      "Non-current investments",
      "Long-term loans and advances",
      "Inventories",
      "Trade receivables",
      "Cash and bank balances",
      "Short-term loans and advances",
      "Other current assets",
    ]);
  });

  it("lists profit and loss exactly as the spec, in order", () => {
    expect(bucketsIn("profit_loss").map((b) => b.label)).toEqual([
      "Revenue from operations",
      "Other income",
      "Changes in inventories (opening stock)",
      "Purchases",
      "Direct expenses",
      "Employee benefits expense",
      "Finance costs",
      "Depreciation and amortisation",
      "Other expenses",
    ]);
    expect(bucketDef("changes_in_inventories").statementLabel).toBe("Changes in inventories");
  });

  it("every code has one definition, and the normal side follows the nature", () => {
    expect(SCHEDULE3_BUCKETS).toHaveLength(26);
    expect(SCHEDULE3_BUCKETS.map((b) => b.code)).toEqual([...BUCKET_CODES]);
    for (const b of SCHEDULE3_BUCKETS) {
      expect(b.normalSide).toBe(b.nature === "asset" || b.nature === "expense" ? "debit" : "credit");
    }
    expect(bucketDef("trade_payables")).toMatchObject({ section: "equity_liabilities", group: "current_liabilities", nature: "liability" });
    expect(bucketDef("ppe").group).toBe("non_current_assets");
    expect(isBucketCode("cash_bank")).toBe(true);
    expect(isBucketCode("cash")).toBe(false);
    expect(isBucketCode(3)).toBe(false);
  });
});

describe("autoClassify: the spec's keyword examples (§6.13)", () => {
  it.each<[string, BucketCode]>([
    ["Interest received", "other_income"],
    ["Dividend", "other_income"],
    ["Dividend received", "other_income"],
    ["Rent received", "other_income"],
    ["Sales", "revenue_from_operations"],
    ["Sales @ 18%", "revenue_from_operations"],
    ["Professional fees", "revenue_from_operations"],
    ["Professional fee", "revenue_from_operations"],
    ["Consultancy", "revenue_from_operations"],
    ["Opening stock", "changes_in_inventories"],
    ["Purchase", "purchases"],
    ["Purchases - Local @ 18%", "purchases"],
    ["Depreciation", "depreciation_amortisation"],
    ["Amortisation of software", "depreciation_amortisation"],
    ["Amortization", "depreciation_amortisation"],
  ])("%s → %s (keyword, high)", (name, bucket) => {
    expect(kw(name)).toMatchObject({ bucket, source: "keyword", confidence: "high" });
  });

  it("says why", () => {
    expect(kw("Depreciation").reason).toBe("Keyword “depreciation” in the ledger name.");
  });
});

describe("autoClassify: specific rules beat general ones", () => {
  it.each<[string, BucketCode]>([
    ["Sales promotion", "other_expenses"],
    ["Salesman salary", "employee_benefits"],
    ["Sales return", "revenue_from_operations"],
    ["Purchase returns", "purchases"],
    ["Interest on FD", "other_income"],
    ["Interest on income tax refund", "other_income"],
    ["Interest on term loan", "finance_costs"],
    ["Interest on partners' capital", "finance_costs"],
    ["Interest on late payment of TDS", "finance_costs"],
    ["Interest accrued on FD", "other_current_assets"],
    ["Accumulated depreciation - Plant", "ppe"],
    ["Provision for depreciation", "ppe"],
    ["Provision for doubtful debts", "trade_receivables"],
    ["Provision for gratuity", "long_term_provisions"],
    ["Provision for income tax", "short_term_provisions"],
    ["Provision for audit fees", "short_term_provisions"],
    ["Salary payable", "other_current_liabilities"],
    ["Audit fees payable", "other_current_liabilities"],
    ["Dividend payable", "other_current_liabilities"],
    ["TDS payable", "other_current_liabilities"],
    ["Output IGST", "other_current_liabilities"],
    ["Advance received from customers", "other_current_liabilities"],
    ["Rent received in advance", "other_current_liabilities"],
    ["Sundry creditors", "trade_payables"],
    ["Creditors for expenses", "other_current_liabilities"],
    ["Bills payable", "trade_payables"],
    ["HDFC Bank OD", "short_term_borrowings"],
    ["Cash credit - SBI", "short_term_borrowings"],
    ["Term loan from SBI", "long_term_borrowings"],
    ["Unsecured loan from directors", "long_term_borrowings"],
    ["Vehicle loan", "long_term_borrowings"],
    ["HDFC Bank", "cash_bank"],
    ["Kotak Mahindra 1234", "cash_bank"],
    ["Cash in hand", "cash_bank"],
    ["Petty cash", "cash_bank"],
    ["Fixed deposit with SBI", "cash_bank"],
    ["Bank charges", "other_expenses"],
    ["Sundry debtors", "trade_receivables"],
    ["Input CGST", "other_current_assets"],
    ["GST receivable", "other_current_assets"],
    ["TDS receivable", "short_term_loans_advances"],
    ["Advance tax FY 2026-27", "short_term_loans_advances"],
    ["Security deposit", "long_term_loans_advances"],
    ["Rent deposit", "long_term_loans_advances"],
    ["Capital advance", "long_term_loans_advances"],
    ["Salary advance", "short_term_loans_advances"],
    ["Prepaid insurance", "short_term_loans_advances"],
    ["Loans and advances to staff", "short_term_loans_advances"],
    ["Computer", "ppe"],
    ["Computer repairs", "other_expenses"],
    ["Computer software", "intangible_assets"],
    ["Software subscription", "other_expenses"],
    ["Goodwill", "intangible_assets"],
    ["Furniture & Fixtures", "ppe"],
    ["Plant and machinery", "ppe"],
    ["Capital work-in-progress", "ppe"],
    ["Vehicle running expenses", "other_expenses"],
    ["Ramesh Capital A/c", "share_capital"],
    ["Share capital", "share_capital"],
    ["Drawings", "share_capital"],
    ["Profit & Loss A/c", "reserves_surplus"],
    ["General reserve", "reserves_surplus"],
    ["Securities premium", "reserves_surplus"],
    ["Legal & professional charges", "other_expenses"],
    ["Auditors' remuneration", "other_expenses"],
    ["Audit fees", "other_expenses"],
    ["Directors' remuneration", "employee_benefits"],
    ["Freight inward", "direct_expenses"],
    ["Power and fuel", "direct_expenses"],
    ["Wages", "employee_benefits"],
    ["Salaries", "employee_benefits"],
    ["Staff welfare", "employee_benefits"],
    ["Contribution to provident fund", "employee_benefits"],
    ["Closing stock", "inventories"],
    ["Stock in trade", "inventories"],
    ["Rent", "other_expenses"],
    ["Office rent", "other_expenses"],
    ["Printing & stationery", "other_expenses"],
    ["Electricity charges", "other_expenses"],
    ["Mutual fund investment", "non_current_investments"],
    ["Long-term capital gain", "other_income"],
    ["Discount received", "other_income"],
    ["Profit on sale of fixed assets", "other_income"],
  ])("%s → %s", (name, bucket) => {
    expect(kw(name).bucket).toBe(bucket);
  });

  it("side settles two-sided ledgers", () => {
    expect(kw("CGST", null, "debit").bucket).toBe("other_current_assets");
    expect(kw("CGST", null, "credit").bucket).toBe("other_current_liabilities");
    expect(kw("TDS on professional fees", null, "debit").bucket).toBe("short_term_loans_advances");
    expect(kw("TDS on professional fees", null, "credit").bucket).toBe("other_current_liabilities");
    expect(kw("Interest", null, "credit").bucket).toBe("other_income");
    expect(kw("Interest", null, "debit")).toMatchObject({ bucket: "finance_costs", confidence: "medium" });
  });
});

describe("autoClassify: the TB group, then unmapped (§6.13)", () => {
  it.each<[string, BucketCode, string]>([
    ["Sundry Debtors", "trade_receivables", "medium"],
    ["Sundry Creditors", "trade_payables", "medium"],
    ["Indirect Expenses", "other_expenses", "medium"],
    ["Direct Expenses", "direct_expenses", "medium"],
    ["Indirect Incomes", "other_income", "medium"],
    ["Direct Incomes", "revenue_from_operations", "medium"],
    ["Sales Accounts", "revenue_from_operations", "medium"],
    ["Purchase Accounts", "purchases", "medium"],
    ["Fixed Assets", "ppe", "medium"],
    ["Investments", "non_current_investments", "medium"],
    ["Capital Account", "share_capital", "medium"],
    ["Reserves & Surplus", "reserves_surplus", "medium"],
    ["Secured Loans", "long_term_borrowings", "medium"],
    ["Loans (Liability)", "long_term_borrowings", "medium"],
    ["Bank OD A/c", "short_term_borrowings", "medium"],
    ["Loans & Advances (Asset)", "short_term_loans_advances", "medium"],
    ["Deposits (Asset)", "long_term_loans_advances", "medium"],
    ["Stock-in-hand", "inventories", "medium"],
    ["Cash-in-hand", "cash_bank", "medium"],
    ["Bank Accounts", "cash_bank", "medium"],
    ["Provisions", "short_term_provisions", "medium"],
    ["Current Liabilities", "other_current_liabilities", "low"],
    ["Current Assets", "other_current_assets", "low"],
    ["Misc. Expenses (ASSET)", "other_current_assets", "low"],
  ])("ledger with no keyword under “%s” → %s (%s)", (group, bucket, confidence) => {
    expect(autoClassify("M/s Sri Ganesha", group)).toMatchObject({ bucket, source: "group", confidence });
  });

  it("uses the side for Duties & Taxes and Bank Accounts", () => {
    expect(autoClassify("Mr Rao", "Duties & Taxes", null, { side: "credit" }).bucket).toBe("other_current_liabilities");
    expect(autoClassify("Mr Rao", "Duties & Taxes", null, { side: "debit" }).bucket).toBe("other_current_assets");
    expect(autoClassify("Mr Rao", "Bank Accounts", null, { side: "credit" }).bucket).toBe("short_term_borrowings");
  });

  it("leaves ledgers it can't place unmapped, for a person", () => {
    expect(autoClassify("M/s Sri Ganesha")).toEqual({ bucket: null, source: "unmapped", confidence: "none", reason: "No keyword or TB group matched. Choose a bucket." });
    expect(autoClassify("M/s Sri Ganesha", "Suspense A/c")).toMatchObject({ bucket: null, source: "unmapped", confidence: "none" });
    expect(autoClassify("M/s Sri Ganesha", "Branch / Divisions").bucket).toBeNull();
    expect(autoClassify("Suspense account", "Current Liabilities")).toMatchObject({ bucket: null, source: "unmapped" });
    expect(autoClassify("Difference in opening balances").bucket).toBeNull();
    expect(autoClassify("   ").bucket).toBeNull();
  });

  it("keyword beats group, but a contradiction lowers the confidence", () => {
    expect(autoClassify("Depreciation", "Indirect Expenses")).toMatchObject({ bucket: "depreciation_amortisation", source: "keyword", confidence: "high" });
    const conflict = autoClassify("Professional fees", "Indirect Expenses");
    expect(conflict).toMatchObject({ bucket: "revenue_from_operations", source: "keyword", confidence: "low" });
    expect(conflict.reason).toContain("TB group “Indirect Expenses” suggests Other expenses");
    expect(autoClassify("CGST payable", "Duties & Taxes")).toMatchObject({ bucket: "other_current_liabilities", confidence: "high" });
  });

  it("an income keyword on a debit balance is flagged", () => {
    expect(autoClassify("Sales", null, null, { side: "debit" })).toMatchObject({ bucket: "revenue_from_operations", confidence: "medium" });
    expect(autoClassify("Opening stock", null, null, { side: "debit" }).confidence).toBe("high");
  });
});

describe("remembered mappings (§6.13: remembered per client)", () => {
  it("a person's earlier choice wins over every rule", () => {
    const remembered = rememberMapping({}, "Professional fees", "other_expenses");
    expect(remembered).toEqual({ "professional fees": "other_expenses" });
    expect(autoClassify("  PROFESSIONAL   FEES ", "Sales Accounts", remembered)).toEqual({
      bucket: "other_expenses",
      source: "remembered",
      confidence: "high",
      reason: "Mapped to Other expenses for this client before.",
    });
  });

  it("ignores a remembered value that isn't a bucket", () => {
    expect(autoClassify("Sales", null, { sales: "nonsense" as BucketCode }).source).toBe("keyword");
  });

  it("rememberMapping returns a new object", () => {
    const a = { rent: "other_expenses" as BucketCode };
    const b = rememberMapping(a, "Rent", "direct_expenses");
    expect(a.rent).toBe("other_expenses");
    expect(b.rent).toBe("direct_expenses");
  });

  it("ledger keys normalise case, punctuation, & and A/c", () => {
    expect(ledgerKey("Furniture & Fixtures A/c")).toBe("furniture and fixtures ac");
    expect(normaliseLedgerText("P&L")).toBe(" p and l ");
  });
});

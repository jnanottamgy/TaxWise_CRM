import { describe, expect, it } from "vitest";
import type { BucketCode } from "@/lib/domain/buckets";
import {
  ageingBandIndex,
  balanceSide,
  buildPayablesAgeing,
  buildReceivablesAgeing,
  buildStatements,
  classifyLedgers,
  emptyMsmeDisclosure,
  mapTrialBalanceColumns,
  msmeDuesFromAgeing,
  MSME_DISCLOSURE_ITEMS,
  parseBalanceCell,
  parseTrialBalanceRows,
  presentedAmount,
  SCHEDULE3_DEFAULTS,
  totalsOf,
  validateMsmeDisclosure,
  type MsmeDisclosure,
  type StatementCheck,
  type Statements,
  type TbLedger,
} from "@/lib/domain/schedule3";

const R = (rupees: number) => rupees * 100;

type Row = [name: string, side: "Dr" | "Cr", rupees: number, group?: string];

function tb(rows: readonly Row[]): TbLedger[] {
  return rows.map(([name, side, rupees, group], i) => ({
    name,
    group: group ?? null,
    debit: side === "Dr" ? R(rupees) : 0,
    credit: side === "Cr" ? R(rupees) : 0,
    row: i + 2,
  }));
}

/** FY 2025-26 of a small company (rupees). Debits = credits = 14,65,000. */
const YEAR1: Row[] = [
  ["Share capital", "Cr", 100_000],
  ["Profit & Loss A/c", "Cr", 50_000],
  ["Term loan from SBI", "Cr", 200_000],
  ["Sundry creditors", "Cr", 80_000],
  ["GST payable", "Cr", 10_000],
  ["Provision for income tax", "Cr", 20_000],
  ["Sales", "Cr", 1_000_000],
  ["Interest received", "Cr", 5_000],
  ["Plant and machinery", "Dr", 300_000],
  ["Computer software", "Dr", 20_000],
  ["Opening stock", "Dr", 60_000],
  ["Sundry debtors", "Dr", 150_000],
  ["HDFC Bank", "Dr", 75_000],
  ["Cash in hand", "Dr", 5_000],
  ["Purchases", "Dr", 500_000],
  ["Freight inward", "Dr", 15_000],
  ["Salaries", "Dr", 120_000],
  ["Interest on term loan", "Dr", 18_000],
  ["Depreciation", "Dr", 30_000],
  ["Rent", "Dr", 24_000],
  ["Security deposit", "Dr", 12_000],
  ["Loans and advances to staff", "Dr", 16_000],
  ["Mutual fund investment", "Dr", 120_000],
];

/** FY 2026-27: opening reserves = last year's closing (₹3,58,000). Debits = credits = 18,98,000. */
const YEAR2: Row[] = [
  ["Share capital", "Cr", 100_000],
  ["Profit & Loss A/c", "Cr", 358_000],
  ["Term loan from SBI", "Cr", 150_000],
  ["Sundry creditors", "Cr", 90_000],
  ["Sales", "Cr", 1_200_000],
  ["Plant and machinery", "Dr", 270_000],
  ["Opening stock", "Dr", 70_000],
  ["Sundry debtors", "Dr", 200_000],
  ["HDFC Bank", "Dr", 300_000],
  ["Purchases", "Dr", 600_000],
  ["Salaries", "Dr", 150_000],
  ["Depreciation", "Dr", 30_000],
  ["Rent", "Dr", 26_000],
  ["Computer software", "Dr", 20_000],
  ["Security deposit", "Dr", 12_000],
  ["Mutual fund investment", "Dr", 120_000],
  ["Interest on term loan", "Dr", 15_000],
  ["Cash in hand", "Dr", 85_000],
];

const mapped = (rows: readonly Row[]) => classifyLedgers(tb(rows));
const check = (s: Statements, code: StatementCheck["code"]) => s.checks.find((c) => c.code === code) as StatementCheck;
const lineOf = (s: Statements, key: string) => [...s.profitAndLoss, ...s.balanceSheet].find((l) => l.key === key);

const year1 = buildStatements(mapped(YEAR1), { closingStock: R(70_000) });
const year2 = buildStatements(mapped(YEAR2), { closingStock: R(90_000), previousYear: year1.figures });

// -------------------------------------------------------------------------------------------------
// Import
// -------------------------------------------------------------------------------------------------

describe("trial balance column mapping (§6.13)", () => {
  it("debit and credit columns", () => {
    const s = mapTrialBalanceColumns(["Particulars", "Group", "Debit", "Credit"]);
    expect(s.mapping).toMatchObject({ ledgerName: "Particulars", group: "Group", debit: "Debit", credit: "Credit", balance: null });
    expect(s.complete).toBe(true);
  });

  it("one closing-balance column (opening balance is never suggested)", () => {
    const s = mapTrialBalanceColumns(["Ledger Name", "Under", "Opening Balance", "Closing Balance"]);
    expect(s.mapping).toMatchObject({ ledgerName: "Ledger Name", group: "Under", balance: "Closing Balance", debit: null, credit: null });
    expect(s.complete).toBe(true);
    expect(s.unusedHeaders).toEqual(["Opening Balance"]);
  });

  it("incomplete without a credit or balance column", () => {
    const s = mapTrialBalanceColumns(["Ledger", "Opening Balance", "Debit"]);
    expect(s.missingRequired).toEqual(["credit"]);
    expect(s.complete).toBe(false);
    expect(mapTrialBalanceColumns(["Debit", "Credit"]).missingRequired).toEqual(["ledgerName"]);
  });

  it("starts from a saved mapping", () => {
    expect(mapTrialBalanceColumns(["Head", "Dr", "Cr"], { ledgerName: "Head" }).mapping).toMatchObject({ ledgerName: "Head", debit: "Dr", credit: "Cr" });
  });
});

describe("parseBalanceCell", () => {
  it.each([
    ["1,234.00 Dr", { debit: 123_400, credit: 0 }],
    ["1,234.00 Cr", { debit: 0, credit: 123_400 }],
    ["Cr 500", { debit: 0, credit: 50_000 }],
    ["500 dr.", { debit: 50_000, credit: 0 }],
    ["-500", { debit: 0, credit: 50_000 }],
    ["(500)", { debit: 0, credit: 50_000 }],
    [750, { debit: 75_000, credit: 0 }],
    ["(500) Dr", { debit: 0, credit: 50_000 }],
  ])("%s", (input, value) => {
    expect(parseBalanceCell(input)).toEqual({ ok: true, value });
  });

  it("positive can mean credit", () => {
    expect(parseBalanceCell("500", "credit")).toEqual({ ok: true, value: { debit: 0, credit: 50_000 } });
  });

  it("empty is null; text is an error", () => {
    expect(parseBalanceCell("")).toEqual({ ok: true, value: null });
    expect(parseBalanceCell("abc Dr").ok).toBe(false);
  });
});

describe("parseTrialBalanceRows", () => {
  const mapping = { ledgerName: "Particulars", group: "Group", debit: "Debit", credit: "Credit", balance: null };

  it("reads ledgers, skips blank and total rows, reports problems by row", () => {
    const r = parseTrialBalanceRows(
      [
        { Particulars: "Share capital", Group: "Capital Account", Debit: "", Credit: "1,00,000.00" },
        { Particulars: "HDFC Bank", Group: "Bank Accounts", Debit: 75000, Credit: null },
        { Particulars: "", Group: "", Debit: "", Credit: "" },
        { Particulars: "Rent", Group: "Indirect Expenses", Debit: -500, Credit: "" },
        { Particulars: "", Group: "Indirect Expenses", Debit: 10, Credit: "" },
        { Particulars: "HDFC bank", Group: "Bank Accounts", Debit: 5, Credit: "" },
        { Particulars: "Sales", Group: "Sales Accounts", Debit: "", Credit: "ten" },
        { Particulars: "Grand Total", Group: "", Debit: "1,75,000", Credit: "1,75,000" },
      ],
      mapping,
    );
    expect(r.counts).toEqual({ total: 8, accepted: 4, rejected: 2, skipped: 2 });
    expect(r.ledgers.map((l) => [l.name, l.debit, l.credit, l.row])).toEqual([
      ["Share capital", 0, 10_000_000, 2],
      ["HDFC Bank", 7_500_000, 0, 3],
      ["Rent", 0, 50_000, 5],
      ["HDFC bank", 500, 0, 7],
    ]);
    expect(r.issues).toEqual([
      { row: 5, level: "warning", field: "debit", message: "A negative debit was read as a credit." },
      { row: 6, level: "error", field: "ledgerName", message: "This row has amounts but no ledger name." },
      { row: 7, level: "warning", field: "ledgerName", message: "“HDFC bank” also appears on row 3; both rows are kept." },
      { row: 8, level: "error", field: "credit", message: "Credit “ten” isn't an amount." },
    ]);
  });

  it("reads a closing-balance column with Dr/Cr", () => {
    const r = parseTrialBalanceRows(
      [
        { Ledger: "Sales", Bal: "12,00,000.00 Cr" },
        { Ledger: "Purchases", Bal: "6,00,000.00 Dr" },
      ],
      { ledgerName: "Ledger", balance: "Bal" },
    );
    expect(r.ledgers.map((l) => [l.debit, l.credit])).toEqual([
      [0, 120_000_000],
      [60_000_000, 0],
    ]);
  });

  it("refuses to read without the needed columns", () => {
    expect(parseTrialBalanceRows([{ a: 1 }], { ledgerName: "a" }).issues[0].message).toBe("Map the debit and credit columns, or one closing-balance column.");
    expect(parseTrialBalanceRows([{ a: 1 }], { debit: "a", credit: "a" }).issues[0].message).toBe("Map the ledger name column first.");
  });
});

describe("classifyLedgers", () => {
  it("passes the balance side, so two-sided ledgers land right", () => {
    const [cgstCr, cgstDr] = classifyLedgers(tb([["CGST", "Cr", 100], ["CGST", "Dr", 100]]));
    expect(cgstCr.bucket).toBe("other_current_liabilities");
    expect(cgstDr.bucket).toBe("other_current_assets");
    expect(balanceSide({ debit: 5, credit: 5 })).toBeNull();
  });

  it("uses remembered mappings", () => {
    const [l] = classifyLedgers(tb([["Sales", "Cr", 100]]), { sales: "other_income" });
    expect(l.classification.source).toBe("remembered");
    expect(l.bucket).toBe("other_income");
  });

  it("maps every year-1 ledger", () => {
    expect(mapped(YEAR1).filter((l) => l.bucket === null)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Statements
// -------------------------------------------------------------------------------------------------

describe("buildStatements: year 1 (no comparatives)", () => {
  it("profit and loss in Schedule III order", () => {
    expect(year1.profitAndLoss.map((l) => l.key)).toEqual([
      "revenue_from_operations",
      "other_income",
      "total_income",
      "expenses",
      "changes_in_inventories",
      "purchases",
      "direct_expenses",
      "employee_benefits",
      "finance_costs",
      "depreciation_amortisation",
      "other_expenses",
      "total_expenses",
      "profit",
    ]);
    expect(lineOf(year1, "total_income")?.current).toBe(R(1_005_000));
    expect(lineOf(year1, "changes_in_inventories")?.current).toBe(R(-10_000)); // 60,000 − 70,000
    expect(lineOf(year1, "total_expenses")?.current).toBe(R(697_000));
    expect(lineOf(year1, "profit")?.current).toBe(R(308_000));
    expect(lineOf(year1, "profit")?.label).toBe("Profit/(loss) for the year (III − IV)");
  });

  it("balance sheet in Schedule III order with refs", () => {
    expect(year1.balanceSheet.map((l) => `${l.ref ?? ""} ${l.key}`.trim())).toEqual([
      "I equity_liabilities",
      "(1) shareholders_funds",
      "(a) share_capital",
      "(b) reserves_surplus",
      "(2) non_current_liabilities",
      "(a) long_term_borrowings",
      "(b) long_term_provisions",
      "(3) current_liabilities",
      "(a) short_term_borrowings",
      "(b) trade_payables",
      "(c) other_current_liabilities",
      "(d) short_term_provisions",
      "total_equity_liabilities",
      "II assets",
      "(1) non_current_assets",
      "(a) ppe",
      "(b) intangible_assets",
      "(c) non_current_investments",
      "(d) long_term_loans_advances",
      "(2) current_assets",
      "(a) inventories",
      "(b) trade_receivables",
      "(c) cash_bank",
      "(d) short_term_loans_advances",
      "(e) other_current_assets",
      "total_assets",
    ]);
  });

  it("adds the profit to reserves and closing stock to inventories", () => {
    expect(lineOf(year1, "reserves_surplus")?.current).toBe(R(358_000));
    expect(lineOf(year1, "inventories")?.current).toBe(R(70_000));
    expect(lineOf(year1, "cash_bank")?.current).toBe(R(80_000));
    expect(lineOf(year1, "total_equity_liabilities")?.current).toBe(R(768_000));
    expect(lineOf(year1, "total_assets")?.current).toBe(R(768_000));
    expect(year1.totals).toMatchObject({ tbDebit: R(1_465_000), tbCredit: R(1_465_000), previous: null });
  });

  it("checks: TB agrees, BS balances, all mapped pass; profit movement is skipped without last year", () => {
    expect(year1.checks.map((c) => [c.code, c.status])).toEqual([
      ["tb_balanced", "pass"],
      ["bs_balanced", "pass"],
      ["all_mapped", "pass"],
      ["profit_movement", "skipped"],
    ]);
    expect(check(year1, "tb_balanced").message).toBe("Trial balance agrees: debits and credits are both ₹14,65,000.00.");
    expect(check(year1, "bs_balanced").message).toBe("Balance sheet balances: ₹7,68,000.00 on each side.");
    expect(check(year1, "all_mapped").message).toBe("Every ledger is mapped to a Schedule III line.");
    expect(check(year1, "profit_movement").message).toContain("Needs last year's saved statement");
    expect(year1.allChecksPassed).toBe(true);
  });

  it("previous-year columns are null without last year", () => {
    expect(year1.balanceSheet.every((l) => l.previous === null)).toBe(true);
  });

  it("notes stubs: policies first, then every non-empty line, balance sheet before P&L", () => {
    expect(year1.notes[0]).toMatchObject({ number: 1, key: "accounting_policies", kind: "text" });
    expect(year1.notes.map((n) => n.key)).toEqual([
      "accounting_policies",
      "share_capital",
      "reserves_surplus",
      "long_term_borrowings",
      "trade_payables",
      "other_current_liabilities",
      "short_term_provisions",
      "ppe",
      "intangible_assets",
      "non_current_investments",
      "long_term_loans_advances",
      "inventories",
      "trade_receivables",
      "cash_bank",
      "short_term_loans_advances",
      "revenue_from_operations",
      "other_income",
      "changes_in_inventories",
      "purchases",
      "direct_expenses",
      "employee_benefits",
      "finance_costs",
      "depreciation_amortisation",
      "other_expenses",
    ]);
    expect(lineOf(year1, "share_capital")?.note).toBe(2);
    expect(lineOf(year1, "long_term_provisions")?.note).toBeNull();
    const reserves = year1.notes.find((n) => n.key === "reserves_surplus");
    expect(reserves?.lines).toEqual([
      { label: "Profit & Loss A/c", current: R(50_000), previous: null },
      { label: "Profit/(loss) for the year", current: R(308_000), previous: null },
    ]);
    expect(reserves?.total).toEqual({ current: R(358_000), previous: null });
    const cash = year1.notes.find((n) => n.key === "cash_bank");
    expect(cash?.lines.map((l) => l.label)).toEqual(["HDFC Bank", "Cash in hand"]);
    expect(year1.notes.find((n) => n.key === "changes_in_inventories")?.lines).toEqual([
      { label: "Opening stock", current: R(60_000), previous: null },
      { label: "Less: closing stock", current: R(-70_000), previous: null },
    ]);
  });

  it("saves figures for next year", () => {
    expect(year1.figures).toMatchObject({ profit: R(308_000), closingStock: R(70_000), profitTo: "reserves_surplus" });
    expect(year1.figures.buckets.inventories).toBe(R(70_000));
    expect(year1.figures.ledgers).toHaveLength(YEAR1.length);
  });
});

describe("buildStatements: year 2 with comparatives", () => {
  it("shows last year beside this year", () => {
    expect(lineOf(year2, "revenue_from_operations")).toMatchObject({ current: R(1_200_000), previous: R(1_000_000) });
    expect(lineOf(year2, "other_income")).toMatchObject({ current: 0, previous: R(5_000) });
    expect(lineOf(year2, "profit")).toMatchObject({ current: R(399_000), previous: R(308_000) });
    expect(lineOf(year2, "total_assets")).toMatchObject({ current: R(1_097_000), previous: R(768_000) });
    expect(year2.totals.previous).toEqual({ totalIncome: R(1_005_000), totalExpenses: R(697_000), profit: R(308_000), equityAndLiabilities: R(768_000), assets: R(768_000) });
  });

  it("notes carry ledger comparatives, including ledgers that are gone this year", () => {
    const ppe = year2.notes.find((n) => n.key === "ppe");
    expect(ppe?.lines).toEqual([{ label: "Plant and machinery", current: R(270_000), previous: R(300_000) }]);
    const stl = year2.notes.find((n) => n.key === "short_term_loans_advances");
    expect(stl?.lines).toEqual([{ label: "Loans and advances to staff", current: 0, previous: R(16_000) }]);
    expect(stl?.total).toEqual({ current: 0, previous: R(16_000) });
    expect(year2.notes.find((n) => n.key === "reserves_surplus")?.lines).toEqual([
      { label: "Profit & Loss A/c", current: R(358_000), previous: R(50_000) },
      { label: "Profit/(loss) for the year", current: R(399_000), previous: R(308_000) },
    ]);
    expect(year2.notes.find((n) => n.key === "inventories")?.lines).toEqual([{ label: "Closing stock", current: R(90_000), previous: R(70_000) }]);
  });

  it("profit equals the movement in capital and reserves; opening stock equals last year's closing", () => {
    expect(year2.checks.map((c) => [c.code, c.status])).toEqual([
      ["tb_balanced", "pass"],
      ["bs_balanced", "pass"],
      ["all_mapped", "pass"],
      ["profit_movement", "pass"],
      ["opening_stock", "pass"],
    ]);
    expect(check(year2, "profit_movement").message).toBe("Capital and reserves moved by ₹3,99,000.00, which equals the profit of ₹3,99,000.00.");
    expect(check(year2, "opening_stock").message).toBe("Opening stock of ₹70,000.00 equals last year's closing inventories.");
  });

  it("fails the movement check when opening reserves don't match last year, and other movements explain it", () => {
    const rows = YEAR2.map((r): Row => (r[0] === "Profit & Loss A/c" ? [r[0], r[1], 350_000] : r[0] === "Cash in hand" ? [r[0], r[1], 77_000] : r));
    const s = buildStatements(mapped(rows), { closingStock: R(90_000), previousYear: year1.figures });
    const c = check(s, "profit_movement");
    expect(c.status).toBe("fail");
    expect(c.difference).toBe(R(-8_000));
    expect(c.message).toBe(
      "Capital and reserves moved by ₹3,91,000.00, but the profit is ₹3,99,000.00 (difference ₹8,000.00). Check the opening balances against last year's closing figures, or enter drawings, capital introduced or dividends as other movements.",
    );
    expect(check(s, "tb_balanced").status).toBe("pass");
    expect(s.allChecksPassed).toBe(false);
    const explained = buildStatements(mapped(rows), { closingStock: R(90_000), previousYear: year1.figures, equityAdjustments: [{ label: "Dividend paid", amount: R(-8_000) }] });
    expect(check(explained, "profit_movement").status).toBe("pass");
    expect(check(explained, "profit_movement").message).toContain("and the other movements entered (-₹8,000.00)");
  });

  it("fails the opening-stock check when it differs from last year's closing stock", () => {
    const rows = YEAR2.map((r): Row => (r[0] === "Opening stock" ? [r[0], r[1], 65_000] : r[0] === "Cash in hand" ? [r[0], r[1], 90_000] : r));
    const s = buildStatements(mapped(rows), { closingStock: R(90_000), previousYear: year1.figures });
    expect(check(s, "opening_stock")).toMatchObject({ status: "fail", difference: R(-5_000) });
    expect(check(s, "opening_stock").message).toBe("Opening stock is ₹65,000.00, but last year's closing inventories were ₹70,000.00 (difference ₹5,000.00).");
  });

  it("tolerates partial saved figures from an older statement", () => {
    const s = buildStatements(mapped(YEAR2), { closingStock: R(90_000), previousYear: { buckets: { revenue_from_operations: R(900_000) } as Record<BucketCode, number> } });
    expect(lineOf(s, "revenue_from_operations")?.previous).toBe(R(900_000));
    expect(lineOf(s, "profit")?.previous).toBe(R(900_000));
  });
});

describe("buildStatements: failing checks", () => {
  it("TB doesn't agree when a ledger is missing (and the balance sheet doesn't balance)", () => {
    const s = buildStatements(mapped(YEAR1.filter((r) => r[0] !== "Rent")), { closingStock: R(70_000) });
    expect(check(s, "tb_balanced")).toMatchObject({ status: "fail", difference: R(-24_000) });
    expect(check(s, "tb_balanced").message).toBe(
      "Trial balance doesn't agree: debits ₹14,41,000.00, credits ₹14,65,000.00 (difference ₹24,000.00). Check the import for missing or repeated ledgers.",
    );
    expect(check(s, "bs_balanced").status).toBe("fail");
  });

  it("hints at closing stock entered as a ledger without its credit", () => {
    const s = buildStatements(mapped([...YEAR1, ["Closing stock", "Dr", 70_000]]));
    expect(check(s, "tb_balanced").status).toBe("fail");
    expect(check(s, "tb_balanced").message).toContain("The difference equals the stock ledgers (₹70,000.00)");
  });

  it("unmapped ledgers fail the mapping check and are named in the balance-sheet check", () => {
    const ledgers = mapped(YEAR1).map((l) => (l.name === "Rent" || l.name === "Security deposit" ? { ...l, bucket: null } : l));
    const s = buildStatements(ledgers, { closingStock: R(70_000) });
    expect(check(s, "all_mapped")).toMatchObject({ status: "fail", message: "2 ledgers aren't mapped yet: “Rent”, “Security deposit”." });
    expect(check(s, "bs_balanced").status).toBe("fail");
    expect(check(s, "bs_balanced").message).toContain("2 unmapped ledgers are left out (net ₹36,000.00 debit); map them first.");
    expect(check(s, "tb_balanced").status).toBe("pass");
    expect(s.unmapped).toEqual([
      { name: "Rent", net: R(24_000) },
      { name: "Security deposit", net: R(12_000) },
    ]);
  });

  it("lists at most five unmapped names", () => {
    const ledgers = tb(Array.from({ length: 7 }, (_, i): Row => [`Party ${i + 1}`, "Dr", 1])).map((l) => ({ ...l, bucket: null }));
    expect(check(buildStatements(ledgers), "all_mapped").message).toBe("7 ledgers aren't mapped yet: “Party 1”, “Party 2”, “Party 3”, “Party 4”, “Party 5” and 2 more.");
  });

  it("tolerance is a parameter", () => {
    const s = buildStatements(mapped([...YEAR1, ["Round off", "Dr", 0.5]]), { closingStock: R(70_000), params: { tolerancePaise: 100 } });
    expect(check(s, "tb_balanced").status).toBe("pass");
    expect(SCHEDULE3_DEFAULTS.tolerancePaise).toBe(0);
  });
});

describe("buildStatements: firms, warnings, helpers", () => {
  it("a firm's profit goes to capital", () => {
    const rows = YEAR1.map((r): Row => (r[0] === "Profit & Loss A/c" ? ["Partners capital", "Cr", 50_000] : r));
    const s = buildStatements(mapped(rows), { closingStock: R(70_000), profitTo: "share_capital" });
    expect(lineOf(s, "share_capital")?.current).toBe(R(100_000 + 50_000 + 308_000));
    expect(lineOf(s, "reserves_surplus")?.current).toBe(0);
    expect(check(s, "bs_balanced").status).toBe("pass");
    expect(s.notes.find((n) => n.key === "share_capital")?.lines.at(-1)).toEqual({ label: "Profit/(loss) for the year", current: R(308_000), previous: null });
  });

  it("warns about a balance on the wrong side for its line", () => {
    const rows = YEAR1.map((r): Row => (r[0] === "HDFC Bank" ? ["HDFC Bank", "Cr", 25_000] : r[0] === "Cash in hand" ? ["Cash in hand", "Dr", 105_000] : r));
    const s = buildStatements(mapped(rows), { closingStock: R(70_000) });
    expect(s.warnings).toEqual([
      "“HDFC Bank” is mapped to Cash and bank balances but has a credit balance of ₹25,000.00; consider re-mapping it (for example, a bank overdraft belongs in short-term borrowings).",
    ]);
  });

  it("presentedAmount and totalsOf", () => {
    expect(presentedAmount({ debit: 500, credit: 200 }, "ppe")).toBe(300);
    expect(presentedAmount({ debit: 500, credit: 200 }, "trade_payables")).toBe(-300);
    expect(presentedAmount({ debit: 0, credit: 900 }, "revenue_from_operations")).toBe(900);
    expect(presentedAmount({ debit: 5, credit: 5 }, "ppe")).toBe(0);
    expect(totalsOf({ revenue_from_operations: 1000, other_expenses: 400, ppe: 50, trade_payables: 20 })).toEqual({
      totalIncome: 1000,
      totalExpenses: 400,
      profit: 600,
      equityAndLiabilities: 20,
      assets: 50,
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Ageing and MSME (Schedule III as amended in 2021)
// -------------------------------------------------------------------------------------------------

describe("ageing schedules", () => {
  const asOn = "2027-03-31";

  it("bands by months from the due date: Schedule III's columns", () => {
    const bands = SCHEDULE3_DEFAULTS.receivablesAgeingBands;
    expect(bands.map((b) => b.label)).toEqual(["Less than 6 months", "6 months – 1 year", "1–2 years", "2–3 years", "More than 3 years"]);
    expect(SCHEDULE3_DEFAULTS.payablesAgeingBands.map((b) => b.label)).toEqual(["Less than 1 year", "1–2 years", "2–3 years", "More than 3 years"]);
    expect(ageingBandIndex("2026-10-01", asOn, bands)).toBe(0);
    expect(ageingBandIndex("2026-09-30", asOn, bands)).toBe(1); // exactly six months
    expect(ageingBandIndex("2026-04-01", asOn, bands)).toBe(1);
    expect(ageingBandIndex("2026-03-31", asOn, bands)).toBe(2);
    expect(ageingBandIndex("2024-04-01", asOn, bands)).toBe(3);
    expect(ageingBandIndex("2024-03-31", asOn, bands)).toBe(4);
    expect(ageingBandIndex("2020-01-01", asOn, bands)).toBe(4);
    expect(ageingBandIndex("2027-04-15", asOn, bands)).toBe(-1); // not yet due
  });

  it("builds the receivables schedule by category, from the due date when given", () => {
    const s = buildReceivablesAgeing(
      [
        { category: "undisputed_good", amount: R(100_000), transactionDate: "2027-02-01", dueDate: "2027-04-02" },
        { category: "undisputed_good", amount: R(30_000), transactionDate: "2026-12-01" },
        { category: "undisputed_doubtful", amount: R(15_000), transactionDate: "2025-01-10" },
        { category: "disputed_good", amount: R(5_000), dueDate: "2023-06-30" },
        { category: "undisputed_good", amount: R(1_000), party: "No date Ltd" },
      ],
      asOn,
    );
    expect(s.rows[0]).toEqual({ category: "undisputed_good", label: "Undisputed trade receivables – considered good", notDue: R(100_000), bands: [R(30_000), 0, 0, 0, 0], total: R(130_000) });
    expect(s.rows[1].bands).toEqual([0, 0, 0, R(15_000), 0]); // 10 Jan 2025 → 31 Mar 2027: 2–3 years
    expect(s.rows[2].bands).toEqual([0, 0, 0, 0, R(5_000)]);
    expect(s.totals).toEqual({ notDue: R(100_000), bands: [R(30_000), 0, 0, R(15_000), R(5_000)], total: R(150_000) });
    expect(s.issues).toEqual(["1 item has no due or transaction date and couldn't be aged (₹1,000.00)."]);
  });

  it("builds the payables schedule; MSME dues include disputed MSME dues", () => {
    const s = buildPayablesAgeing(
      [
        { category: "msme", amount: R(20_000), transactionDate: "2027-03-01" },
        { category: "disputed_msme", amount: R(5_000), transactionDate: "2025-02-01" },
        { category: "others", amount: R(55_000), transactionDate: "2026-11-15" },
        { category: "unknown" as "msme", amount: R(1), party: "Odd" },
      ],
      asOn,
    );
    expect(s.bandLabels).toHaveLength(4);
    expect(msmeDuesFromAgeing(s)).toBe(R(25_000));
    expect(s.totals.total).toBe(R(80_000));
    expect(s.issues[0]).toContain("“unknown” isn't an ageing category");
  });
});

describe("statements with ageing and MSME inputs", () => {
  const receivables = buildReceivablesAgeing([{ category: "undisputed_good", amount: R(150_000), transactionDate: "2026-02-15" }], "2026-03-31");
  const payables = buildPayablesAgeing(
    [
      { category: "msme", amount: R(30_000), transactionDate: "2026-03-01" },
      { category: "others", amount: R(50_000), transactionDate: "2025-12-01" },
    ],
    "2026-03-31",
  );
  const msme: MsmeDisclosure = { ...emptyMsmeDisclosure(), principalUnpaid: R(30_000), interestDueOnUnpaid: R(450) };

  it("agreeing schedules pass and add notes; trade payables split MSME / others on the face", () => {
    const s = buildStatements(mapped(YEAR1), { closingStock: R(70_000), receivablesAgeing: receivables, payablesAgeing: payables, msme });
    expect(s.checks.slice(4).map((c) => [c.code, c.status])).toEqual([
      ["receivables_ageing", "pass"],
      ["payables_ageing", "pass"],
      ["msme_dues", "pass"],
    ]);
    const tp = s.balanceSheet.findIndex((l) => l.key === "trade_payables");
    expect(s.balanceSheet.slice(tp + 1, tp + 3).map((l) => [l.label, l.current])).toEqual([
      ["Total outstanding dues of micro enterprises and small enterprises", R(30_000)],
      ["Total outstanding dues of creditors other than micro enterprises and small enterprises", R(50_000)],
    ]);
    const ageing = s.notes.find((n) => n.key === "receivables_ageing");
    expect(ageing?.table?.columns).toEqual(["Not due", "Less than 6 months", "6 months – 1 year", "1–2 years", "2–3 years", "More than 3 years", "Total"]);
    expect(ageing?.table?.rows.at(-1)).toEqual({ label: "Total", values: [0, R(150_000), 0, 0, 0, 0, R(150_000)] });
    const msmeNote = s.notes.find((n) => n.key === "msme_dues");
    expect(msmeNote?.lines).toHaveLength(MSME_DISCLOSURE_ITEMS.length);
    expect(msmeNote?.lines[1]).toMatchObject({ current: R(450) });
    expect(s.allChecksPassed).toBe(true);
  });

  it("schedules that don't agree with the balance sheet fail", () => {
    const short = buildReceivablesAgeing([{ category: "undisputed_good", amount: R(140_000), transactionDate: "2026-02-15" }], "2026-03-31");
    const s = buildStatements(mapped(YEAR1), { closingStock: R(70_000), receivablesAgeing: short, payablesAgeing: payables, msme: { ...msme, principalUnpaid: R(35_000) } });
    expect(check(s, "receivables_ageing")).toMatchObject({ status: "fail", difference: R(-10_000) });
    expect(check(s, "receivables_ageing").message).toBe("The receivables ageing schedule adds up to ₹1,40,000.00, but trade receivables are ₹1,50,000.00.");
    expect(check(s, "msme_dues")).toMatchObject({ status: "fail", difference: R(5_000) });
  });

  it("MSME dues without a payables schedule are checked against total trade payables", () => {
    const ok = buildStatements(mapped(YEAR1), { closingStock: R(70_000), msme });
    expect(check(ok, "msme_dues")).toMatchObject({ status: "pass", title: "MSME dues within trade payables" });
    const tp = ok.balanceSheet.find((l) => l.key === "trade_payables_msme");
    expect(tp?.current).toBe(R(30_000));
    const tooMuch = buildStatements(mapped(YEAR1), { closingStock: R(70_000), msme: { ...msme, principalUnpaid: R(90_000) } });
    expect(check(tooMuch, "msme_dues").message).toBe("MSME principal unpaid of ₹90,000.00 is more than total trade payables of ₹80,000.00.");
  });

  it("validateMsmeDisclosure", () => {
    expect(validateMsmeDisclosure(emptyMsmeDisclosure())).toEqual({});
    expect(validateMsmeDisclosure({ principalUnpaid: -1, interestDueOnUnpaid: 1.5 })).toEqual({
      principalUnpaid: "The amount can't be negative.",
      interestDueOnUnpaid: "Enter an amount.",
    });
    expect(Object.keys(emptyMsmeDisclosure())).toHaveLength(7);
  });
});

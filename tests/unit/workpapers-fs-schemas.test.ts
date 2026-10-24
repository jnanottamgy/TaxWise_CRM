import { describe, expect, it } from "vitest";
import type { BucketCode } from "@/lib/domain/buckets";
import {
  FsInputsFormSchema,
  SaveStatementSchema,
  StatementStatusSchema,
  applyBucketChoices,
  defaultProfitTo,
  emptyInputs,
  formFromInputs,
  inputsFromForm,
  needsAttention,
  previewInputs,
  readFigures,
  readInputs,
  readLedgers,
  readStatements,
  rebuildStatements,
  yearEndedLabel,
  type FsInputs,
  type FsInputsForm,
  type StoredLedger,
} from "@/lib/schemas/financial-statements";

const ID = "8f0e7c55-3a8f-4c38-9d1b-2f6a7c1d4e01";
const RUPEE = 100;

function ledger(name: string, bucket: BucketCode | null, debit: number, credit: number): StoredLedger {
  return { name, group: null, debit: debit * RUPEE, credit: credit * RUPEE, row: 0, bucket, matched: bucket !== null, source: bucket ? "keyword" : "unmapped", confidence: bucket ? "medium" : "none", reason: "" };
}

/** A proprietor's year: capital 1,00,000, sales 1,00,000, purchases 70,000, cash 1,30,000 (profit 30,000). */
const BALANCED: StoredLedger[] = [
  ledger("Capital Account", "share_capital", 0, 1_00_000),
  ledger("Sales", "revenue_from_operations", 0, 1_00_000),
  ledger("Purchases", "purchases", 70_000, 0),
  ledger("Cash in hand", "cash_bank", 1_30_000, 0),
];

const FY = "2025-26";

describe("readLedgers", () => {
  it("drops malformed rows and fills what's missing", () => {
    const out = readLedgers([
      { name: "Cash", debit: 500, credit: -3, bucket: "cash_bank" },
      { name: 7 },
      null,
      { name: "Suspense", group: "", debit: 1.5, bucket: "not_a_bucket" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "Cash", debit: 500, credit: 0, bucket: "cash_bank", matched: true, source: "manual", confidence: "high" });
    expect(out[1]).toMatchObject({ name: "Suspense", group: null, debit: 0, bucket: null, matched: false, source: "unmapped", confidence: "none" });
    expect(readLedgers("nope")).toEqual([]);
  });

  it("flags unmapped and low-confidence ledgers for a person", () => {
    expect(needsAttention({ bucket: null, confidence: "none" })).toBe(true);
    expect(needsAttention({ bucket: "cash_bank", confidence: "low" })).toBe(true);
    expect(needsAttention({ bucket: "cash_bank", confidence: "medium" })).toBe(false);
  });
});

describe("applyBucketChoices", () => {
  it("applies a choice by index and marks it chosen by hand", () => {
    const out = applyBucketChoices(BALANCED, [{ index: 3, bucket: "short_term_loans_advances" }]);
    expect(out[3]).toMatchObject({ bucket: "short_term_loans_advances", source: "manual", confidence: "high", matched: true });
    expect(out[0]).toBe(BALANCED[0]);
  });

  it("leaves a ledger alone when the choice is what it already has", () => {
    const out = applyBucketChoices(BALANCED, [{ index: 1, bucket: "revenue_from_operations" }]);
    expect(out[1]).toBe(BALANCED[1]);
    expect(out[1].source).toBe("keyword");
  });

  it("unmaps a ledger when the choice is empty", () => {
    const out = applyBucketChoices(BALANCED, [{ index: 2, bucket: null }]);
    expect(out[2]).toMatchObject({ bucket: null, matched: false, source: "unmapped", confidence: "none" });
  });
});

describe("inputs", () => {
  it("sends a company's profit to reserves and a firm's to capital (§6.13)", () => {
    expect(defaultProfitTo("pvt_ltd")).toBe("reserves_surplus");
    expect(defaultProfitTo("trust")).toBe("reserves_surplus");
    expect(defaultProfitTo("proprietorship")).toBe("share_capital");
    expect(defaultProfitTo("partnership")).toBe("share_capital");
    expect(defaultProfitTo(null)).toBe("share_capital");
  });

  it("reads stored inputs leniently, keeping valid parts", () => {
    const r = readInputs(
      {
        profitTo: "share_capital",
        closingStock: 12_000_00,
        equityAdjustments: [{ label: "Drawings", amount: -5_000_00 }, { label: "", amount: 100 }],
        receivablesAgeing: true,
        receivables: [{ party: "Patel & Sons", category: "undisputed_good", amount: 8_000_00, dueDate: "2026-01-15" }, { category: "made_up", amount: 1 }],
        msme: { principalUnpaid: 2_000_00 },
        policies: "  ",
        noteTexts: { trade_payables: "Secured by hypothecation", other: 3 },
        tb: { documentId: ID, fileName: "TB.xlsx", sheet: "TB", headerRow: 4, mapping: { ledgerName: "Particulars", debit: "Debit" }, positiveBalanceIs: "credit" },
      },
      "pvt_ltd",
    );
    expect(r.profitTo).toBe("share_capital");
    expect(r.closingStock).toBe(12_000_00);
    expect(r.equityAdjustments).toEqual([{ label: "Drawings", amount: -5_000_00 }]);
    expect(r.receivables).toEqual([{ party: "Patel & Sons", category: "undisputed_good", amount: 8_000_00, dueDate: "2026-01-15", transactionDate: null }]);
    expect(r.msme?.principalUnpaid).toBe(2_000_00);
    expect(r.msme?.interestDueOnUnpaid).toBe(0);
    expect(r.policies).toBeNull();
    expect(r.noteTexts).toEqual({ trade_payables: "Secured by hypothecation" });
    expect(r.tb?.mapping.ledgerName).toBe("Particulars");
    expect(r.tb?.mapping.credit).toBeNull();
    expect(r.tb?.positiveBalanceIs).toBe("credit");
  });

  it("falls back to the defaults for nothing stored", () => {
    expect(readInputs(null, "llp")).toEqual(emptyInputs("llp"));
  });

  it("round-trips stored inputs through the form", () => {
    const stored: FsInputs = {
      ...emptyInputs("partnership"),
      closingStock: 45_678_90,
      equityAdjustments: [{ label: "Drawings", amount: -1_20_000_00 }],
      payablesAgeing: true,
      payables: [{ party: "Steel Mart", category: "msme", amount: 3_500_00, dueDate: null, transactionDate: "2026-02-10" }],
      msme: { principalUnpaid: 3_500_00, interestDueOnUnpaid: 0, interestPaidUnderSection16: 0, paymentsBeyondAppointedDay: 0, interestDueForDelay: 0, interestAccruedUnpaid: 0, furtherInterestDue: 0 } as FsInputs["msme"],
      policies: "Accounts are prepared on the accrual basis.",
      noteTexts: { cash_bank: "Includes a fixed deposit of 1,00,000." },
    };
    const parsed = FsInputsFormSchema.parse(formFromInputs(stored));
    const back = inputsFromForm(parsed, stored.tb);
    expect(back.closingStock).toBe(stored.closingStock);
    expect(back.equityAdjustments).toEqual(stored.equityAdjustments);
    expect(back.payables).toEqual(stored.payables);
    expect(back.policies).toBe(stored.policies);
    expect(back.noteTexts).toEqual(stored.noteTexts);
    expect(back.msme?.principalUnpaid).toBe(3_500_00);
  });

  it("asks for a date on each ageing row", () => {
    const form = formFromInputs({ ...emptyInputs("pvt_ltd"), receivablesAgeing: true });
    form.receivables = [{ party: "", category: "undisputed_good", amount: "100", dueDate: "", transactionDate: "" }];
    const r = FsInputsFormSchema.safeParse(form);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join(".") === "receivables.0.dueDate")).toBe(true);
  });
});

describe("previewInputs (the live preview)", () => {
  it("uses the parsed form when it is valid", () => {
    const form = formFromInputs({ ...emptyInputs("pvt_ltd"), closingStock: 10_000_00 });
    expect(previewInputs(form, null).closingStock).toBe(10_000_00);
  });

  it("reads what it can from a half-typed form", () => {
    const form: FsInputsForm = {
      ...formFromInputs(emptyInputs("partnership")),
      closingStock: "12,5",
      equityAdjustments: [
        { label: "", amount: "-500" },
        { label: "Capital introduced", amount: "abc" },
      ],
      receivablesAgeing: true,
      receivables: [
        { party: "Patel & Sons", category: "undisputed_good", amount: "800", dueDate: "2026-01-15", transactionDate: "" },
        { party: "", category: "undisputed_good", amount: "", dueDate: "2026-01-15", transactionDate: "" },
      ],
    };
    const p = previewInputs(form, null);
    expect(p.equityAdjustments).toEqual([{ label: "Other movement", amount: -500_00 }]);
    expect(p.receivables).toHaveLength(1);
    expect(p.receivables[0].amount).toBe(800_00);
  });
});

describe("rebuildStatements", () => {
  it("balances a simple year and leaves the profit check for when there are comparatives", () => {
    const s = rebuildStatements(BALANCED, emptyInputs("proprietorship"), { financialYear: FY, previous: null });
    expect(s.totals.current.profit).toBe(30_000 * RUPEE);
    expect(s.totals.current.assets).toBe(1_30_000 * RUPEE);
    expect(s.totals.current.equityAndLiabilities).toBe(1_30_000 * RUPEE);
    const byCode = Object.fromEntries(s.checks.map((c) => [c.code, c.status]));
    expect(byCode).toMatchObject({ tb_balanced: "pass", bs_balanced: "pass", all_mapped: "pass", profit_movement: "skipped" });
    expect(s.allChecksPassed).toBe(true);
    expect(s.totals.previous).toBeNull();
  });

  it("fails the mapping and balance checks while a ledger is unmapped", () => {
    const s = rebuildStatements(applyBucketChoices(BALANCED, [{ index: 3, bucket: null }]), emptyInputs("proprietorship"), { financialYear: FY, previous: null });
    const byCode = Object.fromEntries(s.checks.map((c) => [c.code, c.status]));
    expect(byCode.all_mapped).toBe("fail");
    expect(byCode.bs_balanced).toBe("fail");
    expect(s.allChecksPassed).toBe(false);
    expect(s.unmapped.map((u) => u.name)).toEqual(["Cash in hand"]);
  });

  it("adds closing stock entered as an adjustment to inventories and to profit", () => {
    const s = rebuildStatements(BALANCED, { ...emptyInputs("proprietorship"), closingStock: 10_000 * RUPEE }, { financialYear: FY, previous: null });
    expect(s.figures.buckets.inventories).toBe(10_000 * RUPEE);
    expect(s.totals.current.profit).toBe(40_000 * RUPEE);
    expect(s.checks.find((c) => c.code === "bs_balanced")?.status).toBe("pass");
  });

  it("ties the profit to last year's capital with drawings as another movement", () => {
    const year1 = rebuildStatements(BALANCED, emptyInputs("proprietorship"), { financialYear: FY, previous: null });
    const previous = readFigures(JSON.parse(JSON.stringify(year1)));
    // Next year: capital brought forward 1,30,000, drawings 10,000, sales 50,000, purchases 30,000 (profit 20,000).
    const year2Ledgers: StoredLedger[] = [
      ledger("Capital Account", "share_capital", 10_000, 1_30_000),
      ledger("Sales", "revenue_from_operations", 0, 50_000),
      ledger("Purchases", "purchases", 30_000, 0),
      ledger("Cash in hand", "cash_bank", 1_40_000, 0),
    ];
    const without = rebuildStatements(year2Ledgers, emptyInputs("proprietorship"), { financialYear: "2026-27", previous });
    expect(without.checks.find((c) => c.code === "profit_movement")?.status).toBe("fail");
    const withDrawings = rebuildStatements(year2Ledgers, { ...emptyInputs("proprietorship"), equityAdjustments: [{ label: "Drawings", amount: -10_000 * RUPEE }] }, { financialYear: "2026-27", previous });
    expect(withDrawings.checks.find((c) => c.code === "profit_movement")?.status).toBe("pass");
    expect(withDrawings.totals.previous?.profit).toBe(30_000 * RUPEE);
  });

  it("checks the receivables ageing against trade receivables", () => {
    const ledgers = [...BALANCED.slice(0, 3), ledger("Cash in hand", "cash_bank", 1_00_000, 0), ledger("Patel & Sons", "trade_receivables", 30_000, 0)];
    const inputs: FsInputs = { ...emptyInputs("proprietorship"), receivablesAgeing: true, receivables: [{ party: "Patel & Sons", category: "undisputed_good", amount: 30_000 * RUPEE, dueDate: "2026-02-01", transactionDate: null }] };
    const s = rebuildStatements(ledgers, inputs, { financialYear: FY, previous: null });
    expect(s.checks.find((c) => c.code === "receivables_ageing")?.status).toBe("pass");
    const short = rebuildStatements(ledgers, { ...inputs, receivables: [{ ...inputs.receivables[0], amount: 20_000 * RUPEE }] }, { financialYear: FY, previous: null });
    expect(short.checks.find((c) => c.code === "receivables_ageing")?.status).toBe("fail");
  });
});

describe("stored statements", () => {
  it("reads saved figures back for next year's comparatives", () => {
    const s = rebuildStatements(BALANCED, emptyInputs("proprietorship"), { financialYear: FY, previous: null });
    const f = readFigures(JSON.parse(JSON.stringify(s)));
    expect(f?.buckets?.cash_bank).toBe(1_30_000 * RUPEE);
    expect(f?.profit).toBe(30_000 * RUPEE);
    expect(f?.ledgers?.length).toBe(4);
    expect(readFigures({})).toBeNull();
    expect(readStatements({ checks: [] })).toBeNull();
    expect(readStatements(JSON.parse(JSON.stringify(s)))?.allChecksPassed).toBe(true);
  });

  it("labels the year end", () => {
    expect(yearEndedLabel("2025-26")).toBe("31 March 2026");
  });
});

describe("action schemas", () => {
  it("needs a note to send a statement back to Draft", () => {
    const base = { id: ID, updatedAt: "2026-10-01T10:00:00.000Z" };
    expect(StatementStatusSchema.safeParse({ ...base, status: "draft", note: "" }).success).toBe(false);
    expect(StatementStatusSchema.safeParse({ ...base, status: "draft", note: "Map the director's loan" }).success).toBe(true);
    expect(StatementStatusSchema.safeParse({ ...base, status: "reviewed" }).success).toBe(true);
  });

  it("takes the full list of bucket choices and the inputs", () => {
    const r = SaveStatementSchema.parse({ id: ID, updatedAt: "2026-10-01T10:00:00.000Z", buckets: [{ index: 0, bucket: null }, { index: 1, bucket: "cash_bank" }], inputs: formFromInputs(emptyInputs("pvt_ltd")) });
    expect(r.buckets).toEqual([{ index: 0, bucket: null }, { index: 1, bucket: "cash_bank" }]);
    expect(r.rememberBuckets).toBe(true);
    expect(r.autosave).toBe(false);
    expect(SaveStatementSchema.safeParse({ id: ID, updatedAt: "2026-10-01T10:00:00.000Z", buckets: [{ index: 0, bucket: "made_up" }], inputs: formFromInputs(emptyInputs("pvt_ltd")) }).success).toBe(false);
  });
});

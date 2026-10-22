/**
 * Financial statements engine: Schedule III, Division I (§6.13, §7.8.3).
 *
 * - **Input:** a trial balance (CSV/XLSX: ledger name, group, debit, credit, or one closing-balance
 *   column with Dr/Cr) through a column-mapping step, then each ledger mapped to one bucket
 *   (`lib/domain/buckets.ts`).
 * - **Output:** the statement of profit and loss and the balance sheet in Schedule III order, with
 *   previous-year comparatives (from last year's saved `figures`), notes stubs (the ledger break-up
 *   of every line), and the checks shown prominently: TB agrees, balance sheet balances, every
 *   ledger mapped, profit equals the movement in capital/reserves. Optional inputs add the trade
 *   receivables / payables ageing schedules and the MSME dues disclosure (Schedule III as amended
 *   in 2021), each with its own check.
 * - Amounts on a statement are measured from the bucket's normal side: assets and expenses as
 *   debit − credit; equity, liabilities and income as credit − debit. The year's profit is added to
 *   reserves and surplus (or to capital, for firms and proprietors).
 *
 * The ageing bands are Schedule III's; they are parameters (`SCHEDULE3_DEFAULTS`). Pure and
 * client-safe; amounts are integer paise.
 */

import { autoClassify, bucketDef, bucketsIn, BUCKET_CODES, BUCKET_GROUP_LABELS, isBucketCode, ledgerKey, type BalanceSide, type BucketCode, type BucketGroup, type Classification, type RememberedMappings } from "@/lib/domain/buckets";
import { addMonths, compareDates, isDateString, type DateString } from "@/lib/domain/fy";
import { cellText, parseCellAmount, suggestColumnMapping, type ColumnMapping, type FieldSpec, type MappingSuggestion, type RowIssue, type SheetRow } from "@/lib/domain/gstr2b";
import { formatINR, type Paise } from "@/lib/domain/money";

// -------------------------------------------------------------------------------------------------
// Parameters
// -------------------------------------------------------------------------------------------------

/** An ageing column: amounts outstanding for less than `upToMonths` (null = the open-ended last band). */
export type AgeingBand = { label: string; upToMonths: number | null };

export type Schedule3Params = {
  /** Differences up to this amount still pass the checks (0: exact). */
  tolerancePaise: Paise;
  /** Schedule III (2021): trade receivables ageing columns. */
  receivablesAgeingBands: readonly AgeingBand[];
  /** Schedule III (2021): trade payables ageing columns. */
  payablesAgeingBands: readonly AgeingBand[];
};

/** Schedule III, Division I as amended in 2021. */
export const SCHEDULE3_DEFAULTS: Schedule3Params = {
  tolerancePaise: 0,
  receivablesAgeingBands: [
    { label: "Less than 6 months", upToMonths: 6 },
    { label: "6 months – 1 year", upToMonths: 12 },
    { label: "1–2 years", upToMonths: 24 },
    { label: "2–3 years", upToMonths: 36 },
    { label: "More than 3 years", upToMonths: null },
  ],
  payablesAgeingBands: [
    { label: "Less than 1 year", upToMonths: 12 },
    { label: "1–2 years", upToMonths: 24 },
    { label: "2–3 years", upToMonths: 36 },
    { label: "More than 3 years", upToMonths: null },
  ],
};

// -------------------------------------------------------------------------------------------------
// Trial balance import (§6.13 "through a mapping step")
// -------------------------------------------------------------------------------------------------

export const TB_FIELDS = ["ledgerName", "group", "debit", "credit", "balance"] as const;
export type TbField = (typeof TB_FIELDS)[number];

const OPENING = ["opening"];

/** The trial-balance fields and the header spellings that suggest each. */
export const TB_FIELD_SPECS: readonly FieldSpec<TbField>[] = [
  { field: "ledgerName", label: "Ledger name", required: true, synonyms: ["ledger name", "ledger", "account name", "account head", "head of account", "particulars", "account", "name"], exclude: ["group"] },
  { field: "group", label: "Group", required: false, synonyms: ["group", "group name", "parent group", "account group", "primary group", "under", "parent"] },
  {
    field: "debit",
    label: "Debit",
    required: false,
    synonyms: ["closing debit", "closing balance dr", "closing balance debit", "debit balance", "debit amount", "debit", "dr amount", "dr"],
    exclude: OPENING,
  },
  {
    field: "credit",
    label: "Credit",
    required: false,
    synonyms: ["closing credit", "closing balance cr", "closing balance credit", "credit balance", "credit amount", "credit", "cr amount", "cr"],
    exclude: OPENING,
  },
  { field: "balance", label: "Closing balance", required: false, synonyms: ["closing balance", "net balance", "balance", "amount"], exclude: OPENING },
];

/**
 * Suggests the trial-balance columns (§7.8.3 step 3). Complete when the ledger name is mapped and
 * either both debit and credit, or a single closing-balance column.
 */
export function mapTrialBalanceColumns(headers: readonly string[], saved?: Partial<Record<TbField, string | null>> | null): MappingSuggestion<TbField> {
  const s = suggestColumnMapping(headers, TB_FIELD_SPECS, saved);
  const m = s.mapping;
  const missing: TbField[] = [...s.missingRequired];
  const hasPair = m.debit !== null && m.credit !== null;
  if (!hasPair && m.balance === null) {
    if (m.debit === null) missing.push("debit");
    if (m.credit === null) missing.push("credit");
  }
  return { ...s, missingRequired: missing, complete: missing.length === 0 };
}

/** One trial-balance ledger. Debit and credit are both zero or more (paise). */
export type TbLedger = {
  name: string;
  group: string | null;
  debit: Paise;
  credit: Paise;
  /** Spreadsheet row number, for messages (0 when entered by hand). */
  row: number;
};

export type TbParseResult = {
  ledgers: TbLedger[];
  issues: RowIssue<TbField>[];
  counts: { total: number; accepted: number; rejected: number; skipped: number };
};

const TOTAL_ROW = /^(grand\s*)?(sub\s*)?totals?\b/i;

/**
 * Reads a closing-balance cell with its side: `1,234.00 Dr`, `Cr 500`, `(500)`, `-500`. Without a
 * Dr/Cr marker a positive amount is a debit and a negative one a credit, unless
 * `positiveIs: "credit"`. Returns null for an empty cell.
 */
export function parseBalanceCell(
  value: unknown,
  positiveIs: BalanceSide = "debit",
): { ok: true; value: { debit: Paise; credit: Paise } | null } | { ok: false; error: string } {
  let raw: unknown = value;
  let side: BalanceSide | null = null;
  if (typeof value === "string") {
    const t = cellText(value);
    const suffix = /^(.*?)\s*\b(dr|cr)\.?$/i.exec(t);
    const prefix = /^(dr|cr)\.?\s*(.*)$/i.exec(t);
    if (suffix) {
      side = suffix[2].toLowerCase() === "dr" ? "debit" : "credit";
      raw = suffix[1];
    } else if (prefix) {
      side = prefix[1].toLowerCase() === "dr" ? "debit" : "credit";
      raw = prefix[2];
    }
  }
  const parsed = parseCellAmount(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: true, value: null };
  let amount = parsed.value;
  if (side === null) {
    side = amount >= 0 ? positiveIs : positiveIs === "debit" ? "credit" : "debit";
    amount = Math.abs(amount);
  } else if (amount < 0) {
    side = side === "debit" ? "credit" : "debit";
    amount = -amount;
  }
  return { ok: true, value: side === "debit" ? { debit: amount, credit: 0 } : { debit: 0, credit: amount } };
}

/**
 * Reads the mapped trial-balance rows (§6.13). Blank and "Total" rows are skipped; a row with
 * amounts but no ledger name, or an amount that isn't a number, is an error; a negative debit is
 * read as a credit (and vice versa) with a warning; repeated ledger names are warned about.
 * When debit and credit are both mapped they are used and any balance column is ignored.
 */
export function parseTrialBalanceRows(
  rows: readonly SheetRow[],
  mapping: Partial<ColumnMapping<TbField>>,
  opts: { firstRowNumber?: number; positiveBalanceIs?: BalanceSide } = {},
): TbParseResult {
  const firstRow = opts.firstRowNumber ?? 2;
  const result: TbParseResult = { ledgers: [], issues: [], counts: { total: rows.length, accepted: 0, rejected: 0, skipped: 0 } };
  const usePair = Boolean(mapping.debit && mapping.credit);
  if (!mapping.ledgerName || (!usePair && !mapping.balance)) {
    result.issues.push({
      row: 0,
      level: "error",
      field: mapping.ledgerName ? "debit" : "ledgerName",
      message: mapping.ledgerName ? "Map the debit and credit columns, or one closing-balance column." : "Map the ledger name column first.",
    });
    result.counts.rejected = rows.length;
    return result;
  }
  const get = (row: SheetRow, f: TbField): unknown => {
    const h = mapping[f];
    return h ? row[h] : undefined;
  };
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const rowNumber = firstRow + index;
    const issues: RowIssue<TbField>[] = [];
    const name = cellText(get(row, "ledgerName"));
    const group = cellText(get(row, "group"));
    let debit = 0;
    let credit = 0;
    let anyAmount = false;

    if (usePair) {
      for (const f of ["debit", "credit"] as const) {
        const parsed = parseCellAmount(get(row, f));
        if (!parsed.ok) {
          issues.push({ row: rowNumber, level: "error", field: f, message: `${f === "debit" ? "Debit" : "Credit"} ${parsed.error}.` });
          continue;
        }
        if (parsed.value === null) continue;
        anyAmount = true;
        const v = parsed.value;
        if (v < 0) {
          issues.push({ row: rowNumber, level: "warning", field: f, message: `A negative ${f} was read as a ${f === "debit" ? "credit" : "debit"}.` });
          if (f === "debit") credit += -v;
          else debit += -v;
        } else if (f === "debit") debit += v;
        else credit += v;
      }
    } else {
      const parsed = parseBalanceCell(get(row, "balance"), opts.positiveBalanceIs ?? "debit");
      if (!parsed.ok) issues.push({ row: rowNumber, level: "error", field: "balance", message: `Closing balance ${parsed.error}.` });
      else if (parsed.value) {
        anyAmount = true;
        debit = parsed.value.debit;
        credit = parsed.value.credit;
      }
    }

    if (name === "" && group === "" && !anyAmount && !issues.length) {
      result.counts.skipped++;
      return;
    }
    if (TOTAL_ROW.test(name) || (name === "" && TOTAL_ROW.test(group))) {
      result.counts.skipped++;
      return;
    }
    if (name === "") issues.push({ row: rowNumber, level: "error", field: "ledgerName", message: "This row has amounts but no ledger name." });

    const key = ledgerKey(name);
    if (name !== "") {
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({ row: rowNumber, level: "warning", field: "ledgerName", message: `“${name}” also appears on row ${first}; both rows are kept.` });
      } else {
        seen.set(key, rowNumber);
      }
    }

    result.issues.push(...issues);
    if (issues.some((i) => i.level === "error")) {
      result.counts.rejected++;
      return;
    }
    result.ledgers.push({ name, group: group === "" ? null : group, debit, credit, row: rowNumber });
    result.counts.accepted++;
  });
  return result;
}

// -------------------------------------------------------------------------------------------------
// Mapping ledgers to buckets
// -------------------------------------------------------------------------------------------------

/** A ledger with its bucket (null = not mapped yet). */
export type StatementLedger = {
  name: string;
  group?: string | null;
  debit: Paise;
  credit: Paise;
  bucket: BucketCode | null;
};

export type MappedLedger = TbLedger & { bucket: BucketCode | null; classification: Classification };

/** The side a ledger's net balance sits on; null when it nets to zero. */
export function balanceSide(ledger: Pick<TbLedger, "debit" | "credit">): BalanceSide | null {
  if (ledger.debit === ledger.credit) return null;
  return ledger.debit > ledger.credit ? "debit" : "credit";
}

/** Auto-maps every ledger (§7.8.3 step 4), using the client's remembered mappings first. */
export function classifyLedgers(ledgers: readonly TbLedger[], remembered?: RememberedMappings | null): MappedLedger[] {
  return ledgers.map((l) => {
    const classification = autoClassify(l.name, l.group, remembered, { side: balanceSide(l) });
    return { ...l, bucket: classification.bucket, classification };
  });
}

// -------------------------------------------------------------------------------------------------
// Ageing schedules and MSME dues (Schedule III as amended in 2021)
// -------------------------------------------------------------------------------------------------

export const RECEIVABLE_CATEGORIES = ["undisputed_good", "undisputed_doubtful", "disputed_good", "disputed_doubtful"] as const;
export type ReceivableCategory = (typeof RECEIVABLE_CATEGORIES)[number];

export const RECEIVABLE_CATEGORY_LABELS: Record<ReceivableCategory, string> = {
  undisputed_good: "Undisputed trade receivables – considered good",
  undisputed_doubtful: "Undisputed trade receivables – considered doubtful",
  disputed_good: "Disputed trade receivables – considered good",
  disputed_doubtful: "Disputed trade receivables – considered doubtful",
};

export const PAYABLE_CATEGORIES = ["msme", "others", "disputed_msme", "disputed_others"] as const;
export type PayableCategory = (typeof PAYABLE_CATEGORIES)[number];

export const PAYABLE_CATEGORY_LABELS: Record<PayableCategory, string> = {
  msme: "MSME",
  others: "Others",
  disputed_msme: "Disputed dues – MSME",
  disputed_others: "Disputed dues – Others",
};

/** One outstanding balance to age: measured from the due date of payment, else the transaction date. */
export type AgeingItem<C extends string> = {
  category: C;
  amount: Paise;
  dueDate?: DateString | null;
  transactionDate?: DateString | null;
  party?: string | null;
};

export type AgeingRow<C extends string> = { category: C; label: string; notDue: Paise; bands: Paise[]; total: Paise };

export type AgeingSchedule<C extends string> = {
  asOn: DateString;
  bandLabels: string[];
  rows: AgeingRow<C>[];
  totals: { notDue: Paise; bands: Paise[]; total: Paise };
  /** Items that couldn't be aged (no usable date), left out of the schedule. */
  issues: string[];
};

/**
 * The ageing column for a balance outstanding from `start` on `asOn`: -1 when not yet due
 * (`start` after `asOn`), otherwise the first band whose limit hasn't been reached
 * (`asOn < start + upToMonths`), or the open-ended last band.
 */
export function ageingBandIndex(start: DateString, asOn: DateString, bands: readonly AgeingBand[]): number {
  if (compareDates(start, asOn) > 0) return -1;
  for (let i = 0; i < bands.length; i++) {
    const limit = bands[i].upToMonths;
    if (limit === null || compareDates(asOn, addMonths(start, limit)) < 0) return i;
  }
  return bands.length - 1;
}

function buildAgeing<C extends string>(
  items: readonly AgeingItem<C>[],
  asOn: DateString,
  bands: readonly AgeingBand[],
  categories: readonly C[],
  labels: Record<C, string>,
): AgeingSchedule<C> {
  const rows: AgeingRow<C>[] = categories.map((category) => ({ category, label: labels[category], notDue: 0, bands: bands.map(() => 0), total: 0 }));
  const byCategory = new Map<C, AgeingRow<C>>(rows.map((row) => [row.category, row]));
  const issues: string[] = [];
  let undated = 0;
  let undatedAmount = 0;
  for (const item of items) {
    const row = byCategory.get(item.category);
    const start = item.dueDate ?? item.transactionDate ?? null;
    if (!row || !start || !isDateString(start)) {
      if (!row) issues.push(`“${String(item.category)}” isn't an ageing category, so ${formatINR(item.amount)}${item.party ? ` (${item.party})` : ""} was left out.`);
      else {
        undated++;
        undatedAmount += item.amount;
      }
      continue;
    }
    const idx = ageingBandIndex(start, asOn, bands);
    if (idx < 0) row.notDue += item.amount;
    else row.bands[idx] += item.amount;
    row.total += item.amount;
  }
  if (undated > 0) {
    issues.push(`${undated} item${undated === 1 ? " has" : "s have"} no due or transaction date and couldn't be aged (${formatINR(undatedAmount)}).`);
  }
  const totals = {
    notDue: rows.reduce((s, r) => s + r.notDue, 0),
    bands: bands.map((_, i) => rows.reduce((s, r) => s + r.bands[i], 0)),
    total: rows.reduce((s, r) => s + r.total, 0),
  };
  return { asOn, bandLabels: bands.map((b) => b.label), rows, totals, issues };
}

/** The trade receivables ageing schedule (Schedule III, 2021): outstanding from the due date of payment. */
export function buildReceivablesAgeing(
  items: readonly AgeingItem<ReceivableCategory>[],
  asOn: DateString,
  bands: readonly AgeingBand[] = SCHEDULE3_DEFAULTS.receivablesAgeingBands,
): AgeingSchedule<ReceivableCategory> {
  return buildAgeing(items, asOn, bands, RECEIVABLE_CATEGORIES, RECEIVABLE_CATEGORY_LABELS);
}

/** The trade payables ageing schedule (Schedule III, 2021): MSME, others, and disputed dues of each. */
export function buildPayablesAgeing(
  items: readonly AgeingItem<PayableCategory>[],
  asOn: DateString,
  bands: readonly AgeingBand[] = SCHEDULE3_DEFAULTS.payablesAgeingBands,
): AgeingSchedule<PayableCategory> {
  return buildAgeing(items, asOn, bands, PAYABLE_CATEGORIES, PAYABLE_CATEGORY_LABELS);
}

/** MSME dues within a payables ageing schedule: MSME plus disputed MSME dues. */
export function msmeDuesFromAgeing(schedule: Pick<AgeingSchedule<PayableCategory>, "rows">): Paise {
  return schedule.rows.filter((r) => r.category === "msme" || r.category === "disputed_msme").reduce((s, r) => s + r.total, 0);
}

/** The MSME dues disclosure (MSMED Act, 2006 s.22, as Schedule III requires), in order. */
export const MSME_DISCLOSURE_ITEMS = [
  { key: "principalUnpaid", label: "Principal amount remaining unpaid to suppliers at the end of the year" },
  { key: "interestDueOnUnpaid", label: "Interest due on that principal, remaining unpaid at the end of the year" },
  { key: "interestPaidUnderSection16", label: "Interest paid by the buyer in terms of section 16 of the MSMED Act, 2006" },
  { key: "paymentsBeyondAppointedDay", label: "Payments made to suppliers beyond the appointed day during the year" },
  {
    key: "interestDueForDelay",
    label: "Interest due and payable for the period of delay in making payment (paid beyond the appointed day during the year), without adding the interest specified under the MSMED Act, 2006",
  },
  { key: "interestAccruedUnpaid", label: "Interest accrued and remaining unpaid at the end of the year" },
  {
    key: "furtherInterestDue",
    label: "Further interest remaining due and payable in succeeding years, until the interest dues above are actually paid, for disallowance as a deductible expenditure under section 23 of the MSMED Act, 2006",
  },
] as const;

export type MsmeDisclosureKey = (typeof MSME_DISCLOSURE_ITEMS)[number]["key"];
export type MsmeDisclosure = Record<MsmeDisclosureKey, Paise>;

/** An MSME disclosure with every amount zero (the form's starting state). */
export function emptyMsmeDisclosure(): MsmeDisclosure {
  const out = {} as MsmeDisclosure;
  for (const item of MSME_DISCLOSURE_ITEMS) out[item.key] = 0;
  return out;
}

/** Field errors for an MSME disclosure: every amount must be a whole number of paise, zero or more. */
export function validateMsmeDisclosure(d: Partial<Record<MsmeDisclosureKey, unknown>>): Partial<Record<MsmeDisclosureKey, string>> {
  const errors: Partial<Record<MsmeDisclosureKey, string>> = {};
  for (const item of MSME_DISCLOSURE_ITEMS) {
    const v = d[item.key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v)) errors[item.key] = "Enter an amount.";
    else if (v < 0) errors[item.key] = "The amount can't be negative.";
  }
  return errors;
}

// -------------------------------------------------------------------------------------------------
// Statements
// -------------------------------------------------------------------------------------------------

export type ProfitDestination = "reserves_surplus" | "share_capital";

/** What a statement saves for next year's comparatives (§6.13 "from last year's saved statement"). */
export type StatementFigures = {
  /** Every bucket as presented (profit included in its destination; closing stock in inventories). */
  buckets: Record<BucketCode, Paise>;
  /** Ledger amounts as presented, for the comparatives in the notes. */
  ledgers: Array<{ name: string; bucket: BucketCode; amount: Paise }>;
  profit: Paise;
  closingStock: Paise;
  profitTo: ProfitDestination;
};

export type StatementLineKind = "heading" | "group" | "item" | "subitem" | "total";

export type StatementLine = {
  key: string;
  kind: StatementLineKind;
  /** `I`, `(1)`, `(a)`; null for lines Schedule III doesn't number. */
  ref: string | null;
  label: string;
  note: number | null;
  /** Null for headings. */
  current: Paise | null;
  /** Null for headings, and when there is no previous year. */
  previous: Paise | null;
};

export type NoteLine = { label: string; current: Paise; previous: Paise | null };

export type StatementNote = {
  number: number;
  key: string;
  title: string;
  kind: "text" | "ledgers" | "ageing" | "msme";
  lines: NoteLine[];
  total: { current: Paise; previous: Paise | null } | null;
  /** Ageing schedules: column labels and one row per category. */
  table: { columns: string[]; rows: Array<{ label: string; values: Paise[] }> } | null;
  /** Stubs a person writes (accounting policies). */
  text: string | null;
};

export type CheckCode =
  | "tb_balanced"
  | "bs_balanced"
  | "all_mapped"
  | "profit_movement"
  | "opening_stock"
  | "receivables_ageing"
  | "payables_ageing"
  | "msme_dues";

export type StatementCheck = {
  code: CheckCode;
  title: string;
  status: "pass" | "fail" | "skipped";
  /** One or two plain sentences. */
  message: string;
  difference: Paise | null;
};

export type StatementTotals = {
  totalIncome: Paise;
  totalExpenses: Paise;
  profit: Paise;
  equityAndLiabilities: Paise;
  assets: Paise;
};

export type Statements = {
  profitAndLoss: StatementLine[];
  balanceSheet: StatementLine[];
  notes: StatementNote[];
  checks: StatementCheck[];
  /** Every check that ran passed (skipped checks don't count against it). */
  allChecksPassed: boolean;
  totals: { current: StatementTotals; previous: StatementTotals | null; tbDebit: Paise; tbCredit: Paise };
  /** Save this; next year passes it back as `previousYear`. */
  figures: StatementFigures;
  /** Ledgers left out because they aren't mapped. */
  unmapped: Array<{ name: string; net: Paise }>;
  /** Balances on the unexpected side for their bucket (e.g. a bank account in overdraft). */
  warnings: string[];
};

export type BuildStatementsOptions = {
  previousYear?: Partial<StatementFigures> | null;
  /** Closing stock entered as an adjustment: added to inventories, deducted in changes in inventories. */
  closingStock?: Paise | null;
  /** Where the year's profit goes: reserves and surplus (companies; default) or capital (firms, proprietors). */
  profitTo?: ProfitDestination;
  /** Movements in capital/reserves other than profit (+ capital introduced, − drawings or dividends). */
  equityAdjustments?: ReadonlyArray<{ label: string; amount: Paise }>;
  receivablesAgeing?: AgeingSchedule<ReceivableCategory> | null;
  payablesAgeing?: AgeingSchedule<PayableCategory> | null;
  msme?: MsmeDisclosure | null;
  params?: Partial<Schedule3Params>;
};

function zeroBuckets(): Record<BucketCode, Paise> {
  const out = {} as Record<BucketCode, Paise>;
  for (const c of BUCKET_CODES) out[c] = 0;
  return out;
}

/** A ledger's amount as presented in its bucket (measured from the bucket's normal side). */
export function presentedAmount(ledger: Pick<StatementLedger, "debit" | "credit">, bucket: BucketCode): Paise {
  const v = bucketDef(bucket).normalSide === "debit" ? ledger.debit - ledger.credit : ledger.credit - ledger.debit;
  return v === 0 ? 0 : v;
}

function sumOf(buckets: Record<BucketCode, Paise>, codes: readonly BucketCode[]): Paise {
  return codes.reduce((s, c) => s + (buckets[c] ?? 0), 0);
}

const INCOME_CODES = bucketsIn("profit_loss").filter((b) => b.nature === "income").map((b) => b.code);
const EXPENSE_CODES = bucketsIn("profit_loss").filter((b) => b.nature === "expense").map((b) => b.code);
const EL_CODES = bucketsIn("equity_liabilities").map((b) => b.code);
const ASSET_CODES = bucketsIn("assets").map((b) => b.code);

/** Income, expenses, profit and the two balance-sheet totals from presented bucket amounts. */
export function totalsOf(buckets: Partial<Record<BucketCode, Paise>>): StatementTotals {
  const b = { ...zeroBuckets(), ...buckets };
  const totalIncome = sumOf(b, INCOME_CODES);
  const totalExpenses = sumOf(b, EXPENSE_CODES);
  return { totalIncome, totalExpenses, profit: totalIncome - totalExpenses, equityAndLiabilities: sumOf(b, EL_CODES), assets: sumOf(b, ASSET_CODES) };
}

const ROMAN = ["I", "II", "III", "IV", "V"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function namesList(names: readonly string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => `“${n}”`);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function checkResult(code: CheckCode, title: string, pass: boolean, passMessage: string, failMessage: string, difference: Paise | null): StatementCheck {
  return { code, title, status: pass ? "pass" : "fail", message: pass ? passMessage : failMessage, difference };
}

/**
 * Builds the statement of profit and loss and the balance sheet (§6.13) from mapped ledgers, with
 * comparatives from last year's saved figures, notes stubs and the checks.
 */
export function buildStatements(ledgers: readonly StatementLedger[], opts: BuildStatementsOptions = {}): Statements {
  const params: Schedule3Params = { ...SCHEDULE3_DEFAULTS, ...opts.params };
  const tol = params.tolerancePaise;
  const profitTo: ProfitDestination = opts.profitTo ?? "reserves_surplus";
  const closingStock = opts.closingStock ?? 0;
  const prevIn = opts.previousYear ?? null;
  const prev: StatementFigures | null = prevIn
    ? {
        buckets: { ...zeroBuckets(), ...(prevIn.buckets ?? {}) },
        ledgers: prevIn.ledgers ?? [],
        profit: prevIn.profit ?? totalsOf(prevIn.buckets ?? {}).profit,
        closingStock: prevIn.closingStock ?? 0,
        profitTo: prevIn.profitTo ?? profitTo,
      }
    : null;

  // Bucket amounts from the ledgers.
  const buckets = zeroBuckets();
  const ledgerFigures: StatementFigures["ledgers"] = [];
  const unmapped: Statements["unmapped"] = [];
  const warnings: string[] = [];
  let tbDebit = 0;
  let tbCredit = 0;
  for (const l of ledgers) {
    tbDebit += l.debit;
    tbCredit += l.credit;
    if (!l.bucket || !isBucketCode(l.bucket)) {
      unmapped.push({ name: l.name, net: l.debit - l.credit });
      continue;
    }
    const amount = presentedAmount(l, l.bucket);
    buckets[l.bucket] += amount;
    ledgerFigures.push({ name: l.name, bucket: l.bucket, amount });
    const d = bucketDef(l.bucket);
    if (amount < 0 && d.section !== "profit_loss" && l.bucket !== "reserves_surplus" && l.bucket !== "share_capital") {
      const side = d.normalSide === "debit" ? "credit" : "debit";
      warnings.push(`“${l.name}” is mapped to ${d.label} but has a ${side} balance of ${formatINR(-amount)}; consider re-mapping it (for example, a bank overdraft belongs in short-term borrowings).`);
    }
  }
  const openingStock = buckets.changes_in_inventories;
  buckets.inventories += closingStock;
  buckets.changes_in_inventories -= closingStock;

  const pre = totalsOf(buckets);
  const profit = pre.profit;
  buckets[profitTo] += profit;
  const current = totalsOf(buckets);
  const previous = prev ? totalsOf(prev.buckets) : null;

  // Trade payables split (Schedule III, 2021).
  const msmeDues = opts.payablesAgeing ? msmeDuesFromAgeing(opts.payablesAgeing) : (opts.msme?.principalUnpaid ?? null);

  // Notes: accounting policies, then every non-empty line (balance sheet first, then P&L).
  const notes: StatementNote[] = [
    {
      number: 1,
      key: "accounting_policies",
      title: "Significant accounting policies",
      kind: "text",
      lines: [],
      total: null,
      table: null,
      text: "Basis of preparation, revenue recognition, property, plant and equipment and depreciation, inventories, employee benefits, taxes on income, provisions and contingent liabilities. (To be written by the engagement team.)",
    },
  ];
  const noteFor = new Map<BucketCode, number>();
  const orderedCodes = [...EL_CODES, ...ASSET_CODES, ...INCOME_CODES, ...EXPENSE_CODES];
  for (const code of orderedCodes) {
    const lines = noteLines(code, ledgerFigures, prev, { profit, profitTo, closingStock });
    const cur = buckets[code];
    const prv = prev ? prev.buckets[code] : null;
    if (cur === 0 && (prv ?? 0) === 0 && lines.every((l) => l.current === 0 && (l.previous ?? 0) === 0)) continue;
    const number = notes.length + 1;
    noteFor.set(code, number);
    notes.push({ number, key: code, title: bucketDef(code).statementLabel, kind: "ledgers", lines, total: { current: cur, previous: prv }, table: null, text: null });
  }
  if (opts.receivablesAgeing) notes.push(ageingNote(notes.length + 1, "receivables_ageing", "Trade receivables ageing schedule", opts.receivablesAgeing));
  if (opts.payablesAgeing) notes.push(ageingNote(notes.length + 1, "payables_ageing", "Trade payables ageing schedule", opts.payablesAgeing));
  if (opts.msme) {
    notes.push({
      number: notes.length + 1,
      key: "msme_dues",
      title: "Dues to micro and small enterprises",
      kind: "msme",
      lines: MSME_DISCLOSURE_ITEMS.map((i) => ({ label: i.label, current: opts.msme?.[i.key] ?? 0, previous: null })),
      total: null,
      table: null,
      text: null,
    });
  }

  const line = (key: string, kind: StatementLineKind, ref: string | null, label: string, cur: Paise | null, prv: Paise | null, note: number | null = null): StatementLine => ({
    key,
    kind,
    ref,
    label,
    note,
    current: cur,
    previous: prev ? prv : null,
  });
  const bucketLine = (code: BucketCode, ref: string | null, kind: StatementLineKind = "item") =>
    line(code, kind, ref, bucketDef(code).statementLabel, buckets[code], prev ? prev.buckets[code] : null, noteFor.get(code) ?? null);

  // Statement of profit and loss.
  const pnl: StatementLine[] = [
    bucketLine("revenue_from_operations", "I"),
    bucketLine("other_income", "II"),
    line("total_income", "total", "III", "Total income (I + II)", current.totalIncome, previous?.totalIncome ?? null),
    line("expenses", "heading", "IV", "Expenses", null, null),
    ...EXPENSE_CODES.map((c) => bucketLine(c, null, "subitem")),
    line("total_expenses", "total", null, "Total expenses (IV)", current.totalExpenses, previous?.totalExpenses ?? null),
    line("profit", "total", "V", "Profit/(loss) for the year (III − IV)", current.profit, previous?.profit ?? null),
  ];

  // Balance sheet.
  const bs: StatementLine[] = [];
  const sections: Array<{ key: string; label: string; groups: BucketGroup[]; totalKey: string; total: keyof StatementTotals }> = [
    { key: "equity_liabilities", label: "EQUITY AND LIABILITIES", groups: ["shareholders_funds", "non_current_liabilities", "current_liabilities"], totalKey: "total_equity_liabilities", total: "equityAndLiabilities" },
    { key: "assets", label: "ASSETS", groups: ["non_current_assets", "current_assets"], totalKey: "total_assets", total: "assets" },
  ];
  sections.forEach((section, si) => {
    bs.push(line(section.key, "heading", ROMAN[si], section.label, null, null));
    section.groups.forEach((group, gi) => {
      bs.push(line(group, "group", `(${gi + 1})`, BUCKET_GROUP_LABELS[group], null, null));
      const codes = orderedCodes.filter((c) => bucketDef(c).group === group);
      codes.forEach((code, ci) => {
        bs.push(bucketLine(code, `(${LETTERS[ci]})`));
        if (code === "trade_payables" && msmeDues !== null) {
          bs.push(line("trade_payables_msme", "subitem", null, "Total outstanding dues of micro enterprises and small enterprises", msmeDues, null));
          bs.push(line("trade_payables_others", "subitem", null, "Total outstanding dues of creditors other than micro enterprises and small enterprises", buckets.trade_payables - msmeDues, null));
        }
      });
    });
    bs.push(line(section.totalKey, "total", null, "TOTAL", current[section.total], previous ? previous[section.total] : null));
  });

  // Checks.
  const checks: StatementCheck[] = [];
  const tbDiff = tbDebit - tbCredit;
  const inventoryLedgers = ledgerFigures.filter((l) => l.bucket === "inventories").reduce((s, l) => s + l.amount, 0);
  checks.push(
    checkResult(
      "tb_balanced",
      "Trial balance agrees",
      Math.abs(tbDiff) <= tol,
      `Trial balance agrees: debits and credits are both ${formatINR(tbDebit)}.`,
      `Trial balance doesn't agree: debits ${formatINR(tbDebit)}, credits ${formatINR(tbCredit)} (difference ${formatINR(Math.abs(tbDiff))}). Check the import for missing or repeated ledgers.` +
        (inventoryLedgers !== 0 && tbDiff === inventoryLedgers
          ? ` The difference equals the stock ledgers (${formatINR(inventoryLedgers)}): if closing stock is in the trial balance without its matching credit, remove that ledger and enter closing stock as an adjustment.`
          : ""),
      tbDiff,
    ),
  );
  const bsDiff = current.equityAndLiabilities - current.assets;
  const unmappedNet = unmapped.reduce((s, u) => s + u.net, 0);
  checks.push(
    checkResult(
      "bs_balanced",
      "Balance sheet balances",
      Math.abs(bsDiff) <= tol,
      `Balance sheet balances: ${formatINR(current.assets)} on each side.`,
      `Balance sheet doesn't balance: equity and liabilities ${formatINR(current.equityAndLiabilities)}, assets ${formatINR(current.assets)} (difference ${formatINR(Math.abs(bsDiff))}).` +
        (unmapped.length > 0 ? ` ${unmapped.length} unmapped ledger${unmapped.length === 1 ? " is" : "s are"} left out (net ${formatINR(Math.abs(unmappedNet))} ${unmappedNet >= 0 ? "debit" : "credit"}); map them first.` : ""),
      bsDiff,
    ),
  );
  checks.push(
    checkResult(
      "all_mapped",
      "Every ledger mapped",
      unmapped.length === 0,
      "Every ledger is mapped to a Schedule III line.",
      `${unmapped.length} ledger${unmapped.length === 1 ? " isn't" : "s aren't"} mapped yet: ${namesList(unmapped.map((u) => u.name))}.`,
      null,
    ),
  );
  if (!prev) {
    checks.push({
      code: "profit_movement",
      title: "Profit equals the movement in capital and reserves",
      status: "skipped",
      message: "Needs last year's saved statement: this check compares capital and reserves with last year's closing figures.",
      difference: null,
    });
  } else {
    const equityNow = buckets.share_capital + buckets.reserves_surplus;
    const equityThen = prev.buckets.share_capital + prev.buckets.reserves_surplus;
    const movement = equityNow - equityThen;
    const adjustments = (opts.equityAdjustments ?? []).reduce((s, a) => s + a.amount, 0);
    const expected = profit + adjustments;
    const diff = movement - expected;
    const adjText = adjustments !== 0 ? ` and the other movements entered (${formatINR(adjustments)})` : "";
    checks.push(
      checkResult(
        "profit_movement",
        "Profit equals the movement in capital and reserves",
        Math.abs(diff) <= tol,
        `Capital and reserves moved by ${formatINR(movement)}, which equals the profit of ${formatINR(profit)}${adjText}.`,
        `Capital and reserves moved by ${formatINR(movement)}, but the profit${adjText ? " plus other movements" : ""} is ${formatINR(expected)} (difference ${formatINR(Math.abs(diff))}). Check the opening balances against last year's closing figures, or enter drawings, capital introduced or dividends as other movements.`,
        diff,
      ),
    );
    if (openingStock !== 0 || prev.buckets.inventories !== 0) {
      const d = openingStock - prev.buckets.inventories;
      checks.push(
        checkResult(
          "opening_stock",
          "Opening stock equals last year's closing stock",
          Math.abs(d) <= tol,
          `Opening stock of ${formatINR(openingStock)} equals last year's closing inventories.`,
          `Opening stock is ${formatINR(openingStock)}, but last year's closing inventories were ${formatINR(prev.buckets.inventories)} (difference ${formatINR(Math.abs(d))}).`,
          d,
        ),
      );
    }
  }
  if (opts.receivablesAgeing) {
    const d = opts.receivablesAgeing.totals.total - buckets.trade_receivables;
    checks.push(
      checkResult(
        "receivables_ageing",
        "Receivables ageing agrees with the balance sheet",
        Math.abs(d) <= tol && opts.receivablesAgeing.issues.length === 0,
        `The receivables ageing schedule adds up to the trade receivables of ${formatINR(buckets.trade_receivables)}.`,
        `The receivables ageing schedule adds up to ${formatINR(opts.receivablesAgeing.totals.total)}, but trade receivables are ${formatINR(buckets.trade_receivables)}.${ageingIssues(opts.receivablesAgeing)}`,
        d,
      ),
    );
  }
  if (opts.payablesAgeing) {
    const d = opts.payablesAgeing.totals.total - buckets.trade_payables;
    checks.push(
      checkResult(
        "payables_ageing",
        "Payables ageing agrees with the balance sheet",
        Math.abs(d) <= tol && opts.payablesAgeing.issues.length === 0,
        `The payables ageing schedule adds up to the trade payables of ${formatINR(buckets.trade_payables)}.`,
        `The payables ageing schedule adds up to ${formatINR(opts.payablesAgeing.totals.total)}, but trade payables are ${formatINR(buckets.trade_payables)}.${ageingIssues(opts.payablesAgeing)}`,
        d,
      ),
    );
  }
  if (opts.msme) {
    const principal = opts.msme.principalUnpaid;
    if (opts.payablesAgeing) {
      const fromAgeing = msmeDuesFromAgeing(opts.payablesAgeing);
      const d = principal - fromAgeing;
      checks.push(
        checkResult(
          "msme_dues",
          "MSME dues agree with the payables ageing",
          Math.abs(d) <= tol,
          `MSME principal unpaid of ${formatINR(principal)} agrees with the MSME rows of the payables ageing.`,
          `MSME principal unpaid is ${formatINR(principal)}, but the MSME rows of the payables ageing add up to ${formatINR(fromAgeing)}.`,
          d,
        ),
      );
    } else {
      checks.push(
        checkResult(
          "msme_dues",
          "MSME dues within trade payables",
          principal <= buckets.trade_payables + tol,
          `MSME principal unpaid of ${formatINR(principal)} is within trade payables of ${formatINR(buckets.trade_payables)}.`,
          `MSME principal unpaid of ${formatINR(principal)} is more than total trade payables of ${formatINR(buckets.trade_payables)}.`,
          null,
        ),
      );
    }
  }

  return {
    profitAndLoss: pnl,
    balanceSheet: bs,
    notes,
    checks,
    allChecksPassed: checks.every((c) => c.status !== "fail"),
    totals: { current, previous, tbDebit, tbCredit },
    figures: { buckets, ledgers: ledgerFigures, profit, closingStock, profitTo },
    unmapped,
    warnings,
  };
}

function ageingIssues(schedule: Pick<AgeingSchedule<string>, "issues">): string {
  return schedule.issues.length > 0 ? ` ${schedule.issues.join(" ")}` : "";
}

function ageingNote<C extends string>(number: number, key: string, title: string, schedule: AgeingSchedule<C>): StatementNote {
  return {
    number,
    key,
    title,
    kind: "ageing",
    lines: [],
    total: { current: schedule.totals.total, previous: null },
    table: {
      columns: ["Not due", ...schedule.bandLabels, "Total"],
      rows: [
        ...schedule.rows.map((r) => ({ label: r.label, values: [r.notDue, ...r.bands, r.total] })),
        { label: "Total", values: [schedule.totals.notDue, ...schedule.totals.bands, schedule.totals.total] },
      ],
    },
    text: null,
  };
}

/** The ledger break-up of one line, with last year's ledger amounts beside this year's. */
function noteLines(
  code: BucketCode,
  ledgers: StatementFigures["ledgers"],
  prev: StatementFigures | null,
  extra: { profit: Paise; profitTo: ProfitDestination; closingStock: Paise },
): NoteLine[] {
  const lines: NoteLine[] = [];
  const prevByKey = new Map<string, Paise>();
  if (prev) {
    for (const l of prev.ledgers) {
      if (l.bucket !== code) continue;
      const k = ledgerKey(l.name);
      prevByKey.set(k, (prevByKey.get(k) ?? 0) + l.amount);
    }
  }
  const shown = new Set<string>();
  const curByKey = new Map<string, { name: string; amount: Paise }>();
  for (const l of ledgers) {
    if (l.bucket !== code) continue;
    const k = ledgerKey(l.name);
    const existing = curByKey.get(k);
    if (existing) existing.amount += l.amount;
    else curByKey.set(k, { name: l.name, amount: l.amount });
  }
  for (const [k, v] of curByKey) {
    shown.add(k);
    lines.push({ label: v.name, current: v.amount, previous: prev ? (prevByKey.get(k) ?? 0) : null });
  }
  if (prev) {
    for (const l of prev.ledgers) {
      const k = ledgerKey(l.name);
      if (l.bucket !== code || shown.has(k)) continue;
      shown.add(k);
      lines.push({ label: l.name, current: 0, previous: prevByKey.get(k) ?? 0 });
    }
  }
  if (code === extra.profitTo || (prev && code === prev.profitTo)) {
    lines.push({
      label: "Profit/(loss) for the year",
      current: code === extra.profitTo ? extra.profit : 0,
      previous: prev ? (code === prev.profitTo ? prev.profit : 0) : null,
    });
  }
  if (code === "inventories" && (extra.closingStock !== 0 || (prev?.closingStock ?? 0) !== 0)) {
    lines.push({ label: "Closing stock", current: extra.closingStock, previous: prev ? prev.closingStock : null });
  }
  if (code === "changes_in_inventories" && (extra.closingStock !== 0 || (prev?.closingStock ?? 0) !== 0)) {
    lines.push({ label: "Less: closing stock", current: -extra.closingStock, previous: prev ? -prev.closingStock : null });
  }
  return lines;
}

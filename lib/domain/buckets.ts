/**
 * Schedule III (Division I) buckets and ledger auto-classification (§6.13, §7.8.3).
 *
 * Every trial-balance ledger maps to exactly one bucket. Classification order:
 *   1. the client's remembered mapping for that ledger (a person chose it; §6.13 "mappings are
 *      remembered per client"),
 *   2. keyword rules on the ledger name (§6.13 "keyword rules first"),
 *   3. the trial-balance group,
 *   4. otherwise "unmapped", for a person to decide.
 * Each answer carries a confidence (shown on the mapping screen) and a plain-English reason. A
 * keyword answer that contradicts the TB group's nature (an income keyword under "Indirect
 * Expenses") or the ledger's balance side is kept but marked low, so a person looks at it.
 *
 * Pure and client-safe.
 */

// -------------------------------------------------------------------------------------------------
// Buckets (§6.13)
// -------------------------------------------------------------------------------------------------

export const BUCKET_CODES = [
  // Equity and liabilities
  "share_capital",
  "reserves_surplus",
  "long_term_borrowings",
  "long_term_provisions",
  "short_term_borrowings",
  "trade_payables",
  "other_current_liabilities",
  "short_term_provisions",
  // Assets
  "ppe",
  "intangible_assets",
  "non_current_investments",
  "long_term_loans_advances",
  "inventories",
  "trade_receivables",
  "cash_bank",
  "short_term_loans_advances",
  "other_current_assets",
  // Profit and loss
  "revenue_from_operations",
  "other_income",
  "changes_in_inventories",
  "purchases",
  "direct_expenses",
  "employee_benefits",
  "finance_costs",
  "depreciation_amortisation",
  "other_expenses",
] as const;
export type BucketCode = (typeof BUCKET_CODES)[number];

export type StatementSection = "equity_liabilities" | "assets" | "profit_loss";
export type BucketGroup =
  | "shareholders_funds"
  | "non_current_liabilities"
  | "current_liabilities"
  | "non_current_assets"
  | "current_assets"
  | "income"
  | "expenses";
/** The broad nature of a bucket, used to spot contradictions. */
export type BucketNature = "liability" | "asset" | "income" | "expense";
export type BalanceSide = "debit" | "credit";

export type BucketDef = {
  code: BucketCode;
  /** The label exactly as §6.13 lists it (the mapping picker shows this). */
  label: string;
  /** The line caption on the statement. */
  statementLabel: string;
  section: StatementSection;
  group: BucketGroup;
  nature: BucketNature;
  /** The side a normal balance sits on: amounts on the statement are measured from this side. */
  normalSide: BalanceSide;
};

const def = (
  code: BucketCode,
  label: string,
  section: StatementSection,
  group: BucketGroup,
  nature: BucketNature,
  statementLabel: string = label,
): BucketDef => ({ code, label, statementLabel, section, group, nature, normalSide: nature === "asset" || nature === "expense" ? "debit" : "credit" });

/** The §6.13 buckets in Schedule III order. */
export const SCHEDULE3_BUCKETS: readonly BucketDef[] = [
  def("share_capital", "Share/partners'/proprietor's capital", "equity_liabilities", "shareholders_funds", "liability"),
  def("reserves_surplus", "Reserves and surplus", "equity_liabilities", "shareholders_funds", "liability"),
  def("long_term_borrowings", "Long-term borrowings", "equity_liabilities", "non_current_liabilities", "liability"),
  def("long_term_provisions", "Long-term provisions", "equity_liabilities", "non_current_liabilities", "liability"),
  def("short_term_borrowings", "Short-term borrowings", "equity_liabilities", "current_liabilities", "liability"),
  def("trade_payables", "Trade payables", "equity_liabilities", "current_liabilities", "liability"),
  def("other_current_liabilities", "Other current liabilities", "equity_liabilities", "current_liabilities", "liability"),
  def("short_term_provisions", "Short-term provisions", "equity_liabilities", "current_liabilities", "liability"),
  def("ppe", "Property, plant and equipment", "assets", "non_current_assets", "asset"),
  def("intangible_assets", "Intangible assets", "assets", "non_current_assets", "asset"),
  def("non_current_investments", "Non-current investments", "assets", "non_current_assets", "asset"),
  def("long_term_loans_advances", "Long-term loans and advances", "assets", "non_current_assets", "asset"),
  def("inventories", "Inventories", "assets", "current_assets", "asset"),
  def("trade_receivables", "Trade receivables", "assets", "current_assets", "asset"),
  def("cash_bank", "Cash and bank balances", "assets", "current_assets", "asset"),
  def("short_term_loans_advances", "Short-term loans and advances", "assets", "current_assets", "asset"),
  def("other_current_assets", "Other current assets", "assets", "current_assets", "asset"),
  def("revenue_from_operations", "Revenue from operations", "profit_loss", "income", "income"),
  def("other_income", "Other income", "profit_loss", "income", "income"),
  def("changes_in_inventories", "Changes in inventories (opening stock)", "profit_loss", "expenses", "expense", "Changes in inventories"),
  def("purchases", "Purchases", "profit_loss", "expenses", "expense"),
  def("direct_expenses", "Direct expenses", "profit_loss", "expenses", "expense"),
  def("employee_benefits", "Employee benefits expense", "profit_loss", "expenses", "expense"),
  def("finance_costs", "Finance costs", "profit_loss", "expenses", "expense"),
  def("depreciation_amortisation", "Depreciation and amortisation", "profit_loss", "expenses", "expense"),
  def("other_expenses", "Other expenses", "profit_loss", "expenses", "expense"),
];

const BY_CODE = new Map<string, BucketDef>(SCHEDULE3_BUCKETS.map((b) => [b.code, b]));

/** The definition of a bucket. */
export function bucketDef(code: BucketCode): BucketDef {
  return BY_CODE.get(code) as BucketDef;
}

/** True for a known bucket code. */
export function isBucketCode(value: unknown): value is BucketCode {
  return typeof value === "string" && BY_CODE.has(value);
}

/** The buckets of one statement section, in Schedule III order. */
export function bucketsIn(section: StatementSection): BucketDef[] {
  return SCHEDULE3_BUCKETS.filter((b) => b.section === section);
}

export const BUCKET_GROUP_LABELS: Record<BucketGroup, string> = {
  shareholders_funds: "Shareholders'/owners' funds",
  non_current_liabilities: "Non-current liabilities",
  current_liabilities: "Current liabilities",
  non_current_assets: "Non-current assets",
  current_assets: "Current assets",
  income: "Income",
  expenses: "Expenses",
};

// -------------------------------------------------------------------------------------------------
// Classification
// -------------------------------------------------------------------------------------------------

export type ClassificationSource = "remembered" | "keyword" | "group" | "unmapped";
export type Confidence = "high" | "medium" | "low" | "none";

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low: please check",
  none: "Not mapped",
};

export type Classification = {
  bucket: BucketCode | null;
  source: ClassificationSource;
  confidence: Confidence;
  /** One plain sentence: why this bucket. */
  reason: string;
};

/** Ledger name → bucket, as remembered for a client (keys are matched after `ledgerKey`). */
export type RememberedMappings = Readonly<Record<string, BucketCode>>;

/** Lower-case, `&` → `and`, punctuation to spaces, collapsed: the text the rules read. */
export function normaliseLedgerText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\ba\s*\/\s*c\b/g, " ac ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** The key a remembered mapping is stored under: the normalised ledger name. */
export function ledgerKey(ledgerName: string): string {
  return normaliseLedgerText(ledgerName).trim();
}

/** Returns a copy of the remembered mappings with this ledger's choice saved (§6.13). */
export function rememberMapping(mappings: RememberedMappings, ledgerName: string, bucket: BucketCode): Record<string, BucketCode> {
  return { ...mappings, [ledgerKey(ledgerName)]: bucket };
}

type Target = BucketCode | null | { debit: BucketCode; credit: BucketCode };

type Rule = {
  /** Matched against `normaliseLedgerText(...)`, which is padded with spaces at both ends. */
  pattern: RegExp;
  target: Target;
  confidence: Exclude<Confidence, "none">;
  /** Shown in the reason: `Keyword “depreciation” in the ledger name.` */
  keyword: string;
};

const r = (pattern: RegExp, target: Target, keyword: string, confidence: Exclude<Confidence, "none"> = "high"): Rule => ({ pattern, target, keyword, confidence });

/**
 * Keyword rules on the ledger name, most specific first (§6.13). The spec's own examples:
 * "interest received"/"dividend"/"rent received" → Other income; "sales"/"professional fee"/
 * "consultancy" → Revenue; "opening stock" → Changes in inventories; "purchase" → Purchases;
 * "depreciation"/"amortis" → Depreciation. A `null` target means "a person must decide".
 */
export const KEYWORD_RULES: readonly Rule[] = [
  // Needs a person.
  r(/ suspense /, null, "suspense"),
  r(/ difference in opening /, null, "difference in opening balances"),

  // Interest first: "Interest on term loan" is a finance cost, not a borrowing.
  r(/ interest (received )?on (it|income tax|tax|gst) refunds? /, "other_income", "interest on refund"),
  r(
    / (interest (paid|expenses?|on (loans?|term loans?|od|overdraft|cash credit|borrowings?|unsecured loans?|secured loans?|vehicle loans?|car loans?|partners? capital|capital|delayed payments?|late payment|tds|gst|income tax))|loan processing|processing (fees?|charges)|borrowing costs?|finance (costs?|charges)) /,
    "finance_costs",
    "interest paid",
  ),

  // Contra and specific balance-sheet items that would otherwise trip a later rule.
  r(/ (accumulated|provision for) (depreciation|depn) /, "ppe", "accumulated depreciation"),
  r(/ accumulated amorti[sz]/, "intangible_assets", "accumulated amortisation"),
  r(/ (provision|allowance) for (doubtful|bad) (debts?|receivables?) /, "trade_receivables", "provision for doubtful debts"),
  r(/ capital work in progress | cwip /, "ppe", "capital work in progress"),
  r(/ capital advances? /, "long_term_loans_advances", "capital advance"),
  r(/ (short|long) term capital gains? | capital gains? /, "other_income", "capital gain"),
  r(/ working capital (loan|demand loan|limit)s? /, "short_term_borrowings", "working capital loan"),

  // Inventory.
  r(/ opening (stock|inventor)/, "changes_in_inventories", "opening stock"),
  r(/ (closing stock|stock in hand|stock in trade|inventory|inventories|finished goods|goods in transit|work in progress) /, "inventories", "stock"),

  // Depreciation (after accumulated depreciation above).
  r(/ depreciat| depn | amorti[sz]/, "depreciation_amortisation", "depreciation"),

  // Equity.
  r(/ drawings? /, "share_capital", "drawings"),
  r(/ (share capital|capital (account|ac)|partners? capital|proprietors? capital|owners? capital|equity shares?|preference shares?) /, "share_capital", "capital"),
  r(/ (reserves?|surplus|securities premium|share premium|retained earnings|profit and loss (ac|account)|p and l (ac|account)|profit loss (ac|account)) /, "reserves_surplus", "reserves"),

  // Borrowings.
  r(/ (cash credit|overdraft|od|occ|od (ac|account)|cc (ac|account)|packing credit|bank od) /, "short_term_borrowings", "overdraft"),
  r(
    / (term loans?|secured loans?|unsecured loans?|vehicle loans?|car loans?|housing loans?|home loans?|business loans?|machinery loans?|bank loans?|debentures?|loans? from (directors?|partners?|relatives?|shareholders?|members?|banks?|related part(y|ies))|loans? (payable|taken)) /,
    "long_term_borrowings",
    "loan",
  ),

  // Provisions (doubtful debts and depreciation handled above).
  r(/ provisions? for (gratuity|leave encashment|leave salary|compensated absences|warrant(y|ies)) /, "long_term_provisions", "provision for gratuity", "medium"),
  r(/ provisions? /, "short_term_provisions", "provision"),

  // Creditors, advances received and payables (before income words: "Dividend payable").
  r(/ creditors? for (expenses?|capital goods|fixed assets?) /, "other_current_liabilities", "creditors for expenses"),
  r(/ (sundry creditors?|trade creditors?|trade payables?|accounts payable|bills payable|creditors?) /, "trade_payables", "creditors"),
  r(/ (deposits? (from|received)|advances? (from|received)|received in advance|customer advances?|unearned|deferred revenue) /, "other_current_liabilities", "advance received"),
  r(/ (output (gst|cgst|sgst|igst|utgst|cess|tax)|payables?|outstanding (expenses?|liabilit(y|ies))|statutory (dues|liabilit(y|ies))|due to) /, "other_current_liabilities", "payable"),
  r(/ (interest accrued|accrued (interest|income)|income accrued) /, "other_current_assets", "accrued income"),

  // Other income (before taxes and deposits: "Interest on FD", "Interest on income tax refund").
  r(
    / (interest (received|income|earned|on (fd|fdr|fixed deposits?|deposits?|savings|it refund|income tax refund|refund))|dividends?|dividend income|rent (received|income)|rental income|commission (received|income|earned)|discount (received|earned)|(profit|gain) on (sale|redemption)|misc(ellaneous)? (income|receipts?)|other income|sundry (income|balances written back)|foreign exchange gains?|insurance claims? received|income from investments?) /,
    "other_income",
    "income received",
  ),

  // Taxes.
  r(/ (input (gst|cgst|sgst|igst|utgst|cess|tax credit)|(gst|cgst|sgst|igst|utgst) (input|receivable|credit|refund|paid)|itc|electronic (cash|credit) ledger) /, "other_current_assets", "input GST"),
  r(/ ((tds|tcs) (receivable|recoverable|deducted|credit|on (sales|receipts?|fees|income))|advance (income )?tax|self assessment tax|income tax (refund|receivable)|mat credit) /, "short_term_loans_advances", "TDS receivable"),
  r(/ (gst|cgst|sgst|igst|utgst) /, { debit: "other_current_assets", credit: "other_current_liabilities" }, "GST", "medium"),
  r(/ (tds|tcs) /, { debit: "short_term_loans_advances", credit: "other_current_liabilities" }, "TDS", "medium"),

  // Bank-related P&L items (before cash and bank).
  r(/ bank (charges|commission) /, "other_expenses", "bank charges"),
  r(/ bank interest | interest (from|by) bank /, { debit: "finance_costs", credit: "other_income" }, "bank interest", "medium"),

  // Deposits and advances given.
  r(/ (fixed deposits?|fd|fdr|term deposits?|recurring deposits?|rd) /, "cash_bank", "fixed deposit"),
  r(/ (security deposits?|rent deposits?|electricity deposits?|telephone deposits?|deposits? with|earnest money|emd|deposits?) /, "long_term_loans_advances", "deposit", "medium"),
  r(/ long term loans? /, "long_term_loans_advances", "long-term loan"),
  r(
    / (staff advances?|salary advances?|advances? (to|paid)|imprest|prepaid|loans? to (staff|employees?)|advance recoverable|recoverable) /,
    "short_term_loans_advances",
    "advance",
  ),

  // Expenses that contain a revenue or employee word.
  r(
    / (sales (promotion|commission|incentives?|discount|expenses?)|legal and professional|legal (fees?|charges|expenses?)|professional (charges|expenses?)|(fees?|charges) paid|consultancy (paid|charges paid)|auditors? remuneration|audit fees?) /,
    "other_expenses",
    "expense",
  ),

  // Revenue.
  r(
    / (sales?( (returns?|ac|account|accounts))?|turnover|revenue|professional (fees?|income|receipts?)|consultancy|consulting (fees?|income)|service (income|charges received|revenue)|fees? (received|income)|income from (operations|services|business|profession)|job work (income|received)|export (sales|income)) /,
    "revenue_from_operations",
    "sales",
  ),

  // Purchases.
  r(/ purchases? | (raw )?materials? consumed | consumption /, "purchases", "purchase"),

  // Direct expenses.
  r(
    / ((freight|carriage|cartage) inwards?|direct (expenses?|labour|labor|wages|costs?)|job work (charges|expenses?)|manufacturing (expenses?|overheads?)|factory (expenses?|rent|power)|power and fuel|consumables?|customs duty|import duty|loading and unloading|clearing and forwarding|sub ?contract)/,
    "direct_expenses",
    "direct expense",
  ),
  r(/ (freight|carriage|cartage) /, "direct_expenses", "freight", "medium"),

  // Employee benefits.
  r(
    / (salar(y|ies)|wages|bonus|staff welfare|employee benefits?|gratuity|leave encashment|incentives?|stipend|remuneration|provident fund|pf contribution|employers? contribution|esi|esic|epf|staff (training|insurance|uniform)|labour charges) /,
    "employee_benefits",
    "salary",
  ),

  r(/ interest /, { debit: "finance_costs", credit: "other_income" }, "interest", "medium"),

  // Other expenses.
  r(
    / (rent|rates and taxes|printing|stationery|telephone|mobile (expenses?|charges|bills?)|internet|electricity|repairs?|maintenance|insurance|travel(l?ing)?|conveyance|office (expenses?|maintenance|supplies|rent)|advertisement|advertising|marketing|business promotion|postage|courier|commission|brokerage|discount allowed|bad debts?|donations?|charity|csr|general expenses?|miscellaneous expenses?|misc expenses?|subscriptions?|membership|fees|filing fees|late fees?|penalty|round(ed)? off|vehicle (running|expenses?|maintenance)|fuel|petrol|software (expenses?|subscriptions?)|website|hosting|security charges|housekeeping|water (charges|expenses?)|books and periodicals|entertainment|gifts?|(freight|carriage) outwards?|packing (materials?|charges|expenses?)|loss on sale|professional tax|amc) /,
    "other_expenses",
    "expense",
  ),
  r(/ (expenses?|exp|charges) /, "other_expenses", "expense", "medium"),

  // Asset nouns (after the expense words, so "Computer repairs" is an expense).
  r(/ (computer software|software|goodwill|trademarks?|patents?|copyrights?|intangibles?|licen[cs]es?) /, "intangible_assets", "software"),
  r(
    / (land|buildings?|plant|machinery|machines?|furniture|fixtures?|computers?|laptops?|printers?|vehicles?|motor (car|cycle|vehicle)s?|cars?|scooters?|office equipments?|equipments?|air conditioners?|electrical (installations?|fittings?)|tools|mobile phones?|fixed assets?|leasehold improvements?) /,
    "ppe",
    "fixed asset",
  ),
  r(/ (investments?|mutual funds?|shares in|bonds?|nsc|kvp|ppf) /, "non_current_investments", "investment", "medium"),
  r(/ (cash in hand|cash on hand|petty cash|cash) /, "cash_bank", "cash"),
  r(
    / (bank|hdfc|icici|sbi|state bank|axis|kotak|canara|indusind|yes bank|idfc|pnb|punjab national|bank of baroda|union bank|federal bank|rbl|bank of india) /,
    "cash_bank",
    "bank",
  ),
  r(/ (sundry debtors?|trade debtors?|trade receivables?|accounts receivable|bills receivable|debtors?) /, "trade_receivables", "debtors"),
  r(/ (other receivables?|receivables?) /, "other_current_assets", "receivable"),
  r(/ (loans? (to|given)|loans and advances|advances?) /, "short_term_loans_advances", "advance", "medium"),
  r(/ stock /, "inventories", "stock", "medium"),

  // Last resorts.
  r(/ income tax /, { debit: "short_term_loans_advances", credit: "short_term_provisions" }, "income tax", "low"),
  r(/ capital /, "share_capital", "capital", "medium"),
  r(/ loans? /, { debit: "short_term_loans_advances", credit: "long_term_borrowings" }, "loan", "low"),
  r(/ income /, "other_income", "income", "medium"),
];

/**
 * Trial-balance group rules (§6.13 "then the TB group"): Tally's standard groups first, then common
 * spellings from other accounting software.
 */
export const GROUP_RULES: readonly Rule[] = [
  r(/ (suspense|branch|divisions?) /, null, "suspense"),
  r(/ (capital (account|ac)|partners? (capital|current)|owners? (funds?|equity)|share capital|shareholders? funds?|equity) /, "share_capital", "Capital Account", "medium"),
  r(/ (reserves?|surplus|retained earnings) /, "reserves_surplus", "Reserves & Surplus", "medium"),
  r(/ (bank od|bank occ|overdraft|cash credit|short term borrowings?) /, "short_term_borrowings", "Bank OD A/c", "medium"),
  r(/ (secured loans?|unsecured loans?|loans? liability|long term borrowings?|borrowings?) /, "long_term_borrowings", "Loans (Liability)", "medium"),
  r(/ (sundry creditors?|trade payables?|accounts payable|creditors?) /, "trade_payables", "Sundry Creditors", "medium"),
  r(/ duties and taxes /, { debit: "other_current_assets", credit: "other_current_liabilities" }, "Duties & Taxes", "medium"),
  r(/ long term provisions? /, "long_term_provisions", "Long-term provisions", "medium"),
  r(/ provisions? /, "short_term_provisions", "Provisions", "medium"),
  r(/ (other )?current liabilit(y|ies) /, "other_current_liabilities", "Current Liabilities", "low"),
  r(/ intangible/, "intangible_assets", "Intangible assets", "medium"),
  r(/ (fixed assets?|property plant|tangible assets?|ppe) /, "ppe", "Fixed Assets", "medium"),
  r(/ investments? /, "non_current_investments", "Investments", "medium"),
  r(/ long term loans? /, "long_term_loans_advances", "Long-term loans and advances", "medium"),
  r(/ deposits? /, "long_term_loans_advances", "Deposits (Asset)", "medium"),
  r(/ (loans and advances|short term loans?) /, "short_term_loans_advances", "Loans & Advances (Asset)", "medium"),
  r(/ (stock in hand|inventor(y|ies)|stock) /, "inventories", "Stock-in-hand", "medium"),
  r(/ (sundry debtors?|trade receivables?|accounts receivable|debtors?) /, "trade_receivables", "Sundry Debtors", "medium"),
  r(/ (bank accounts?|bank) /, { debit: "cash_bank", credit: "short_term_borrowings" }, "Bank Accounts", "medium"),
  r(/ (cash in hand|cash and (cash equivalents|bank)|cash) /, "cash_bank", "Cash-in-hand", "medium"),
  r(/ misc(ellaneous)? expenses asset /, "other_current_assets", "Misc. Expenses (Asset)", "low"),
  r(/ (other )?current assets? /, "other_current_assets", "Current Assets", "low"),
  r(/ (sales accounts?|revenue from operations|sales|revenue|direct incomes?|income direct|operating income) /, "revenue_from_operations", "Sales Accounts", "medium"),
  r(/ (indirect incomes?|income indirect|other income|non operating income) /, "other_income", "Indirect Incomes", "medium"),
  r(/ (purchase accounts?|purchases?|cost of (goods|sales|materials)) /, "purchases", "Purchase Accounts", "medium"),
  r(/ (direct expenses?|expenses direct|manufacturing expenses?) /, "direct_expenses", "Direct Expenses", "medium"),
  r(/ employee/, "employee_benefits", "Employee benefits", "medium"),
  r(/ finance costs? /, "finance_costs", "Finance costs", "medium"),
  r(/ depreciation/, "depreciation_amortisation", "Depreciation", "medium"),
  r(/ (indirect expenses?|expenses indirect|other expenses?|administrative|selling) /, "other_expenses", "Indirect Expenses", "medium"),
  r(/ incomes? /, "other_income", "Income", "low"),
  r(/ expenses? /, "other_expenses", "Expenses", "low"),
];

type RuleHit = { rule: Rule; bucket: BucketCode | null };

function resolveTarget(target: Target, side: BalanceSide | null | undefined): BucketCode | null {
  if (target === null || typeof target === "string") return target;
  return side === "credit" ? target.credit : target.debit;
}

function firstHit(rules: readonly Rule[], text: string, side: BalanceSide | null | undefined): RuleHit | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return { rule, bucket: resolveTarget(rule.target, side) };
  }
  return null;
}

const LOWER: Record<Exclude<Confidence, "none">, Exclude<Confidence, "none">> = { high: "medium", medium: "low", low: "low" };

/**
 * Classifies one trial-balance ledger into a Schedule III bucket (§6.13): remembered mapping, then
 * keyword rules, then the TB group, then unmapped. `side` (the ledger's balance side) settles
 * ledgers such as "CGST" or "Interest" that can sit on either side, and flags a revenue keyword on
 * a debit balance.
 */
export function autoClassify(
  ledgerName: string,
  tbGroup?: string | null,
  rememberedMappings?: RememberedMappings | null,
  opts: { side?: BalanceSide | null } = {},
): Classification {
  const side = opts.side ?? null;
  const remembered = rememberedMappings?.[ledgerKey(ledgerName)];
  if (remembered !== undefined && isBucketCode(remembered)) {
    return { bucket: remembered, source: "remembered", confidence: "high", reason: `Mapped to ${bucketDef(remembered).label} for this client before.` };
  }

  const name = normaliseLedgerText(ledgerName);
  const group = tbGroup ? normaliseLedgerText(tbGroup) : "";
  const groupHit = group.trim() !== "" ? firstHit(GROUP_RULES, group, side) : null;
  const keywordHit = name.trim() !== "" ? firstHit(KEYWORD_RULES, name, side) : null;

  if (keywordHit) {
    if (keywordHit.bucket === null) {
      return { bucket: null, source: "unmapped", confidence: "none", reason: `“${ledgerName.trim()}” needs a decision: a ${keywordHit.rule.keyword} ledger can't be placed automatically.` };
    }
    const bucket = keywordHit.bucket;
    const b = bucketDef(bucket);
    let confidence = keywordHit.rule.confidence;
    let reason = `Keyword “${keywordHit.rule.keyword}” in the ledger name.`;
    const groupSideless = groupHit !== null && groupHit.rule.target !== null && typeof groupHit.rule.target === "object" && !side;
    const groupBucket = groupSideless ? null : (groupHit?.bucket ?? null);
    if (groupBucket && bucketDef(groupBucket).nature !== b.nature) {
      confidence = "low";
      reason = `Keyword “${keywordHit.rule.keyword}” in the ledger name, but the TB group “${(tbGroup ?? "").trim()}” suggests ${bucketDef(groupBucket).label}. Please check.`;
    } else if (side && b.section === "profit_loss" && side !== b.normalSide && bucket !== "changes_in_inventories") {
      confidence = LOWER[confidence];
      reason = `Keyword “${keywordHit.rule.keyword}” in the ledger name, but it has a ${side} balance. Please check.`;
    }
    return { bucket, source: "keyword", confidence, reason };
  }

  if (groupHit) {
    if (groupHit.bucket === null) {
      return { bucket: null, source: "unmapped", confidence: "none", reason: `The TB group “${(tbGroup ?? "").trim()}” needs a decision.` };
    }
    return { bucket: groupHit.bucket, source: "group", confidence: groupHit.rule.confidence, reason: `From the TB group “${(tbGroup ?? "").trim()}”.` };
  }

  return { bucket: null, source: "unmapped", confidence: "none", reason: "No keyword or TB group matched. Choose a bucket." };
}

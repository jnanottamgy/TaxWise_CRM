import { z } from "zod";
import { fyEnd, isFinancialYear, previousFinancialYear, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { BUCKET_CODES, CONFIDENCE_LABELS, bucketDef, isBucketCode, type BucketCode, type ClassificationSource, type Confidence } from "@/lib/domain/buckets";
import {
  MSME_DISCLOSURE_ITEMS,
  PAYABLE_CATEGORIES,
  RECEIVABLE_CATEGORIES,
  TB_FIELDS,
  buildPayablesAgeing,
  buildReceivablesAgeing,
  buildStatements,
  type AgeingItem,
  type BuildStatementsOptions,
  type MsmeDisclosure,
  type MsmeDisclosureKey,
  type PayableCategory,
  type ProfitDestination,
  type ReceivableCategory,
  type StatementFigures,
  type Statements,
  type TbField,
} from "@/lib/domain/schedule3";
import { paiseToDecimalString, parseAmount, type Paise } from "@/lib/domain/money";
import { pdfFileName } from "@/lib/format";
import type { EntityType } from "@/lib/domain/enums";
import type { StatusTone } from "@/lib/status";

/**
 * Financial statements workpapers (§6.13, §7.8.3): the shared zod schemas for the forms and the
 * server actions, the stored shapes of financial_statements.ledgers / inputs / statements (amounts
 * in integer paise), the Draft → Reviewed → Final words, and `rebuildStatements`, the one place the
 * inputs become lib/domain/schedule3.ts options, so the editor's live preview and the server's save
 * compute exactly the same figures. Client-safe and pure.
 */

// =================================================================================================
// Status (§7.8.3 "Draft → Reviewed → Final (Final only Manager/Partner)")
// =================================================================================================

export const FS_STATUSES = ["draft", "reviewed", "final"] as const;
export type FsStatus = (typeof FS_STATUSES)[number];

export const FS_STATUS_META: Record<FsStatus, { label: string; tone: StatusTone; meaning: string }> = {
  draft: { label: "Draft", tone: "muted", meaning: "Draft: being prepared. Map every ledger and clear the checks, then ask a colleague to review it." },
  reviewed: {
    label: "Reviewed",
    tone: "violet",
    meaning: "Reviewed: someone other than the preparer has checked it. A Manager or Partner marks it final; changing a figure sends it back to Draft.",
  },
  final: { label: "Final", tone: "success", meaning: "Final: locked. Next year's statement takes its comparatives from it. A Manager or Partner can reopen it." },
};

export function isFsStatus(v: unknown): v is FsStatus {
  return typeof v === "string" && (FS_STATUSES as readonly string[]).includes(v);
}

// =================================================================================================
// Table state
// =================================================================================================

export const FS_LIST_SORTABLE = ["financial_year", "client_name", "status", "updated_at", "unmapped_count"] as const;
export const FS_LIST_FILTERS = { status: FS_STATUSES, client: null, checks: ["failing", "passing"] } as const;
export const FS_LIST_DEFAULT_SORT = { sort: "updated_at" as const, dir: "desc" as const };

export const FS_TABS = ["ledgers", "balance-sheet", "profit-loss", "notes", "disclosures"] as const;
export type FsTab = (typeof FS_TABS)[number];
export const FS_TAB_LABELS: Record<FsTab, string> = {
  ledgers: "Ledger mapping",
  "balance-sheet": "Balance sheet",
  "profit-loss": "Profit and loss",
  notes: "Notes",
  disclosures: "Inputs and disclosures",
};
export function isFsTab(v: unknown): v is FsTab {
  return typeof v === "string" && (FS_TABS as readonly string[]).includes(v);
}

// =================================================================================================
// Stored ledgers (§5.10: name, group, debit, credit, bucket, matched)
// =================================================================================================

export type LedgerSource = ClassificationSource | "manual";

export type StoredLedger = {
  name: string;
  group: string | null;
  debit: Paise;
  credit: Paise;
  /** Spreadsheet row (0 when entered by hand). */
  row: number;
  bucket: BucketCode | null;
  /** True when a bucket is set. */
  matched: boolean;
  source: LedgerSource;
  confidence: Confidence;
  reason: string;
};

export const LEDGER_SOURCE_LABELS: Record<LedgerSource, string> = {
  remembered: "Remembered for this client",
  keyword: "Keyword in the name",
  group: "From the TB group",
  unmapped: "Not mapped",
  manual: "Chosen here",
};

export { CONFIDENCE_LABELS };

const CONFIDENCES = new Set<string>(["high", "medium", "low", "none"]);
const SOURCES = new Set<string>(["remembered", "keyword", "group", "unmapped", "manual"]);

function int(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : 0;
}

/** Reads financial_statements.ledgers; anything malformed is dropped. */
export function readLedgers(value: unknown): StoredLedger[] {
  if (!Array.isArray(value)) return [];
  const out: StoredLedger[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.name !== "string") continue;
    const bucket = isBucketCode(v.bucket) ? v.bucket : null;
    out.push({
      name: v.name,
      group: typeof v.group === "string" && v.group !== "" ? v.group : null,
      debit: Math.max(0, int(v.debit)),
      credit: Math.max(0, int(v.credit)),
      row: int(v.row),
      bucket,
      matched: bucket !== null,
      source: typeof v.source === "string" && SOURCES.has(v.source) ? (v.source as LedgerSource) : bucket ? "manual" : "unmapped",
      confidence: typeof v.confidence === "string" && CONFIDENCES.has(v.confidence) ? (v.confidence as Confidence) : bucket ? "high" : "none",
      reason: typeof v.reason === "string" ? v.reason : "",
    });
  }
  return out;
}

/** True when a person should look at the ledger: unmapped, or a low-confidence guess. */
export function needsAttention(l: Pick<StoredLedger, "bucket" | "confidence">): boolean {
  return l.bucket === null || l.confidence === "low" || l.confidence === "none";
}

/** Applies a person's bucket choices (by ledger index) to the ledgers. */
export function applyBucketChoices(ledgers: readonly StoredLedger[], choices: ReadonlyArray<{ index: number; bucket: BucketCode | null }>): StoredLedger[] {
  const byIndex = new Map(choices.map((c) => [c.index, c.bucket] as const));
  return ledgers.map((l, i) => {
    if (!byIndex.has(i)) return l;
    const bucket = byIndex.get(i) ?? null;
    if (bucket === l.bucket) return l;
    return bucket
      ? { ...l, bucket, matched: true, source: "manual", confidence: "high", reason: `Chosen by hand: ${bucketDef(bucket).label}.` }
      : { ...l, bucket: null, matched: false, source: "unmapped", confidence: "none", reason: "Left unmapped by hand. Choose a bucket." };
  });
}

// =================================================================================================
// Inputs (financial_statements.inputs)
// =================================================================================================

export type TbImport = {
  documentId: string | null;
  fileName: string | null;
  sheet: string | null;
  headerRow: number | null;
  mapping: Record<TbField, string | null>;
  positiveBalanceIs: "debit" | "credit";
};

export type StoredAgeingItem<C extends string> = { party: string | null; category: C; amount: Paise; dueDate: DateString | null; transactionDate: DateString | null };

export type FsInputs = {
  version: 1;
  profitTo: ProfitDestination;
  /** Closing stock entered as an adjustment (§6.13); null when the TB carries it or there is none. */
  closingStock: Paise | null;
  equityAdjustments: Array<{ label: string; amount: Paise }>;
  receivablesAgeing: boolean;
  receivables: Array<StoredAgeingItem<ReceivableCategory>>;
  payablesAgeing: boolean;
  payables: Array<StoredAgeingItem<PayableCategory>>;
  msme: MsmeDisclosure | null;
  /** Note 1, significant accounting policies (the engagement team writes it). */
  policies: string | null;
  /** Free text added to other notes, by note key (a bucket code, or receivables_ageing …). */
  noteTexts: Record<string, string>;
  tb: TbImport | null;
};

const COMPANIES = new Set<EntityType>(["pvt_ltd", "public_ltd", "section_8", "trust", "other"]);

/** Where the year's profit goes (§6.13): reserves for companies and trusts; capital for firms, LLPs, proprietors, HUFs. */
export function defaultProfitTo(entityType: EntityType | string | null | undefined): ProfitDestination {
  return entityType && COMPANIES.has(entityType as EntityType) ? "reserves_surplus" : "share_capital";
}

export const PROFIT_TO_LABELS: Record<ProfitDestination, string> = {
  reserves_surplus: "Reserves and surplus (companies, trusts)",
  share_capital: "Capital account (firms, LLPs, proprietors, HUFs)",
};

export function emptyInputs(entityType: EntityType | string | null | undefined): FsInputs {
  return {
    version: 1,
    profitTo: defaultProfitTo(entityType),
    closingStock: null,
    equityAdjustments: [],
    receivablesAgeing: false,
    receivables: [],
    payablesAgeing: false,
    payables: [],
    msme: null,
    policies: null,
    noteTexts: {},
    tb: null,
  };
}

const RECEIVABLES = new Set<string>(RECEIVABLE_CATEGORIES);
const PAYABLES = new Set<string>(PAYABLE_CATEGORIES);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readItems<C extends string>(value: unknown, allowed: Set<string>): Array<StoredAgeingItem<C>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && allowed.has(String((x as Record<string, unknown>).category)))
    .map((x) => ({
      party: typeof x.party === "string" && x.party !== "" ? x.party : null,
      category: x.category as C,
      amount: Math.max(0, int(x.amount)),
      dueDate: typeof x.dueDate === "string" && DATE.test(x.dueDate) ? x.dueDate : null,
      transactionDate: typeof x.transactionDate === "string" && DATE.test(x.transactionDate) ? x.transactionDate : null,
    }));
}

/** Reads financial_statements.inputs, filling what's missing from the defaults. */
export function readInputs(value: unknown, entityType: EntityType | string | null | undefined): FsInputs {
  const base = emptyInputs(entityType);
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const v = value as Record<string, unknown>;
  const msme = v.msme && typeof v.msme === "object" ? (v.msme as Record<string, unknown>) : null;
  const tb = v.tb && typeof v.tb === "object" ? (v.tb as Record<string, unknown>) : null;
  const mapping = tb?.mapping && typeof tb.mapping === "object" ? (tb.mapping as Record<string, unknown>) : {};
  return {
    version: 1,
    profitTo: v.profitTo === "share_capital" || v.profitTo === "reserves_surplus" ? v.profitTo : base.profitTo,
    closingStock: typeof v.closingStock === "number" && Number.isSafeInteger(v.closingStock) ? v.closingStock : null,
    equityAdjustments: Array.isArray(v.equityAdjustments)
      ? v.equityAdjustments
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x) => ({ label: typeof x.label === "string" ? x.label : "", amount: int(x.amount) }))
          .filter((x) => x.label !== "")
      : [],
    receivablesAgeing: v.receivablesAgeing === true,
    receivables: readItems<ReceivableCategory>(v.receivables, RECEIVABLES),
    payablesAgeing: v.payablesAgeing === true,
    payables: readItems<PayableCategory>(v.payables, PAYABLES),
    msme: msme ? (Object.fromEntries(MSME_DISCLOSURE_ITEMS.map((i) => [i.key, Math.max(0, int(msme[i.key]))])) as MsmeDisclosure) : null,
    policies: typeof v.policies === "string" && v.policies.trim() !== "" ? v.policies : null,
    noteTexts:
      v.noteTexts && typeof v.noteTexts === "object"
        ? Object.fromEntries(Object.entries(v.noteTexts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""))
        : {},
    tb: tb
      ? {
          documentId: typeof tb.documentId === "string" ? tb.documentId : null,
          fileName: typeof tb.fileName === "string" ? tb.fileName : null,
          sheet: typeof tb.sheet === "string" ? tb.sheet : null,
          headerRow: typeof tb.headerRow === "number" ? tb.headerRow : null,
          mapping: Object.fromEntries(TB_FIELDS.map((f) => [f, typeof mapping[f] === "string" ? (mapping[f] as string) : null])) as Record<TbField, string | null>,
          positiveBalanceIs: tb.positiveBalanceIs === "credit" ? "credit" : "debit",
        }
      : null,
  };
}

/** The as-on date of the ageing schedules: the end of the financial year. */
export function balanceSheetDate(fy: FinancialYear): DateString {
  return fyEnd(fy);
}

/**
 * The statements for a set of ledgers and inputs (§6.13), with last year's saved figures as the
 * comparatives. The editor's preview and the server's save both call this.
 */
export function rebuildStatements(
  ledgers: readonly StoredLedger[],
  inputs: FsInputs,
  opts: { financialYear: FinancialYear; previous: Partial<StatementFigures> | null },
): Statements {
  const asOn = balanceSheetDate(opts.financialYear);
  const options: BuildStatementsOptions = {
    previousYear: opts.previous,
    closingStock: inputs.closingStock,
    profitTo: inputs.profitTo,
    equityAdjustments: inputs.equityAdjustments,
    receivablesAgeing: inputs.receivablesAgeing ? buildReceivablesAgeing(inputs.receivables as Array<AgeingItem<ReceivableCategory>>, asOn) : null,
    payablesAgeing: inputs.payablesAgeing ? buildPayablesAgeing(inputs.payables as Array<AgeingItem<PayableCategory>>, asOn) : null,
    msme: inputs.msme,
  };
  return buildStatements(
    ledgers.map((l) => ({ name: l.name, group: l.group, debit: l.debit, credit: l.credit, bucket: l.bucket })),
    options,
  );
}

/** Last year's saved figures inside a stored statements column; null when there are none. */
export function readFigures(statements: unknown): Partial<StatementFigures> | null {
  if (!statements || typeof statements !== "object") return null;
  const f = (statements as Record<string, unknown>).figures;
  if (!f || typeof f !== "object") return null;
  const v = f as Record<string, unknown>;
  if (!v.buckets || typeof v.buckets !== "object") return null;
  const buckets = {} as Record<BucketCode, Paise>;
  for (const c of BUCKET_CODES) buckets[c] = int((v.buckets as Record<string, unknown>)[c]);
  return {
    buckets,
    ledgers: Array.isArray(v.ledgers)
      ? (v.ledgers as Array<Record<string, unknown>>)
          .filter((l) => typeof l?.name === "string" && isBucketCode(l?.bucket))
          .map((l) => ({ name: l.name as string, bucket: l.bucket as BucketCode, amount: int(l.amount) }))
      : [],
    profit: int(v.profit),
    closingStock: int(v.closingStock),
    profitTo: v.profitTo === "share_capital" ? "share_capital" : "reserves_surplus",
  };
}

/** Reads a stored statements column for display; null when it isn't one (the fixture rows). */
export function readStatements(value: unknown): Statements | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Statements>;
  if (!Array.isArray(v.profitAndLoss) || !Array.isArray(v.balanceSheet) || !Array.isArray(v.checks) || !v.totals || !v.figures) return null;
  return v as Statements;
}

/**
 * True when stored statements are the ones the server would build now from the same trial balance
 * and inputs (§6.13: figures are always built on the server): the same year's figures for every
 * bucket, the same profit and closing stock, and the same overall check result. A statement saved
 * some other way, or left stale by a change to last year's figures, doesn't agree.
 */
export function statementsAgree(stored: Statements | null, rebuilt: Statements): boolean {
  if (!stored || !stored.figures || !stored.figures.buckets) return false;
  const a = stored.figures;
  const b = rebuilt.figures;
  if (a.profit !== b.profit || a.closingStock !== b.closingStock) return false;
  for (const c of BUCKET_CODES) if ((a.buckets[c] ?? 0) !== (b.buckets[c] ?? 0)) return false;
  return Boolean(stored.allChecksPassed) === rebuilt.allChecksPassed;
}

/** The previous financial year, for the comparatives. */
export function comparativeYear(fy: FinancialYear): FinancialYear {
  return previousFinancialYear(fy);
}

/** The PDF's file name: "Financial statements TW-C-0042-FY-2026-27.pdf". */
export function financialStatementsFileName(clientCode: string, fy: string): string {
  return pdfFileName(`${clientCode} FY ${fy}`, "Financial statements");
}

// =================================================================================================
// Forms (money as rupee strings, as MoneyInput gives them; the server turns them into paise)
// =================================================================================================

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const fy = z
  .string({ error: "Choose the financial year." })
  .trim()
  .refine((v) => isFinancialYear(v), { error: "Choose the financial year." });

function rupees(opts: { allowNegative?: boolean; positive?: boolean; required?: boolean; label: string }) {
  return z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v, ctx): Paise | null => {
      const text = v === null || v === undefined ? "" : String(v).trim();
      if (text === "") {
        if (opts.required) ctx.addIssue({ code: "custom", message: `Enter the ${opts.label}.` });
        return null;
      }
      const parsed = parseAmount(text, { allowNegative: opts.allowNegative });
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: parsed.error });
        return null;
      }
      if (opts.positive && parsed.paise <= 0) {
        ctx.addIssue({ code: "custom", message: `The ${opts.label} must be more than zero.` });
        return null;
      }
      return parsed.paise;
    });
}

const optionalDate = z
  .union([z.string().trim(), z.null()])
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || DATE.test(v), { error: "Enter a date, for example 31 Mar 2026." });

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

const ageingRow = <C extends readonly [string, ...string[]]>(categories: C) =>
  z
    .object({
      party: text(120),
      category: z.enum(categories, { error: "Choose the category." }),
      amount: rupees({ positive: true, required: true, label: "amount" }),
      dueDate: optionalDate,
      transactionDate: optionalDate,
    })
    .superRefine((v, ctx) => {
      if (!v.dueDate && !v.transactionDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Enter the due date, or the date of the transaction." });
    });

const msmeShape = Object.fromEntries(MSME_DISCLOSURE_ITEMS.map((i) => [i.key, rupees({ label: "amount" })])) as Record<MsmeDisclosureKey, ReturnType<typeof rupees>>;

export const FsInputsFormSchema = z.object({
  profitTo: z.enum(["reserves_surplus", "share_capital"]),
  closingStock: rupees({ label: "closing stock" }),
  equityAdjustments: z
    .array(z.object({ label: z.string().trim().min(1, { error: "Name the movement (capital introduced, drawings, dividend …)." }).max(120), amount: rupees({ allowNegative: true, required: true, label: "amount" }) }))
    .max(20, { error: "Enter at most 20 movements." }),
  receivablesAgeing: z.boolean(),
  receivables: z.array(ageingRow(RECEIVABLE_CATEGORIES)).max(2000, { error: "Enter at most 2,000 receivables." }),
  payablesAgeing: z.boolean(),
  payables: z.array(ageingRow(PAYABLE_CATEGORIES)).max(2000, { error: "Enter at most 2,000 payables." }),
  msmeEnabled: z.boolean(),
  msme: z.object(msmeShape),
  policies: text(8000),
  noteTexts: z.record(z.string().max(60), z.string().max(4000, { error: "Keep a note under 4,000 characters." })).default({}),
});
export type FsInputsForm = z.input<typeof FsInputsFormSchema>;
export type FsInputsParsed = z.output<typeof FsInputsFormSchema>;

/** The parsed form as stored inputs (keeps the import settings, which the form doesn't edit). */
export function inputsFromForm(form: FsInputsParsed, tb: TbImport | null): FsInputs {
  return {
    version: 1,
    profitTo: form.profitTo,
    closingStock: form.closingStock,
    equityAdjustments: form.equityAdjustments.map((a) => ({ label: a.label, amount: a.amount ?? 0 })),
    receivablesAgeing: form.receivablesAgeing,
    receivables: form.receivables.map((r) => ({ party: r.party, category: r.category, amount: r.amount ?? 0, dueDate: r.dueDate, transactionDate: r.transactionDate })),
    payablesAgeing: form.payablesAgeing,
    payables: form.payables.map((r) => ({ party: r.party, category: r.category, amount: r.amount ?? 0, dueDate: r.dueDate, transactionDate: r.transactionDate })),
    msme: form.msmeEnabled ? (Object.fromEntries(MSME_DISCLOSURE_ITEMS.map((i) => [i.key, form.msme[i.key] ?? 0])) as MsmeDisclosure) : null,
    policies: form.policies,
    noteTexts: Object.fromEntries(Object.entries(form.noteTexts).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== "")),
    tb,
  };
}

function lenientPaise(v: unknown, allowNegative = false): Paise | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (s === "") return null;
  const parsed = parseAmount(s, { allowNegative });
  return parsed.ok ? parsed.paise : null;
}

function lenientItems<C extends string>(rows: unknown, allowed: Set<string>): Array<StoredAgeingItem<C>> {
  if (!Array.isArray(rows)) return [];
  const out: Array<StoredAgeingItem<C>> = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const amount = lenientPaise(r.amount);
    const dueDate = typeof r.dueDate === "string" && DATE.test(r.dueDate) ? r.dueDate : null;
    const transactionDate = typeof r.transactionDate === "string" && DATE.test(r.transactionDate) ? r.transactionDate : null;
    if (!allowed.has(String(r.category)) || amount === null || amount <= 0 || (!dueDate && !transactionDate)) continue;
    out.push({ party: typeof r.party === "string" && r.party.trim() !== "" ? r.party.trim() : null, category: r.category as C, amount, dueDate, transactionDate });
  }
  return out;
}

/**
 * The inputs as they stand in the editor, for the live preview: the parsed form when it is valid;
 * otherwise every value that reads (a half-typed amount counts as nothing, an ageing row without an
 * amount or a date is left out), so the preview follows the person's typing. The server's save
 * still validates the form strictly.
 */
export function previewInputs(form: FsInputsForm, tb: TbImport | null): FsInputs {
  const parsed = FsInputsFormSchema.safeParse(form);
  if (parsed.success) return inputsFromForm(parsed.data, tb);
  const msme = (form.msme ?? {}) as Record<string, unknown>;
  const notes = (form.noteTexts ?? {}) as Record<string, unknown>;
  const policies = typeof form.policies === "string" ? form.policies.trim() : "";
  return {
    version: 1,
    profitTo: form.profitTo === "share_capital" ? "share_capital" : "reserves_surplus",
    closingStock: lenientPaise(form.closingStock),
    equityAdjustments: (form.equityAdjustments ?? [])
      .map((a) => ({ label: String(a?.label ?? "").trim() || "Other movement", amount: lenientPaise(a?.amount, true) ?? 0 }))
      .filter((a) => a.amount !== 0),
    receivablesAgeing: form.receivablesAgeing === true,
    receivables: lenientItems<ReceivableCategory>(form.receivables, RECEIVABLES),
    payablesAgeing: form.payablesAgeing === true,
    payables: lenientItems<PayableCategory>(form.payables, PAYABLES),
    msme: form.msmeEnabled ? (Object.fromEntries(MSME_DISCLOSURE_ITEMS.map((i) => [i.key, Math.max(0, lenientPaise(msme[i.key]) ?? 0)])) as MsmeDisclosure) : null,
    policies: policies === "" ? null : policies,
    noteTexts: Object.fromEntries(Object.entries(notes).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "").map(([k, v]) => [k, v.trim()])),
    tb,
  };
}

const money = (p: Paise | null | undefined) => (p === null || p === undefined ? "" : paiseToDecimalString(p));

/** Stored inputs as the form's starting values. */
export function formFromInputs(inputs: FsInputs): FsInputsForm {
  return {
    profitTo: inputs.profitTo,
    closingStock: money(inputs.closingStock),
    equityAdjustments: inputs.equityAdjustments.map((a) => ({ label: a.label, amount: money(a.amount) })),
    receivablesAgeing: inputs.receivablesAgeing,
    receivables: inputs.receivables.map((r) => ({ party: r.party ?? "", category: r.category, amount: money(r.amount), dueDate: r.dueDate ?? "", transactionDate: r.transactionDate ?? "" })),
    payablesAgeing: inputs.payablesAgeing,
    payables: inputs.payables.map((r) => ({ party: r.party ?? "", category: r.category, amount: money(r.amount), dueDate: r.dueDate ?? "", transactionDate: r.transactionDate ?? "" })),
    msmeEnabled: inputs.msme !== null,
    msme: Object.fromEntries(MSME_DISCLOSURE_ITEMS.map((i) => [i.key, inputs.msme ? money(inputs.msme[i.key]) : ""])) as Record<MsmeDisclosureKey, string>,
    policies: inputs.policies ?? "",
    noteTexts: { ...inputs.noteTexts },
  };
}

const tbHeader = z
  .string()
  .max(200)
  .nullish()
  .transform((v) => (v ? v : null));

export const TbMappingSchema = z.object(Object.fromEntries(TB_FIELDS.map((f) => [f, tbHeader])) as Record<TbField, typeof tbHeader>);

const sheetChoice = z.object({
  documentId: uuid("file"),
  sheet: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => (v ? v : null)),
  headerRow: z.number().int().min(1).max(50).nullish().transform((v) => v ?? null),
});

export const TrialBalanceImportSchema = z.object({
  file: sheetChoice,
  mapping: TbMappingSchema,
  positiveBalanceIs: z.enum(["debit", "credit"]).default("debit"),
  rememberMapping: z.boolean().default(true),
});

export const CreateStatementSchema = TrialBalanceImportSchema.extend({ clientId: uuid("client"), financialYear: fy });
export type CreateStatementInput = z.input<typeof CreateStatementSchema>;

export const ReplaceTrialBalanceSchema = TrialBalanceImportSchema.extend({ id: uuid("statement"), updatedAt: z.string().min(10).max(40) });
export type ReplaceTrialBalanceInput = z.input<typeof ReplaceTrialBalanceSchema>;

export const BucketChoiceSchema = z.object({
  index: z.number().int().min(0).max(20000),
  bucket: z
    .enum(BUCKET_CODES)
    .nullish()
    .transform((v) => v ?? null),
});

export const SaveStatementSchema = z.object({
  id: uuid("statement"),
  updatedAt: z.string().min(10).max(40),
  buckets: z.array(BucketChoiceSchema).max(20000).default([]),
  inputs: FsInputsFormSchema,
  /** Remember the buckets chosen here for the client's next year (§6.13). */
  rememberBuckets: z.boolean().default(true),
  autosave: z.boolean().default(false),
});
export type SaveStatementInput = z.input<typeof SaveStatementSchema>;

export const StatementStatusSchema = z
  .object({
    id: uuid("statement"),
    updatedAt: z.string().min(10).max(40),
    status: z.enum(FS_STATUSES),
    note: text(1000),
  })
  .superRefine((v, ctx) => {
    if (v.status === "draft" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Say why it goes back to Draft, so the preparer knows what to change." });
  });
export type StatementStatusInput = z.input<typeof StatementStatusSchema>;

export const StatementLookupSchema = z.object({ clientId: uuid("client"), financialYear: fy });

export const StatementRefSchema = z.object({ id: uuid("statement") });

export const CLIENT_SEARCH = z.object({ q: z.string().trim().max(100).default("") });

/** The year label on statements: "Year ended 31 March 2026". */
export function yearEndedLabel(fyLabel: FinancialYear): string {
  const end = fyEnd(fyLabel);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(end.slice(8, 10))} ${months[Number(end.slice(5, 7)) - 1]} ${end.slice(0, 4)}`;
}

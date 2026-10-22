/**
 * GST reconciliation inputs (§6.12, §7.8.1): the GSTR-2B JSON downloaded from the GST portal and the
 * client's purchase register (CSV/XLSX rows after the column-mapping step). Both are normalised into
 * the same document row, so the matching engine (`lib/domain/recon.ts`) compares like with like.
 *
 * - Amounts are integer paise and carry their effect on ITC: invoices, debit notes, ISD invoices and
 *   bills of entry are positive; credit notes (and ISD credit notes) are negative.
 * - Dates are `'YYYY-MM-DD'`; the portal writes `DD-MM-YYYY`.
 * - Values may sit on the document (`txval`, `igst` …) or only on its items (`items[]`, or the GSTR-1
 *   style `itms[].itm_det`); both are read. When both are present the document total wins.
 * - Nothing here throws on bad input: problems come back as diagnostics (the 2B file) or per-row
 *   issues (the register), each one plain sentence.
 * - The spreadsheet helpers (cell amounts, cell dates, header matching) are shared with the
 *   trial-balance import (§6.13, `lib/domain/schedule3.ts`).
 *
 * Pure and client-safe.
 */

import { addDays, isDateString, istDateOf, MONTH_ABBR, toDateString, type DateString } from "@/lib/domain/fy";
import { validateGstin } from "@/lib/domain/india-validators";
import { toPaise, type Paise } from "@/lib/domain/money";
import type { FieldErrors } from "@/lib/result";

// -------------------------------------------------------------------------------------------------
// The normalised document row
// -------------------------------------------------------------------------------------------------

/** The GSTR-2B sections the engine reads (§6.12 names B2B, B2BA, CDNR, CDNRA, ISD and IMPG). */
export const GSTR2B_SECTIONS = ["b2b", "b2ba", "cdnr", "cdnra", "isd", "isda", "impg", "impgsez"] as const;
export type Gstr2bSection = (typeof GSTR2B_SECTIONS)[number];

/** Where a row came from: a 2B section, or the client's purchase register. */
export type DocSource = Gstr2bSection | "register";

export const GSTR2B_SECTION_LABELS: Record<Gstr2bSection, string> = {
  b2b: "B2B invoices",
  b2ba: "B2B invoices (amended)",
  cdnr: "Credit/debit notes",
  cdnra: "Credit/debit notes (amended)",
  isd: "ISD credits",
  isda: "ISD credits (amended)",
  impg: "Import of goods",
  impgsez: "Import of goods from SEZ",
};

export const GST_DOC_TYPES = ["invoice", "debit_note", "credit_note", "isd_invoice", "isd_credit_note", "bill_of_entry"] as const;
export type GstDocType = (typeof GST_DOC_TYPES)[number];

export const GST_DOC_TYPE_LABELS: Record<GstDocType, string> = {
  invoice: "Invoice",
  debit_note: "Debit note",
  credit_note: "Credit note",
  isd_invoice: "ISD invoice",
  isd_credit_note: "ISD credit note",
  bill_of_entry: "Bill of entry",
};

/** The four tax heads, in paise. */
export type TaxHeads = { igst: Paise; cgst: Paise; sgst: Paise; cess: Paise };
/** The taxable value and the four tax heads, in paise. */
export type DocAmounts = TaxHeads & { taxable: Paise };

export const TAX_HEADS = ["igst", "cgst", "sgst", "cess"] as const;
export type TaxHead = (typeof TAX_HEADS)[number];
export const AMOUNT_FIELDS = ["taxable", "igst", "cgst", "sgst", "cess"] as const;
export type AmountField = (typeof AMOUNT_FIELDS)[number];

export const AMOUNT_FIELD_LABELS: Record<AmountField, string> = {
  taxable: "Taxable value",
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
};

/** One purchase document, from either side (§6.12). Amounts are signed paise (credit notes negative). */
export type GstDocRow = DocAmounts & {
  section: DocSource;
  /** Upper-case, no spaces. Empty for imports that carry no supplier GSTIN (IMPG). */
  supplierGstin: string;
  supplierName: string | null;
  docType: GstDocType;
  docNumber: string;
  docDate: DateString | null;
  /** Where in the source the row came from: `b2b[0].inv[2]`, or `row 14` in the register. */
  ref: string;
  /** Amended sections (B2BA, CDNRA, ISDA) and ISD credit notes: the document it replaces or refers to. */
  originalDocNumber: string | null;
  originalDocDate: DateString | null;
  reverseCharge: boolean;
  /** 2B's own ITC-availability flag (`itcavl` / `itcelg`); null when the source doesn't say. */
  itcAvailable: boolean | null;
  itcUnavailableReason: string | null;
  /** Bills of entry: the port code. */
  portCode: string | null;
  /** The supplier's return period (`supprd`, MMYYYY), when 2B gives it. */
  supplierPeriod: string | null;
};

/** Required fields of a row; everything else defaults (null / false). */
export type GstDocRowInput = Pick<GstDocRow, "supplierGstin" | "docNumber"> &
  Partial<Omit<GstDocRow, "supplierGstin" | "docNumber">>;

/** Builds a complete row from the fields given (amounts default to 0, extras to null). */
export function gstDocRow(input: GstDocRowInput): GstDocRow {
  return {
    section: input.section ?? "register",
    supplierGstin: normaliseGstinText(input.supplierGstin),
    supplierName: input.supplierName ?? null,
    docType: input.docType ?? "invoice",
    docNumber: input.docNumber,
    docDate: input.docDate ?? null,
    taxable: input.taxable ?? 0,
    igst: input.igst ?? 0,
    cgst: input.cgst ?? 0,
    sgst: input.sgst ?? 0,
    cess: input.cess ?? 0,
    ref: input.ref ?? "",
    originalDocNumber: input.originalDocNumber ?? null,
    originalDocDate: input.originalDocDate ?? null,
    reverseCharge: input.reverseCharge ?? false,
    itcAvailable: input.itcAvailable ?? null,
    itcUnavailableReason: input.itcUnavailableReason ?? null,
    portCode: input.portCode ?? null,
    supplierPeriod: input.supplierPeriod ?? null,
  };
}

/** True for documents that reduce ITC: credit notes and ISD credit notes. */
export function isCreditDoc(docType: GstDocType): boolean {
  return docType === "credit_note" || docType === "isd_credit_note";
}

/** The ITC a document carries: IGST + CGST + SGST + cess (signed). */
export function totalTax(amounts: TaxHeads): Paise {
  return amounts.igst + amounts.cgst + amounts.sgst + amounts.cess;
}

/** Upper-cases a GSTIN and removes whitespace (no validation). */
export function normaliseGstinText(input: string | null | undefined): string {
  return (input ?? "").replace(/\s+/g, "").toUpperCase();
}

function negate(v: Paise): Paise {
  return v === 0 ? 0 : -Math.abs(v);
}

function positive(v: Paise): Paise {
  return Math.abs(v);
}

/** Gives every amount the sign its document type implies (credit notes negative, others positive). */
export function signAmounts(docType: GstDocType, amounts: DocAmounts): DocAmounts {
  const f = isCreditDoc(docType) ? negate : positive;
  return { taxable: f(amounts.taxable), igst: f(amounts.igst), cgst: f(amounts.cgst), sgst: f(amounts.sgst), cess: f(amounts.cess) };
}

// -------------------------------------------------------------------------------------------------
// Diagnostics
// -------------------------------------------------------------------------------------------------

export type DiagnosticLevel = "error" | "warning" | "info";

export type Gstr2bDiagnosticCode =
  | "not_json"
  | "no_data"
  | "no_documents"
  | "unknown_section"
  | "bad_section"
  | "bad_document"
  | "bad_amount"
  | "bad_date"
  | "bad_gstin"
  | "no_gstin"
  | "missing_number"
  | "items_disagree"
  | "bad_period";

export type Gstr2bDiagnostic = {
  level: DiagnosticLevel;
  code: Gstr2bDiagnosticCode;
  /** One plain sentence. */
  message: string;
  /** Where in the file: `b2b[3].inv[0]`; null for file-level problems. */
  ref: string | null;
};

// -------------------------------------------------------------------------------------------------
// Spreadsheet cells (shared with the trial-balance import, §6.13)
// -------------------------------------------------------------------------------------------------

export type CellParse<T> = { ok: true; value: T } | { ok: false; error: string };

/** A cell as trimmed text (numbers as written by `String`); empty for null/undefined. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/ /g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : istDateOf(value);
  return "";
}

const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const EMPTY_AMOUNT = /^[-–—]$/;

/**
 * Reads an amount cell in rupees into paise: numbers, or text such as `1,23,456.50`, `₹ 500`,
 * `Rs. 500`, `(500.00)` (negative) or `-500`. Empty cells and a lone dash are null (no value).
 * Anything else is an error sentence.
 */
export function parseCellAmount(value: unknown): CellParse<Paise | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, error: "isn't a number" };
    return { ok: true, value: zeroSafe(toPaise(value)) };
  }
  if (typeof value !== "string") return { ok: false, error: "isn't a number" };
  let text = value.replace(/ /g, " ").trim();
  if (text === "" || EMPTY_AMOUNT.test(text)) return { ok: true, value: null };
  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(text);
  if (bracketed) {
    negative = true;
    text = bracketed[1];
  }
  text = text.replace(/₹|\bINR\b|\bRs\.?/gi, "").replace(/[,\s]/g, "");
  if (!PLAIN_NUMBER.test(text)) return { ok: false, error: `“${value.trim()}” isn't an amount` };
  const paise = toPaise(text);
  return { ok: true, value: zeroSafe(negative ? -paise : paise) };
}

function zeroSafe(v: number): number {
  return v === 0 ? 0 : v;
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthFromName(name: string): number | null {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return null;
  const idx = MONTH_NAMES.findIndex((m) => m.startsWith(n));
  return idx >= 0 ? idx + 1 : null;
}

function fullYear(text: string): number {
  const y = Number(text);
  if (text.length === 4) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function dateOrNull(year: number, month: number, day: number): DateString | null {
  const d = toDateString(year, month, day);
  return isDateString(d) ? d : null;
}

/** Excel's day 0 (serial dates count from here; the 1900 leap-year bug only affects early 1900). */
const EXCEL_EPOCH: DateString = "1899-12-30";

/**
 * Reads a date cell into `'YYYY-MM-DD'`. Accepts `DD-MM-YYYY`, `DD/MM/YY`, `DD.MM.YYYY` (Indian
 * day-first order), `YYYY-MM-DD` (optionally with a time), `05-Sep-2026`, `5 September 2026`,
 * `Sep 5, 2026`, `YYYYMMDD`, Excel serial numbers and `Date` objects (read as the IST calendar date).
 * Empty cells are null; anything else is an error sentence.
 */
export function parseCellDate(value: unknown): CellParse<DateString | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? { ok: false, error: "isn't a date" } : { ok: true, value: istDateOf(value) };
  }
  if (typeof value === "number") return excelSerial(value);
  if (typeof value !== "string") return { ok: false, error: "isn't a date" };
  const text = value.replace(/ /g, " ").trim();
  if (text === "") return { ok: true, value: null };
  const bad: CellParse<DateString | null> = { ok: false, error: `“${text}” isn't a date (use DD-MM-YYYY)` };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (m) return wrap(dateOrNull(Number(m[1]), Number(m[2]), Number(m[3])), bad);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text);
  if (m) return wrap(dateOrNull(fullYear(m[3]), Number(m[2]), Number(m[1])), bad);
  m = /^(\d{1,2})[-/. ]+([A-Za-z]{3,9}\.?)[-/., ]+(\d{4}|\d{2})$/.exec(text);
  if (m) {
    const month = monthFromName(m[2]);
    return wrap(month ? dateOrNull(fullYear(m[3]), month, Number(m[1])) : null, bad);
  }
  m = /^([A-Za-z]{3,9}\.?) (\d{1,2}),? (\d{4})$/.exec(text);
  if (m) {
    const month = monthFromName(m[1]);
    return wrap(month ? dateOrNull(Number(m[3]), month, Number(m[2])) : null, bad);
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m) return wrap(dateOrNull(Number(m[1]), Number(m[2]), Number(m[3])), bad);
  if (/^\d{5}(\.\d+)?$/.test(text)) return excelSerial(Number(text));
  return bad;
}

function wrap(date: DateString | null, bad: CellParse<DateString | null>): CellParse<DateString | null> {
  return date ? { ok: true, value: date } : bad;
}

function excelSerial(n: number): CellParse<DateString | null> {
  if (!Number.isFinite(n)) return { ok: false, error: "isn't a date" };
  const whole = Math.floor(n);
  if (whole >= 19_000_000 && whole <= 21_000_000 && Number.isInteger(n)) {
    return parseCellDate(String(whole));
  }
  // 1 Jan 1955 … 31 Dec 2099: wide enough for any purchase or ledger date.
  if (whole < 20_090 || whole > 73_050) return { ok: false, error: `${n} isn't a date` };
  return { ok: true, value: addDays(EXCEL_EPOCH, whole) };
}

// -------------------------------------------------------------------------------------------------
// Column mapping (shared with the trial-balance import, §6.13)
// -------------------------------------------------------------------------------------------------

/** One field the mapping step asks for, with the header spellings that suggest it. */
export type FieldSpec<F extends string> = {
  field: F;
  label: string;
  required: boolean;
  /** Header spellings, most specific first. Matched after `normaliseHeader`. */
  synonyms: readonly string[];
  /** A header with any of these words (or symbols, such as "%") is never suggested for the field. */
  exclude?: readonly string[];
};

/** Field → the file's header text (exactly as in the file), or null when not mapped. */
export type ColumnMapping<F extends string> = Record<F, string | null>;

/** How a field's column was chosen: the client's saved mapping, an exact header, or a partial one. */
export type MappingSource = "saved" | "exact" | "partial";

export type MappingSuggestion<F extends string> = {
  mapping: ColumnMapping<F>;
  sources: Record<F, MappingSource | null>;
  /** Required fields still without a column. */
  missingRequired: F[];
  /** Headers in the file that no field uses. */
  unusedHeaders: string[];
  /** True when every required field has a column. */
  complete: boolean;
};

/** Lower-case, `&` → `and`, letters and digits only: `"Supplier's GSTIN "` → `"suppliersgstin"`. */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

/**
 * Suggests a column for every field (§6.12, §6.13 "through a mapping step"): first the client's
 * saved mapping (when that header is still in the file), then an exact header match, then a header
 * that contains one of the field's spellings. Each header is used at most once. A saved `null` for
 * an optional field is respected (the user unmapped it on purpose).
 */
export function suggestColumnMapping<F extends string>(
  headers: readonly string[],
  specs: readonly FieldSpec<F>[],
  saved?: Partial<Record<F, string | null>> | null,
): MappingSuggestion<F> {
  const mapping = {} as ColumnMapping<F>;
  const sources = {} as Record<F, MappingSource | null>;
  const used = new Set<number>();
  const norm = headers.map((h) => normaliseHeader(h));
  const settled = new Set<F>();

  for (const spec of specs) {
    mapping[spec.field] = null;
    sources[spec.field] = null;
  }

  // A header with an excluded word is never suggested ("IGST Rate", "IGST %" are rates, not amounts).
  // Whole words only: "Integrated Tax" contains the letters "rate" but not the word.
  const words = headers.map((h) => h.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== ""));
  const excluded = (spec: FieldSpec<F>, i: number) =>
    (spec.exclude ?? []).some((x) => {
      const token = normaliseHeader(x);
      return token === "" ? headers[i].includes(x) : words[i].includes(token);
    });

  if (saved) {
    for (const spec of specs) {
      if (!Object.prototype.hasOwnProperty.call(saved, spec.field)) continue;
      const want = saved[spec.field];
      if (want === null || want === undefined) {
        if (!spec.required) settled.add(spec.field);
        continue;
      }
      const target = normaliseHeader(want);
      const idx = norm.findIndex((n, i) => n === target && n !== "" && !used.has(i));
      if (idx >= 0) {
        used.add(idx);
        mapping[spec.field] = headers[idx];
        sources[spec.field] = "saved";
        settled.add(spec.field);
      }
    }
  }

  for (const spec of specs) {
    if (settled.has(spec.field)) continue;
    for (const synonym of spec.synonyms) {
      const target = normaliseHeader(synonym);
      const idx = norm.findIndex((n, i) => n === target && !used.has(i) && !excluded(spec, i));
      if (idx >= 0) {
        used.add(idx);
        mapping[spec.field] = headers[idx];
        sources[spec.field] = "exact";
        settled.add(spec.field);
        break;
      }
    }
  }

  for (const spec of specs) {
    if (settled.has(spec.field)) continue;
    let best = -1;
    for (const synonym of spec.synonyms) {
      const target = normaliseHeader(synonym);
      if (target.length < 4) continue;
      norm.forEach((n, i) => {
        if (used.has(i) || !n.includes(target) || excluded(spec, i)) return;
        if (best < 0 || norm[i].length < norm[best].length) best = i;
      });
      if (best >= 0) break;
    }
    if (best >= 0) {
      used.add(best);
      mapping[spec.field] = headers[best];
      sources[spec.field] = "partial";
      settled.add(spec.field);
    }
  }

  const missingRequired = specs.filter((s) => s.required && mapping[s.field] === null).map((s) => s.field);
  const usedHeaders = new Set(Object.values(mapping).filter((h): h is string => typeof h === "string"));
  return {
    mapping,
    sources,
    missingRequired,
    unusedHeaders: headers.filter((h) => !usedHeaders.has(h) && h.trim() !== ""),
    complete: missingRequired.length === 0,
  };
}

/**
 * Checks a mapping the user confirmed: every required field mapped, every header present in the
 * file, no header used for two fields. Returns field errors keyed by field, or null when it's fine.
 */
export function validateColumnMapping<F extends string>(
  mapping: Partial<Record<F, string | null>>,
  headers: readonly string[],
  specs: readonly FieldSpec<F>[],
): FieldErrors | null {
  const errors: FieldErrors = {};
  const seen = new Map<string, F>();
  for (const spec of specs) {
    const header = mapping[spec.field] ?? null;
    if (header === null || header === "") {
      if (spec.required) errors[spec.field] = [`Choose the column that holds the ${spec.label.toLowerCase()}.`];
      continue;
    }
    if (!headers.includes(header)) {
      errors[spec.field] = [`The file has no column called “${header}”.`];
      continue;
    }
    const other = seen.get(header);
    if (other !== undefined) {
      const otherLabel = specs.find((s) => s.field === other)?.label ?? other;
      errors[spec.field] = [`“${header}” is already used for ${otherLabel.toLowerCase()}.`];
      continue;
    }
    seen.set(header, spec.field);
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

// -------------------------------------------------------------------------------------------------
// GSTR-2B JSON (§6.12)
// -------------------------------------------------------------------------------------------------

export type Gstr2bParseResult = {
  /** False only when nothing at all could be read (not JSON, or no document sections). */
  ok: boolean;
  /** The recipient GSTIN the file was downloaded for (`data.gstin`). */
  gstin: string | null;
  /** The return period, MMYYYY (`data.rtnprd`), as `gst_recon_runs.period` stores it. */
  period: string | null;
  /** `Sep 2026`. */
  periodLabel: string | null;
  /** When the portal generated the statement (`data.gendt`). */
  generatedOn: DateString | null;
  rows: GstDocRow[];
  counts: Record<Gstr2bSection, number>;
  diagnostics: Gstr2bDiagnostic[];
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function first(obj: Json, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function text(obj: Json, keys: readonly string[]): string | null {
  const v = first(obj, keys);
  if (v === undefined) return null;
  const t = cellText(v);
  return t === "" ? null : t;
}

const PERIOD_PATTERN = /^(0[1-9]|1[0-2])(\d{4})$/;

/** `"092026"` → `"Sep 2026"`; null for anything that isn't MMYYYY. */
export function periodLabelOf(period: string | null | undefined): string | null {
  const m = PERIOD_PATTERN.exec((period ?? "").trim());
  return m ? `${MONTH_ABBR[Number(m[1]) - 1]} ${m[2]}` : null;
}

const HEAD_KEYS: Record<AmountField, readonly string[]> = {
  taxable: ["txval"],
  igst: ["igst", "iamt"],
  cgst: ["cgst", "camt"],
  sgst: ["sgst", "samt"],
  cess: ["cess", "csamt"],
};

type Collector = { diagnostics: Gstr2bDiagnostic[] };

function diag(c: Collector, level: DiagnosticLevel, code: Gstr2bDiagnosticCode, message: string, ref: string | null) {
  c.diagnostics.push({ level, code, message, ref });
}

function readAmountField(obj: Json, field: AmountField, ref: string, c: Collector): Paise | null {
  const raw = first(obj, HEAD_KEYS[field]);
  if (raw === undefined) return null;
  const parsed = parseCellAmount(raw);
  if (!parsed.ok) {
    diag(c, "warning", "bad_amount", `${AMOUNT_FIELD_LABELS[field]} ${parsed.error}; it was read as zero.`, ref);
    return null;
  }
  return parsed.value;
}

/** Reads the taxable value and tax heads from the document, falling back to its items. */
function readDocAmounts(doc: Json, ref: string, c: Collector): DocAmounts {
  const docLevel = {} as Record<AmountField, Paise | null>;
  for (const f of AMOUNT_FIELDS) docLevel[f] = readAmountField(doc, f, ref, c);

  const itemList = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.itms) ? doc.itms : null;
  const itemSum = {} as Record<AmountField, Paise | null>;
  for (const f of AMOUNT_FIELDS) itemSum[f] = null;
  if (itemList) {
    itemList.forEach((raw, i) => {
      const item = asRecord(raw);
      if (!item) return;
      const detail = asRecord(item.itm_det) ?? item;
      for (const f of AMOUNT_FIELDS) {
        const v = readAmountField(detail, f, `${ref}.items[${i}]`, c);
        if (v !== null) itemSum[f] = (itemSum[f] ?? 0) + v;
      }
    });
  }

  const out = {} as DocAmounts;
  let disagrees = false;
  for (const f of AMOUNT_FIELDS) {
    const d = docLevel[f];
    const s = itemSum[f];
    if (d !== null && s !== null && Math.abs(d - s) > 1) disagrees = true;
    out[f] = d ?? s ?? 0;
  }
  if (disagrees) {
    diag(c, "info", "items_disagree", "The item values don't add up to the document total; the document total was used.", ref);
  }
  return out;
}

function readDate(obj: Json, keys: readonly string[], what: string, ref: string, c: Collector): DateString | null {
  const raw = first(obj, keys);
  if (raw === undefined) return null;
  const parsed = parseCellDate(raw);
  if (!parsed.ok) {
    diag(c, "warning", "bad_date", `The ${what} ${parsed.error}.`, ref);
    return null;
  }
  return parsed.value;
}

function readFlag(obj: Json, keys: readonly string[]): boolean | null {
  const v = text(obj, keys);
  if (v === null) return null;
  const u = v.toUpperCase();
  if (u === "Y" || u === "YES" || u === "TRUE") return true;
  if (u === "N" || u === "NO" || u === "FALSE") return false;
  return null;
}

type SectionShape = {
  /** Key of the supplier's document list (`inv`, `nt`, `doclist`, `boe`); null for a flat list (IMPG). */
  listKey: string | null;
  number: readonly string[];
  date: readonly string[];
  originalNumber: readonly string[];
  originalDate: readonly string[];
  needsGstin: boolean;
  docType: (doc: Json) => GstDocType;
};

const SECTION_SHAPES: Record<Gstr2bSection, SectionShape> = {
  b2b: { listKey: "inv", number: ["inum"], date: ["dt", "idt"], originalNumber: [], originalDate: [], needsGstin: true, docType: () => "invoice" },
  b2ba: { listKey: "inv", number: ["inum"], date: ["dt", "idt"], originalNumber: ["oinum"], originalDate: ["oidt"], needsGstin: true, docType: () => "invoice" },
  cdnr: { listKey: "nt", number: ["ntnum", "nt_num"], date: ["dt", "nt_dt"], originalNumber: [], originalDate: [], needsGstin: true, docType: noteType },
  cdnra: { listKey: "nt", number: ["ntnum", "nt_num"], date: ["dt", "nt_dt"], originalNumber: ["ontnum", "ont_num"], originalDate: ["ontdt", "ont_dt"], needsGstin: true, docType: noteType },
  isd: { listKey: "doclist", number: ["docnum"], date: ["docdt"], originalNumber: ["oinvnum"], originalDate: ["oinvdt"], needsGstin: true, docType: isdType },
  isda: { listKey: "doclist", number: ["docnum"], date: ["docdt"], originalNumber: ["odocnum", "oinvnum"], originalDate: ["odocdt", "oinvdt"], needsGstin: true, docType: isdType },
  impg: { listKey: null, number: ["boenum"], date: ["boedt"], originalNumber: [], originalDate: [], needsGstin: false, docType: () => "bill_of_entry" },
  impgsez: { listKey: "boe", number: ["boenum"], date: ["boedt"], originalNumber: [], originalDate: [], needsGstin: true, docType: () => "bill_of_entry" },
};

function noteType(doc: Json): GstDocType {
  const t = (text(doc, ["typ", "ntty", "note_type"]) ?? "C").toUpperCase();
  return t.startsWith("D") ? "debit_note" : "credit_note";
}

function isdType(doc: Json): GstDocType {
  const t = (text(doc, ["doctyp", "typ"]) ?? "ISD").toUpperCase();
  return t === "ISDC" || t.startsWith("C") ? "isd_credit_note" : "isd_invoice";
}

function readDoc(
  section: Gstr2bSection,
  shape: SectionShape,
  doc: Json,
  supplier: { gstin: string; name: string | null; period: string | null },
  ref: string,
  c: Collector,
): GstDocRow {
  const docType = shape.docType(doc);
  const docNumber = text(doc, shape.number) ?? "";
  if (docNumber === "") diag(c, "warning", "missing_number", "This document has no number; it can only be matched on amount and date.", ref);
  const amounts = signAmounts(docType, readDocAmounts(doc, ref, c));
  const itcFlag = readFlag(doc, ["itcavl", "itcelg"]);
  return {
    section,
    supplierGstin: supplier.gstin,
    supplierName: supplier.name,
    docType,
    docNumber,
    docDate: readDate(doc, shape.date, "document date", ref, c),
    ...amounts,
    ref,
    originalDocNumber: text(doc, shape.originalNumber),
    originalDocDate: shape.originalDate.length > 0 ? readDate(doc, shape.originalDate, "original document date", ref, c) : null,
    reverseCharge: readFlag(doc, ["rev", "rchrg"]) === true,
    itcAvailable: itcFlag,
    itcUnavailableReason: itcFlag === false ? text(doc, ["rsn", "reason"]) : null,
    portCode: text(doc, ["portcode", "port_code"]),
    supplierPeriod: supplier.period,
  };
}

function checkSupplierGstin(gstin: string, ref: string, c: Collector) {
  if (gstin === "") return;
  const v = validateGstin(gstin);
  if (!v.ok) diag(c, "warning", "bad_gstin", `Supplier GSTIN ${gstin}: ${v.error}`, ref);
}

function readSection(section: Gstr2bSection, value: unknown, rows: GstDocRow[], c: Collector): number {
  const shape = SECTION_SHAPES[section];
  if (!Array.isArray(value)) {
    diag(c, "warning", "bad_section", `The ${GSTR2B_SECTION_LABELS[section]} section isn't a list, so it was skipped.`, section);
    return 0;
  }
  let count = 0;
  value.forEach((rawEntry, i) => {
    const entry = asRecord(rawEntry);
    const entryRef = `${section}[${i}]`;
    if (!entry) {
      diag(c, "warning", "bad_document", "This entry isn't an object, so it was skipped.", entryRef);
      return;
    }
    if (shape.listKey === null) {
      rows.push(readDoc(section, shape, entry, { gstin: "", name: null, period: null }, entryRef, c));
      count++;
      return;
    }
    const gstin = normaliseGstinText(text(entry, ["ctin", "gstin", "stin"]));
    if (gstin === "" && shape.needsGstin) {
      diag(c, "warning", "no_gstin", "This supplier has no GSTIN in the file.", entryRef);
    }
    checkSupplierGstin(gstin, entryRef, c);
    const supplier = { gstin, name: text(entry, ["trdnm", "trade_name", "lglnm"]), period: text(entry, ["supprd"]) };
    const docs = entry[shape.listKey];
    if (!Array.isArray(docs)) {
      diag(c, "warning", "bad_document", `Supplier ${gstin || "(no GSTIN)"} has no document list, so it was skipped.`, entryRef);
      return;
    }
    docs.forEach((rawDoc, j) => {
      const doc = asRecord(rawDoc);
      const ref = `${entryRef}.${shape.listKey}[${j}]`;
      if (!doc) {
        diag(c, "warning", "bad_document", "This document isn't an object, so it was skipped.", ref);
        return;
      }
      rows.push(readDoc(section, shape, doc, supplier, ref, c));
      count++;
    });
  });
  return count;
}

function countDocs(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let n = 0;
  for (const entry of value) {
    const rec = asRecord(entry);
    const list = rec ? Object.values(rec).find((v) => Array.isArray(v)) : undefined;
    n += Array.isArray(list) ? list.length : 1;
  }
  return n;
}

function emptyCounts(): Record<Gstr2bSection, number> {
  const out = {} as Record<Gstr2bSection, number>;
  for (const s of GSTR2B_SECTIONS) out[s] = 0;
  return out;
}

/**
 * Parses a GSTR-2B JSON file (§6.12) into normalised rows, reading the B2B, B2BA, CDNR, CDNRA, ISD,
 * ISDA, IMPG and IMPGSEZ sections of `data.docdata`. Accepts the file text or the parsed object;
 * also accepts a file whose root is `data` itself. Never throws: unreadable parts become
 * diagnostics, and unknown sections are reported (not silently dropped).
 */
export function parseGstr2b(input: unknown): Gstr2bParseResult {
  const c: Collector = { diagnostics: [] };
  const result: Gstr2bParseResult = {
    ok: false,
    gstin: null,
    period: null,
    periodLabel: null,
    generatedOn: null,
    rows: [],
    counts: emptyCounts(),
    diagnostics: c.diagnostics,
  };

  let root: unknown = input;
  if (typeof input === "string") {
    try {
      root = JSON.parse(input.replace(/^﻿/, ""));
    } catch {
      diag(c, "error", "not_json", "This file isn't valid JSON. Download the GSTR-2B JSON again from the GST portal.", null);
      return result;
    }
  }
  const top = asRecord(root);
  if (!top) {
    diag(c, "error", "no_data", "This file doesn't look like a GSTR-2B download.", null);
    return result;
  }
  const data = asRecord(top.data) ?? top;

  const gstin = normaliseGstinText(text(data, ["gstin"]));
  if (gstin !== "") {
    result.gstin = gstin;
    const v = validateGstin(gstin);
    if (!v.ok) diag(c, "warning", "bad_gstin", `The file's GSTIN ${gstin}: ${v.error}`, "data.gstin");
  }
  const period = text(data, ["rtnprd", "ret_period", "fp"]);
  if (period !== null) {
    if (PERIOD_PATTERN.test(period)) {
      result.period = period;
      result.periodLabel = periodLabelOf(period);
    } else {
      diag(c, "warning", "bad_period", `The return period “${period}” isn't in MMYYYY form.`, "data.rtnprd");
    }
  }
  result.generatedOn = readDate(data, ["gendt"], "generation date", "data.gendt", c);

  const known = new Set<string>(GSTR2B_SECTIONS);
  const docdata = asRecord(data.docdata) ?? (GSTR2B_SECTIONS.some((s) => s in data) ? data : null);
  if (!docdata) {
    diag(c, "error", "no_documents", "This file has no document details (docdata). Download the GSTR-2B JSON, not the summary.", null);
    return result;
  }

  for (const [key, value] of Object.entries(docdata)) {
    const section = key.toLowerCase();
    if (known.has(section)) {
      result.counts[section as Gstr2bSection] += readSection(section as Gstr2bSection, value, result.rows, c);
    } else if (docdata !== data) {
      const n = countDocs(value);
      diag(
        c,
        "warning",
        "unknown_section",
        `The section “${key}” isn't read by the reconciliation${n > 0 ? `; its ${n} document${n === 1 ? " was" : "s were"} left out` : ""}.`,
        key,
      );
    }
  }
  result.ok = true;
  return result;
}

// -------------------------------------------------------------------------------------------------
// Purchase register (§6.12: "through a column-mapping step")
// -------------------------------------------------------------------------------------------------

export const REGISTER_FIELDS = ["supplierGstin", "supplierName", "docType", "docNumber", "docDate", "taxable", "igst", "cgst", "sgst", "cess"] as const;
export type RegisterField = (typeof REGISTER_FIELDS)[number];

const RATE_WORDS = ["rate", "percent", "%"];

/** The register's fields, the header spellings that suggest each, and which are required (§6.12). */
export const REGISTER_FIELD_SPECS: readonly FieldSpec<RegisterField>[] = [
  {
    field: "supplierGstin",
    label: "Supplier GSTIN",
    required: true,
    synonyms: ["supplier gstin", "gstin of supplier", "gstin/uin of supplier", "party gstin", "vendor gstin", "gstin/uin", "gstin no", "gst no", "gstin", "ctin"],
  },
  {
    field: "supplierName",
    label: "Supplier name",
    required: false,
    synonyms: ["supplier name", "name of supplier", "party name", "vendor name", "trade name", "trade/legal name", "particulars", "supplier", "party", "vendor", "name"],
    exclude: ["gstin"],
  },
  {
    field: "docType",
    label: "Document type",
    required: false,
    synonyms: ["document type", "doc type", "invoice type", "note type", "voucher type", "type"],
  },
  {
    field: "docNumber",
    label: "Document number",
    required: true,
    synonyms: [
      "supplier invoice no",
      "supplier invoice number",
      "invoice no",
      "invoice number",
      "inv no",
      "bill no",
      "bill number",
      "document number",
      "document no",
      "doc no",
      "doc number",
      "note number",
      "note no",
      "reference no",
      "ref no",
      "inum",
    ],
    exclude: ["date", "type", "gstin", "value"],
  },
  {
    field: "docDate",
    label: "Document date",
    required: true,
    synonyms: ["supplier invoice date", "invoice date", "inv date", "bill date", "document date", "doc date", "note date", "date"],
  },
  {
    field: "taxable",
    label: "Taxable value",
    required: true,
    synonyms: ["taxable value", "taxable amount", "taxable", "assessable value", "txval", "value without tax"],
    exclude: RATE_WORDS,
  },
  {
    field: "igst",
    label: "IGST",
    required: false,
    synonyms: ["igst", "igst amount", "integrated tax", "integrated tax amount", "integrated tax (₹)", "iamt"],
    exclude: RATE_WORDS,
  },
  {
    field: "cgst",
    label: "CGST",
    required: false,
    synonyms: ["cgst", "cgst amount", "central tax", "central tax amount", "central tax (₹)", "camt"],
    exclude: RATE_WORDS,
  },
  {
    field: "sgst",
    label: "SGST",
    required: false,
    synonyms: ["sgst", "sgst amount", "sgst/utgst", "state tax", "state/ut tax", "state tax amount", "utgst", "samt"],
    exclude: RATE_WORDS,
  },
  {
    field: "cess",
    label: "Cess",
    required: false,
    synonyms: ["cess", "cess amount", "compensation cess", "csamt"],
    exclude: RATE_WORDS,
  },
];

/**
 * Suggests which register column holds each field (§6.12, §7.8.1 step 3), starting from the
 * client's saved mapping when one exists.
 */
export function mapColumns(headers: readonly string[], savedMapping?: Partial<Record<RegisterField, string | null>> | null): MappingSuggestion<RegisterField> {
  return suggestColumnMapping(headers, REGISTER_FIELD_SPECS, savedMapping);
}

/** One problem with one register row. `row` is the spreadsheet row number (header = row 1). */
export type RowIssue<F extends string> = { row: number; level: "error" | "warning"; field: F | null; message: string };

export type RegisterParseResult = {
  rows: GstDocRow[];
  issues: RowIssue<RegisterField>[];
  counts: { total: number; accepted: number; rejected: number; skipped: number };
};

/** A row from the CSV/XLSX reader, keyed by header text. */
export type SheetRow = Readonly<Record<string, unknown>>;

const TOTAL_ROW = /^(grand\s*)?(sub\s*)?totals?\b/i;

/**
 * Reads a document-type cell (§6.12). Returns the type and whether the text was recognised;
 * null for an empty cell.
 */
export function parseDocType(value: string): { docType: GstDocType; known: boolean } | null {
  const t = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (t === "") return null;
  const compact = t.replace(/ /g, "");
  if (compact === "isdc" || /\bisd\b.*\bcredit\b/.test(t)) return { docType: "isd_credit_note", known: true };
  if (/\bisd\b/.test(t)) return { docType: "isd_invoice", known: true };
  if (/credit/.test(t) || ["c", "cn", "crn", "crnote", "cdn", "purchasereturn", "purchasereturns"].includes(compact)) {
    return { docType: "credit_note", known: true };
  }
  if (/debit/.test(t) || ["d", "dn", "dbn", "drnote"].includes(compact)) return { docType: "debit_note", known: true };
  if (/bill of entry|\bboe\b|\bimport|\bimpg/.test(t)) return { docType: "bill_of_entry", known: true };
  const invoiceWords = ["invoice", "inv", "taxinvoice", "taxinv", "b2b", "b2ba", "regular", "r", "purchase", "purchases", "purchaseinvoice", "bill", "sez", "sezwp", "sezwop", "de", "deemedexport"];
  return { docType: "invoice", known: invoiceWords.includes(compact) || /invoice/.test(t) };
}

/**
 * Reads the mapped purchase-register rows into normalised documents (§6.12), with a per-row
 * validation report:
 * - **errors** (row left out): no document number; no supplier GSTIN (except bills of entry);
 *   an amount that isn't a number; no taxable value.
 * - **warnings** (row kept): a GSTIN that fails validation; a missing or unreadable date (the row can
 *   still match on document number); an unrecognised document type (read as an invoice); IGST and
 *   CGST/SGST both charged; CGST ≠ SGST; signs that disagree with the document type.
 * Blank rows and "Total" rows are skipped. Credit notes come out negative whatever sign the register
 * used; an "invoice" with a negative taxable value is read as a credit note (with a warning).
 */
export function parseRegisterRows(
  rows: readonly SheetRow[],
  mapping: Partial<Record<RegisterField, string | null>>,
  opts: { firstRowNumber?: number } = {},
): RegisterParseResult {
  const firstRow = opts.firstRowNumber ?? 2;
  const result: RegisterParseResult = { rows: [], issues: [], counts: { total: rows.length, accepted: 0, rejected: 0, skipped: 0 } };

  const missing = REGISTER_FIELD_SPECS.filter((s) => s.required && !mapping[s.field]);
  if (missing.length > 0) {
    for (const s of missing) {
      result.issues.push({ row: 0, level: "error", field: s.field, message: `Map the ${s.label.toLowerCase()} column before reading the register.` });
    }
    result.counts.rejected = rows.length;
    return result;
  }

  const cell = (row: SheetRow, field: RegisterField): unknown => {
    const header = mapping[field];
    return header ? row[header] : undefined;
  };

  rows.forEach((row, index) => {
    const rowNumber = firstRow + index;
    const issues: RowIssue<RegisterField>[] = [];
    const err = (field: RegisterField | null, message: string) => issues.push({ row: rowNumber, level: "error", field, message });
    const warn = (field: RegisterField | null, message: string) => issues.push({ row: rowNumber, level: "warning", field, message });

    const mappedValues = REGISTER_FIELDS.map((f) => cellText(cell(row, f)));
    if (mappedValues.every((v) => v === "")) {
      result.counts.skipped++;
      return;
    }
    const gstinText = cellText(cell(row, "supplierGstin"));
    const nameText = cellText(cell(row, "supplierName"));
    const numberText = cellText(cell(row, "docNumber"));
    const typeText = cellText(cell(row, "docType"));
    if ([gstinText, nameText, numberText, typeText].some((t) => TOTAL_ROW.test(t)) && gstinText.length < 15) {
      result.counts.skipped++;
      return;
    }

    // Document type (inferred from the sign when the column is missing or says "invoice").
    const typeParse = parseDocType(typeText);
    let docType: GstDocType = typeParse?.docType ?? "invoice";
    if (typeParse && !typeParse.known) warn("docType", `Document type “${typeText}” wasn't recognised, so the row was read as an invoice.`);

    // Amounts.
    const amounts = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 } as DocAmounts;
    let taxableGiven = false;
    for (const f of AMOUNT_FIELDS) {
      if (!mapping[f]) continue;
      const parsed = parseCellAmount(cell(row, f));
      if (!parsed.ok) {
        err(f, `${AMOUNT_FIELD_LABELS[f]} ${parsed.error}.`);
        continue;
      }
      if (parsed.value !== null) {
        amounts[f] = parsed.value;
        if (f === "taxable") taxableGiven = true;
      }
    }
    const isd = docType === "isd_invoice" || docType === "isd_credit_note";
    if (!taxableGiven && !isd && !issues.some((i) => i.field === "taxable")) err("taxable", "Taxable value is empty.");

    const lead = amounts.taxable !== 0 ? amounts.taxable : totalTax(amounts);
    const values = AMOUNT_FIELDS.map((f) => amounts[f]).filter((v) => v !== 0);
    const anyNegative = values.some((v) => v < 0);
    const anyPositive = values.some((v) => v > 0);
    if ((docType === "invoice" || docType === "isd_invoice") && lead < 0) {
      if (typeParse) warn("docType", "The amounts are negative, so this row was read as a credit note.");
      docType = docType === "isd_invoice" ? "isd_credit_note" : "credit_note";
      if (anyPositive) warn(null, "Some amounts are negative and some positive; all were read as negative (a credit note).");
    } else if (anyNegative && anyPositive) {
      warn(null, `Some amounts are negative and some positive; all were read as ${isCreditDoc(docType) ? "negative (a credit note)" : "positive"}.`);
    } else if (anyNegative && !isCreditDoc(docType)) {
      warn(null, `Negative amounts on a ${GST_DOC_TYPE_LABELS[docType].toLowerCase()} were read as positive.`);
    }
    const signed = signAmounts(docType, amounts);

    // Supplier GSTIN.
    const gstin = normaliseGstinText(gstinText);
    if (gstin === "") {
      if (docType !== "bill_of_entry") err("supplierGstin", "Supplier GSTIN is empty.");
    } else {
      const v = validateGstin(gstin);
      if (!v.ok) warn("supplierGstin", `Supplier GSTIN ${gstin}: ${v.error} It will only match a 2B entry with exactly this GSTIN.`);
    }

    // Number and date.
    if (numberText === "") err("docNumber", "Document number is empty.");
    let docDate: DateString | null = null;
    const dateParse = parseCellDate(cell(row, "docDate"));
    if (!dateParse.ok) warn("docDate", `Document date ${dateParse.error}; the row can still match on its number.`);
    else if (dateParse.value === null) warn("docDate", "Document date is empty; the row can still match on its number.");
    else docDate = dateParse.value;

    // Tax-head sanity.
    if (signed.igst !== 0 && (signed.cgst !== 0 || signed.sgst !== 0)) {
      warn("igst", "Both IGST and CGST/SGST are charged on this document; check the place of supply.");
    }
    if (Math.abs(signed.cgst - signed.sgst) > 1) warn("sgst", "CGST and SGST differ; they are normally equal.");

    result.issues.push(...issues);
    if (issues.some((i) => i.level === "error")) {
      result.counts.rejected++;
      return;
    }
    result.rows.push(
      gstDocRow({
        section: "register",
        supplierGstin: gstin,
        supplierName: nameText === "" ? null : nameText,
        docType,
        docNumber: numberText,
        docDate,
        ...signed,
        ref: `row ${rowNumber}`,
      }),
    );
    result.counts.accepted++;
  });
  return result;
}

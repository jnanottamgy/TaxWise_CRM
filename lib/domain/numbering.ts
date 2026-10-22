/**
 * Document numbers (§0.1 rule 6, §5.11, §6.4).
 *
 * Numbers come from the locked `number_series` counter in Postgres (`next_document_number`); this
 * module is its pure mirror: the formats, the GST Rule 46 check (at most 16 characters, only letters,
 * digits, `-` and `/`), the prefix check that Settings → Numbering runs (§7.21), and the counter step
 * including the FY reset, so all three agree and can be tested without a database.
 *
 * Pure and client-safe.
 */

import { financialYearOf, fyShort, parseFinancialYear, type DateString, type FinancialYear } from "@/lib/domain/fy";

/**
 * Seed values. The 16-character limit is GST Rule 46 (invoices) and Rule 53 (credit notes); the
 * counter applies it to every series so that one rule covers all numbers.
 */
export const NUMBERING_DEFAULTS = {
  gstDocumentMaxLength: 16,
} as const;

export const SERIES_KEYS = ["invoice", "credit_note", "quotation", "receipt", "client_code", "task", "lead"] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

/** The firm_settings column that holds a series' prefix (§5.2). */
export type PrefixSetting = "invoice_prefix" | "credit_note_prefix" | "quotation_prefix" | "receipt_prefix" | "client_code_prefix";

export type SeriesDefinition = {
  key: SeriesKey;
  /** What one document of the series is called, in a sentence ("invoice", "client code"). */
  noun: string;
  /** FY-scoped series restart at 1 each FY and read `<prefix>/<yy-yy>/<0000>`; others `<prefix>-<0000>`. */
  fyScoped: boolean;
  defaultPrefix: string;
  /** Minimum digits of the sequence (zero-padded). */
  pad: number;
  /** Where Partners edit the prefix; null when the prefix is fixed. */
  prefixSetting: PrefixSetting | null;
};

/** The seven series (§5.11), with the default prefixes from `firm_settings` (§5.2). */
export const SERIES: Readonly<Record<SeriesKey, SeriesDefinition>> = {
  invoice: { key: "invoice", noun: "invoice", fyScoped: true, defaultPrefix: "TW", pad: 4, prefixSetting: "invoice_prefix" },
  credit_note: { key: "credit_note", noun: "credit note", fyScoped: true, defaultPrefix: "TW-CN", pad: 4, prefixSetting: "credit_note_prefix" },
  quotation: { key: "quotation", noun: "quotation", fyScoped: true, defaultPrefix: "TW-Q", pad: 4, prefixSetting: "quotation_prefix" },
  receipt: { key: "receipt", noun: "receipt", fyScoped: true, defaultPrefix: "TW-R", pad: 4, prefixSetting: "receipt_prefix" },
  client_code: { key: "client_code", noun: "client code", fyScoped: false, defaultPrefix: "TW-C", pad: 4, prefixSetting: "client_code_prefix" },
  task: { key: "task", noun: "task number", fyScoped: false, defaultPrefix: "T", pad: 6, prefixSetting: null },
  lead: { key: "lead", noun: "lead number", fyScoped: false, defaultPrefix: "L", pad: 4, prefixSetting: null },
};

/** True for one of the seven series keys. */
export function isSeriesKey(v: unknown): v is SeriesKey {
  return typeof v === "string" && (SERIES_KEYS as readonly string[]).includes(v);
}

function assertSequence(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`A sequence number must be a whole number of at least 1; got ${seq}.`);
}

/**
 * Formats a document number (§5.11). With `fyShort` it is FY-scoped: `TW/26-27/0042`; without it:
 * `TW-C-0001`. The sequence is zero-padded to `pad` digits and never truncated.
 */
export function formatDocumentNumber(args: { prefix: string; fyShort?: string | null; seq: number; pad: number }): string {
  assertSequence(args.seq);
  const digits = String(args.seq).padStart(args.pad, "0");
  return args.fyShort ? `${args.prefix}/${args.fyShort}/${digits}` : `${args.prefix}-${digits}`;
}

/**
 * The number for `seq` in a series. FY-scoped series need the FY (or a date in it); the prefix
 * defaults to the series default.
 */
export function formatSeriesNumber(
  key: SeriesKey,
  args: { seq: number; prefix?: string; fy?: FinancialYear; date?: DateString },
): string {
  const def = SERIES[key];
  let short: string | null = null;
  if (def.fyScoped) {
    const fy = args.fy ?? (args.date ? financialYearOf(args.date) : null);
    if (!fy) throw new RangeError(`A ${def.noun} number needs the financial year.`);
    short = fyShort(fy);
  }
  return formatDocumentNumber({ prefix: args.prefix ?? def.defaultPrefix, fyShort: short, seq: args.seq, pad: def.pad });
}

const GST_DOCUMENT_CHARS = /^[A-Za-z0-9/-]+$/;

/**
 * GST Rule 46: an invoice number is at most 16 characters (the limit is a parameter) and uses only
 * letters, digits, `-` and `/`.
 */
export function isValidGstInvoiceNumber(value: string, maxLength: number = NUMBERING_DEFAULTS.gstDocumentMaxLength): boolean {
  return value.length >= 1 && value.length <= maxLength && GST_DOCUMENT_CHARS.test(value);
}

/** `isValidGstInvoiceNumber` with the sentence to show when it fails. */
export function checkGstDocumentNumber(
  value: string,
  maxLength: number = NUMBERING_DEFAULTS.gstDocumentMaxLength,
): { ok: true } | { ok: false; error: string } {
  if (value.length === 0) return { ok: false, error: "The number is empty." };
  if (!GST_DOCUMENT_CHARS.test(value)) return { ok: false, error: "GST invoice numbers can use only letters, digits, - and /." };
  if (value.length > maxLength) {
    return { ok: false, error: `${value} is ${value.length} characters; GST invoice numbers can have at most ${maxLength}.` };
  }
  return { ok: true };
}

export type PrefixCheck =
  | {
      ok: true;
      prefix: string;
      /** The first number of the series with this prefix, e.g. `TW/26-27/0001`. */
      sample: string;
      length: number;
      /** The highest sequence that still fits the limit (e.g. 9999 for `TW-CN`). */
      maxSequence: number;
    }
  | { ok: false; error: string };

/**
 * Checks a prefix for Settings → Numbering (§7.21): letters, digits, `-` and `/`, starting and ending
 * with a letter or digit, and short enough that the series' numbers stay within the limit. The
 * error names the longest prefix that would fit.
 */
export function checkSeriesPrefix(
  key: SeriesKey,
  prefix: string,
  opts: { fy: FinancialYear; maxLength?: number },
): PrefixCheck {
  const def = SERIES[key];
  const max = opts.maxLength ?? NUMBERING_DEFAULTS.gstDocumentMaxLength;
  const p = prefix.trim();
  if (p === "") return { ok: false, error: "Enter a prefix." };
  if (!GST_DOCUMENT_CHARS.test(p)) return { ok: false, error: "A prefix can use only letters, digits, - and /." };
  if (!/^[A-Za-z0-9]/.test(p) || !/[A-Za-z0-9]$/.test(p)) {
    return { ok: false, error: "Start and end the prefix with a letter or a digit." };
  }
  const sample = formatSeriesNumber(key, { seq: 1, prefix: p, fy: opts.fy });
  const fixed = sample.length - def.pad; // everything except the sequence digits
  if (sample.length > max) {
    const room = max - (fixed - p.length) - def.pad;
    const advice = room >= 1 ? ` Use a prefix of at most ${room} characters.` : "";
    return {
      ok: false,
      error: `With the prefix ${p}, ${def.noun} numbers would be ${sample.length} characters (${sample}). They can have at most ${max}.${advice}`,
    };
  }
  const digits = max - fixed;
  return { ok: true, prefix: p, sample, length: sample.length, maxSequence: Math.min(Number.MAX_SAFE_INTEGER, 10 ** digits - 1) };
}

/** One `number_series` row (§5.11). `financialYear` is null for series that aren't FY-scoped. */
export type SeriesState = { financialYear: FinancialYear | null; nextValue: number };

export type NextNumber =
  | { ok: true; number: string; seq: number; next: SeriesState }
  | { ok: false; error: string };

/**
 * One step of the counter, as `next_document_number(p_key, p_date)` does it under `FOR UPDATE`:
 * - an FY-scoped series restarts at 1 when the date is in a later FY than the row;
 * - a date in an earlier FY than the row is refused, because restarting would reuse that FY's
 *   numbers (the row only remembers its latest FY);
 * - the result must stay within the length limit.
 */
export function planNextNumber(
  key: SeriesKey,
  state: SeriesState,
  args: { date: DateString; prefix?: string; maxLength?: number },
): NextNumber {
  const def = SERIES[key];
  const max = args.maxLength ?? NUMBERING_DEFAULTS.gstDocumentMaxLength;
  if (!Number.isSafeInteger(state.nextValue) || state.nextValue < 1) {
    return { ok: false, error: `The ${def.noun} counter is damaged (next value ${state.nextValue}). Ask a Partner to check Settings → Numbering.` };
  }
  let seq = state.nextValue;
  let fy: FinancialYear | null = state.financialYear;
  if (def.fyScoped) {
    const dateFy = financialYearOf(args.date);
    const rowStart = state.financialYear ? parseFinancialYear(state.financialYear) : null;
    const dateStart = parseFinancialYear(dateFy) as number;
    if (rowStart !== null && dateStart < rowStart) {
      return {
        ok: false,
        error: `The ${def.noun} series has moved on to FY ${state.financialYear}, so it can't number a document dated in FY ${dateFy}.`,
      };
    }
    if (rowStart === null || dateStart > rowStart) seq = 1;
    fy = dateFy;
  }
  const number = formatSeriesNumber(key, { seq, prefix: args.prefix, fy: fy ?? undefined });
  if (number.length > max) {
    return {
      ok: false,
      error: `The next ${def.noun} number (${number}) would be longer than ${max} characters. Shorten the prefix in Settings → Numbering.`,
    };
  }
  return { ok: true, number, seq, next: { financialYear: def.fyScoped ? fy : state.financialYear, nextValue: seq + 1 } };
}

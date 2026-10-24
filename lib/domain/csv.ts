/**
 * CSV for exports (§3.4 "CSV export of the current view", §7.20 audit log, §7.21 full export).
 *
 * RFC 4180: fields separated by commas, rows ended by CRLF, a field quoted when it holds a comma, a
 * double quote, a line break or leading/trailing spaces, with quotes doubled inside it.
 *
 * Formula injection (CSV injection, OWASP): a spreadsheet runs a cell that starts with `=`, `+`, `-`
 * or `@` (and a tab or a carriage return, which some programs strip first) as a formula. Such text is
 * prefixed with a single quote `'`, so it shows as typed and never runs. A plain number written as
 * text ("-1500.00") is left alone: it is a value, not a formula. Numbers, booleans and dates are
 * written as values.
 *
 * Pure and client-safe; no I/O.
 *
 *   csvRow(["Name", "Amount"])                          → 'Name,Amount\r\n'
 *   csvCell('=HYPERLINK("http://x")')                   → '"\'=HYPERLINK(""http://x"")"'
 *   csvDocument(["a", "b"], [[1, "x, y"]], { bom: true }) → '﻿a,b\r\n1,"x, y"\r\n'
 */

/** UTF-8 byte-order mark: Excel opens the file as UTF-8 (₹, names in Indian scripts) when it starts with it. */
export const CSV_BOM = "﻿";

export const CSV_LINE_END = "\r\n";

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** True when a spreadsheet would treat this text as a formula (and it isn't a plain number). */
export function looksLikeFormula(text: string): boolean {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text);
}

/** The text of one value, before quoting: formulas neutralised, objects as JSON, missing as empty. */
export function csvText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  }
  return looksLikeFormula(text) ? `'${text}` : text;
}

/** One field, quoted when it must be. */
export function csvCell(value: unknown): string {
  const text = csvText(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row, with its CRLF. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",") + CSV_LINE_END;
}

/** A whole file: the header row, then each row; optionally starting with the UTF-8 BOM. */
export function csvDocument(headers: readonly string[], rows: Iterable<readonly unknown[]>, opts: { bom?: boolean } = {}): string {
  let out = (opts.bom ? CSV_BOM : "") + csvRow(headers);
  for (const r of rows) out += csvRow(r);
  return out;
}

/**
 * A safe file name for a CSV in an archive or a download: letters, digits, dot, dash and underscore;
 * anything else becomes `-`, never empty, never a path.
 */
export function csvFileName(base: string, ext = "csv"): string {
  const clean = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return `${clean || "export"}.${ext}`;
}

/**
 * Reading a spreadsheet the client sent (§6.12 purchase register, §6.13 trial balance) into rows
 * keyed by header, the step before column mapping. Shared by both workpapers and by the server
 * (lib/data/gst-recon.ts reads the stored file and calls these); the XLSX parsing itself (exceljs)
 * stays on the server, so only plain cell values arrive here.
 *
 * - Text files are decoded as UTF-8 (a byte-order mark is dropped); a file that isn't valid UTF-8 is
 *   read as Windows-1252, which is what Tally and older Excel versions write.
 * - The header is the row within the first 20 that best matches the fields' spellings (exports often
 *   carry a company name, a period and blank lines above it); a person can choose another row.
 * - Blank headers become "Column 3"; repeated headers get "(2)", "(3)" so every column has a name.
 *
 * Pure (papaparse is a pure parser) and client-safe.
 */

import Papa from "papaparse";
import { cellText, normaliseHeader, type FieldSpec, type SheetRow } from "@/lib/domain/gstr2b";

/** A sheet as rows of cells (numbers, text, dates, booleans or null). */
export type CellMatrix = unknown[][];

/** How many rows the header search looks at. */
export const HEADER_SCAN_ROWS = 20;
/** Rows shown in the mapping preview. */
export const PREVIEW_ROWS = 6;
/** The most data rows read from one file (a monthly register or a trial balance is far smaller). */
export const MAX_SHEET_ROWS = 100_000;

/** Decodes a text file: UTF-8 (BOM dropped), or Windows-1252 when it isn't valid UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder("windows-1252").decode(bytes);
    } catch {
      text = new TextDecoder("utf-8").decode(bytes);
    }
  }
  return text.replace(/^﻿/, "");
}

/** Parses CSV text (comma, semicolon or tab; quoted cells kept) into rows of text cells. */
export function csvToMatrix(text: string): CellMatrix {
  const result = Papa.parse<string[]>(text, { header: false, skipEmptyLines: "greedy", dynamicTyping: false });
  return (result.data ?? []).filter((r) => Array.isArray(r)).slice(0, MAX_SHEET_ROWS + HEADER_SCAN_ROWS);
}

/**
 * A cell as exceljs gives it, as a plain value: formulas give their result, rich text its text,
 * hyperlinks their text, errors null. Dates stay Date objects (lib/domain/gstr2b reads them as the
 * IST calendar date).
 */
export function plainCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if ("result" in v) return plainCell(v.result);
  if (Array.isArray(v.richText)) return v.richText.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  if (typeof v.text === "string") return v.text;
  if ("error" in v) return null;
  if ("sharedFormula" in v || "formula" in v) return null;
  return null;
}

function rowFilled(row: readonly unknown[]): number {
  return row.reduce<number>((n, c) => (cellText(c) !== "" ? n + 1 : n), 0);
}

/**
 * The 0-based index of the header row: among the first rows, the one whose cells match the most
 * field spellings (exactly, or containing a spelling of four letters or more). With no match at
 * all, the first row with at least two filled cells.
 */
export function detectHeaderRow<F extends string>(matrix: CellMatrix, specs: readonly FieldSpec<F>[], maxScan = HEADER_SCAN_ROWS): number {
  const exact = new Set(specs.flatMap((s) => s.synonyms.map((x) => normaliseHeader(x))));
  const partial = [...exact].filter((x) => x.length >= 4);
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(matrix.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i] ?? [];
    let score = 0;
    for (const cell of row) {
      if (typeof cell !== "string") continue;
      const n = normaliseHeader(cell);
      if (n === "") continue;
      if (exact.has(n)) score += 2;
      else if (partial.some((p) => n.includes(p))) score += 1;
    }
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best >= 0 && bestScore >= 2) return best;
  for (let i = 0; i < limit; i++) if (rowFilled(matrix[i] ?? []) >= 2) return i;
  return 0;
}

/** Header texts with every column named: blanks become "Column N", repeats get "(2)". */
export function headerNames(row: readonly unknown[], width: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = cellText(row[i]).replace(/\s+/g, " ").trim();
    if (name === "") name = `Column ${i + 1}`;
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push(n === 1 ? name : `${name} (${n})`);
  }
  return out;
}

export type SheetRecords = {
  headers: string[];
  rows: SheetRow[];
  /** The spreadsheet row number (1-based) of the first data row, for row-level messages. */
  firstRowNumber: number;
  /** 1-based header row, as a person reads the spreadsheet. */
  headerRow: number;
  /** Data rows read (blank rows included, as the parsers count them). */
  rowCount: number;
  /** True when the file had more rows than MAX_SHEET_ROWS and the rest were left out. */
  truncated: boolean;
};

/**
 * Rows keyed by header. `headerIndex` is 0-based (detectHeaderRow, or a person's choice minus one).
 * Columns past the header's width are named too, so nothing typed in them is lost.
 */
export function matrixToRecords(matrix: CellMatrix, headerIndex: number): SheetRecords {
  const h = Math.max(0, Math.min(headerIndex, Math.max(0, matrix.length - 1)));
  const body = matrix.slice(h + 1);
  const truncated = body.length > MAX_SHEET_ROWS;
  const data = truncated ? body.slice(0, MAX_SHEET_ROWS) : body;
  const width = Math.max((matrix[h] ?? []).length, ...data.slice(0, 500).map((r) => r.length), 0);
  const headers = headerNames(matrix[h] ?? [], width);
  const rows: SheetRow[] = data.map((r) => {
    const rec: Record<string, unknown> = {};
    headers.forEach((name, i) => {
      rec[name] = r[i] ?? null;
    });
    return rec;
  });
  return { headers, rows, firstRowNumber: h + 2, headerRow: h + 1, rowCount: rows.length, truncated };
}

/** The first rows as display text, for the mapping preview. */
export function previewRows(records: Pick<SheetRecords, "headers" | "rows">, count = PREVIEW_ROWS): string[][] {
  return records.rows
    .filter((r) => records.headers.some((h) => cellText(r[h]) !== ""))
    .slice(0, count)
    .map((r) => records.headers.map((h) => cellText(r[h])));
}

import { amountInWords, formatINR, toPaise, type Paise } from "@/lib/domain/money";
import { EMPTY, formatDate, formatDateTime, formatPercent } from "@/lib/format";

/**
 * Formatting for PDFs (§11 "All money in PDFs uses Indian grouping, and all dates use 22 Oct 2026
 * style"; §0.1 rule 7 amounts in words with lakh and crore). Thin wrappers over lib/domain/money and
 * lib/format so PDFs, screens and emails print the same. Pure.
 */

/** ₹1,23,456.00 from integer paise. */
export function pdfMoney(paise: Paise, opts: { symbol?: boolean } = {}): string {
  return formatINR(paise, { symbol: opts.symbol ?? true });
}

/** ₹1,23,456.00 from a database numeric (rupees as a number or string); `—` when missing. */
export function pdfMoneyFromRupees(value: number | string | null | undefined, opts: { symbol?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  try {
    return formatINR(toPaise(value), { symbol: opts.symbol ?? true });
  } catch {
    return EMPTY;
  }
}

/** "Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Fifty Paise Only". */
export function pdfAmountInWords(paise: Paise): string {
  return amountInWords(paise);
}

/** 22 Oct 2026; `—` when missing. */
export function pdfDate(value: string | Date | null | undefined): string {
  return formatDate(value);
}

/** 22 Oct 2026, 14:05 (IST); `—` when missing. */
export function pdfDateTime(value: string | Date | null | undefined): string {
  return formatDateTime(value);
}

/** 18% / 12.5%; `—` when missing. */
export function pdfPercent(value: number | string | null | undefined): string {
  return formatPercent(value);
}

/** A value or the em dash for a missing one (a real zero prints). */
export function pdfText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  const s = String(value).trim();
  return s === "" ? EMPTY : s;
}

/** A file name for a PDF of a numbered document: "TW/26-27/0042" → "TW-26-27-0042.pdf". */
export function pdfFileName(documentNumber: string, prefix?: string): string {
  const safe = documentNumber.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${prefix ? `${prefix}-` : ""}${safe || "document"}.pdf`;
}

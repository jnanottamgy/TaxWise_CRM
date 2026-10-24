import "server-only";

import ExcelJS from "exceljs";
import { fromPaise } from "@/lib/domain/money";
import { isDateString } from "@/lib/domain/fy";
import { looksLikeFormula } from "@/lib/domain/csv";
import { formatDateTime } from "@/lib/format";
import { isLinkCell, isStatusCell, reportCellText, type ReportCell, type ReportColumn, type ReportResult } from "@/components/reports/report-types";

/**
 * A report as an Excel workbook (§7.16 "Excel export"): a Summary sheet (the title, what it counts,
 * the period, the filters, when and by whom it was made, and the headline figures), then one sheet per
 * section with every row (the export isn't paged or capped like the screen). Values stay values:
 * money as rupees with Indian grouping, percentages, counts, hours as hours, dates as dates. Text that
 * a spreadsheet would run as a formula is quoted (lib/domain/csv.ts).
 */

const MONEY_FMT = "₹#,##,##0.00;-₹#,##,##0.00";
const PERCENT_FMT = '0.0"%"';
const DATE_FMT = "dd mmm yyyy";

function safeText(s: string): string {
  return looksLikeFormula(s) ? `'${s}` : s;
}

/** The cell value for a column's kind: numbers stay numbers, dates become dates, the rest text. */
function cellValue(col: ReportColumn, v: ReportCell | undefined): string | number | Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (isStatusCell(v)) return safeText(v.label);
  if (isLinkCell(v)) return safeText(v.sub ? `${v.text} (${v.sub})` : v.text);
  if (typeof v === "number") {
    switch (col.kind) {
      case "money":
        return fromPaise(v);
      case "hours":
        return Math.round((v / 60) * 100) / 100;
      default:
        return v;
    }
  }
  if (col.kind === "date" && isDateString(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return safeText(String(v));
}

function numFmt(col: ReportColumn): string | undefined {
  switch (col.kind) {
    case "money":
      return MONEY_FMT;
    case "percent":
      return PERCENT_FMT;
    case "hours":
    case "days":
      return "0.0";
    case "date":
      return DATE_FMT;
    case "count":
      return "#,##0";
    default:
      return undefined;
  }
}

function header(col: ReportColumn): string {
  if (col.kind === "money") return `${col.header} (₹)`;
  if (col.kind === "hours") return `${col.header} (hours)`;
  if (col.kind === "days") return `${col.header} (days)`;
  if (col.kind === "percent") return `${col.header} (%)`;
  return col.header;
}

function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "Sheet";
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${i++}`;
  used.add(name.toLowerCase());
  return name;
}

export async function buildReportWorkbook(report: ReportResult, meta: { firmName: string; generatedBy: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.firmName;
  wb.created = new Date(report.generatedAt);
  wb.title = `${report.title} report`;
  const used = new Set<string>();

  // Summary
  const ws = wb.addWorksheet(sheetName("Summary", used));
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 48;
  const title = ws.addRow([`${report.title} report`]);
  title.font = { bold: true, size: 14 };
  ws.addRow([safeText(report.counts)]);
  ws.getCell(`A${ws.rowCount}`).alignment = { wrapText: true, vertical: "top" };
  ws.mergeCells(ws.rowCount, 1, ws.rowCount, 2);
  ws.getRow(ws.rowCount).height = 48;
  ws.addRow([]);
  ws.addRow(["Period", safeText(report.period.label)]);
  ws.addRow(["Filters", report.scope.length ? safeText(report.scope.join("; ")) : "None (the whole firm)"]);
  ws.addRow(["Prepared", `${formatDateTime(report.generatedAt)} IST by ${safeText(meta.generatedBy)}`]);
  ws.addRow([meta.firmName, "Confidential: for the firm's use only."]);
  ws.addRow([]);
  const kh = ws.addRow(["Figure", "Value"]);
  kh.font = { bold: true };
  for (const k of report.kpis) {
    const row = ws.addRow([safeText(k.label), cellValue({ key: "v", header: k.label, kind: k.kind }, k.value as ReportCell)]);
    const fmt = numFmt({ key: "v", header: "", kind: k.kind });
    if (fmt) row.getCell(2).numFmt = fmt;
    row.getCell(2).alignment = { horizontal: "right" };
    if (k.sub) ws.addRow([`  ${safeText(k.sub)}`]).font = { color: { argb: "FF5B6476" } };
  }

  // One sheet per section
  for (const s of report.sections) {
    const sheet = wb.addWorksheet(sheetName(s.title, used), { views: [{ state: "frozen", ySplit: 3 }] });
    sheet.addRow([safeText(s.title)]).font = { bold: true, size: 12 };
    sheet.addRow([s.description ? safeText(s.description) : `${report.title} report, ${report.period.label}`]);
    const h = sheet.addRow(s.columns.map(header));
    h.font = { bold: true };
    s.columns.forEach((c, i) => {
      const col = sheet.getColumn(i + 1);
      col.width = c.kind === "text" || c.kind === "link" ? (i === 0 ? 36 : 24) : 16;
      const fmt = numFmt(c);
      if (fmt) col.numFmt = fmt;
      if (c.kind !== "text" && c.kind !== "link" && c.kind !== "status") col.alignment = { horizontal: "right" };
    });
    if (s.rows.length === 0) sheet.addRow([safeText(s.empty)]);
    for (const r of s.rows) sheet.addRow(s.columns.map((c) => cellValue(c, r[c.key])));
    if (s.totals) {
      const t = sheet.addRow(s.columns.map((c) => cellValue(c, s.totals?.[c.key])));
      t.font = { bold: true };
    }
    if (s.total !== undefined && s.total > s.rows.length) {
      sheet.addRow([]);
      sheet.addRow([`${s.rows.length} of ${s.total} rows: the rest are in the app.`]);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/** The text of a cell (exported for the PDF and tests). */
export function reportText(col: ReportColumn, v: ReportCell | undefined): string {
  return reportCellText(col.kind, v);
}

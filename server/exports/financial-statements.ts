import "server-only";

import { fromPaise, type Paise } from "@/lib/domain/money";
import { CONFIDENCE_LABELS, bucketDef } from "@/lib/domain/buckets";
import type { StatementLine, Statements } from "@/lib/domain/schedule3";
import { EMPTY, formatDateTime } from "@/lib/format";
import { FS_STATUS_META, LEDGER_SOURCE_LABELS, comparativeYear, yearEndedLabel } from "@/lib/schemas/financial-statements";
import type { StatementDetail } from "@/lib/data/financial-statements";
import { writeXlsx, type XlsxSheet } from "@/server/exports/revenue-ledger";

/**
 * The financial statements workbook (§6.13 "Export to PDF and Excel", §7.8.3 step 6): the balance
 * sheet and the statement of profit and loss in Schedule III order with last year's figures, the
 * notes (each line's ledger break-up, the ageing schedules, the MSME disclosure), the trial balance
 * with each ledger's bucket and confidence, and the checks. Amounts are rupees with two decimals,
 * computed from paise. Built from the statement as saved (rebuilt on the server at every save).
 */

const r = (p: Paise | null | undefined): number | null => (p === null || p === undefined ? null : fromPaise(p));

function indent(line: StatementLine): string {
  const pad = line.kind === "subitem" ? "      " : line.kind === "item" ? "   " : "";
  return `${pad}${line.ref ? `${line.ref} ` : ""}${line.label}`;
}

function statementSheet(name: string, title: string, lines: StatementLine[], years: { current: string; previous: string | null }): XlsxSheet {
  return {
    name,
    freeze: false,
    preamble: [[title], []],
    headers: ["Particulars", "Note", `FY ${years.current}`, years.previous ? `FY ${years.previous}` : "Previous year"],
    moneyColumns: [2, 3],
    widths: [64, 8, 20, 20],
    rows: lines.map((l) => [indent(l), l.note, l.kind === "heading" || l.kind === "group" ? null : r(l.current), l.kind === "heading" || l.kind === "group" ? null : r(l.previous)]),
  };
}

function notesSheet(s: Statements, noteTexts: Record<string, string>, policies: string | null): XlsxSheet {
  const rows: Array<Array<string | number | null>> = [];
  for (const n of s.notes) {
    rows.push([`Note ${n.number}`, n.title, null, null]);
    if (n.kind === "text") {
      rows.push([null, policies ?? n.text ?? EMPTY, null, null]);
    } else if (n.table) {
      rows.push([null, n.key === "payables_ageing" ? "The schedule is on the Payables ageing sheet." : "The schedule is on the Receivables ageing sheet.", n.total ? r(n.total.current) : null, null]);
    } else {
      for (const l of n.lines) rows.push([null, l.label, r(l.current), r(l.previous)]);
      if (n.total) rows.push([null, "Total", r(n.total.current), r(n.total.previous)]);
    }
    const extra = noteTexts[n.key];
    if (extra) rows.push([null, extra, null, null]);
    rows.push([]);
  }
  return { name: "Notes", headers: ["Note", "Particulars", "Current year", "Previous year"], moneyColumns: [2, 3], widths: [10, 80, 20, 20], rows };
}

/** One sheet per ageing schedule (Schedule III, 2021): categories down, the bands across. */
function ageingSheets(s: Statements): XlsxSheet[] {
  return s.notes
    .filter((n) => n.kind === "ageing" && n.table)
    .map((n) => {
      const t = n.table as NonNullable<typeof n.table>;
      return {
        name: n.key === "payables_ageing" ? "Payables ageing" : "Receivables ageing",
        freeze: false,
        preamble: [[`Note ${n.number} · ${n.title} (outstanding from the due date of payment)`], []],
        headers: ["Particulars", ...t.columns],
        moneyColumns: t.columns.map((_, i) => i + 1),
        widths: [56, ...t.columns.map(() => 18)],
        rows: t.rows.map((row) => [row.label, ...row.values.map((v) => r(v))]),
      } satisfies XlsxSheet;
    });
}

export async function buildFinancialStatementsWorkbook(d: StatementDetail): Promise<{ bytes: Buffer; counts: Record<string, number> }> {
  const s = d.statements;
  if (!s) throw new Error("statement has no figures");
  const fy = d.row.financial_year;
  const years = { current: fy, previous: s.totals.previous ? comparativeYear(fy) : null };
  const end = yearEndedLabel(fy);
  const head = `${d.client.name} (${d.client.code})`;

  const sheets: XlsxSheet[] = [
    statementSheet("Balance sheet", `${head} · Balance sheet as at ${end}`, s.balanceSheet, years),
    statementSheet("Profit and loss", `${head} · Statement of profit and loss for the year ended ${end}`, s.profitAndLoss, years),
    notesSheet(s, d.inputs.noteTexts, d.inputs.policies),
    ...ageingSheets(s),
    {
      name: "Trial balance",
      headers: ["Row", "Ledger", "Group", "Debit", "Credit", "Schedule III line", "Confidence", "How it was mapped", "Why"],
      moneyColumns: [3, 4],
      widths: [8, 40, 28, 18, 18, 36, 18, 26, 70],
      rows: d.ledgers.map((l) => [
        l.row || null,
        l.name,
        l.group,
        r(l.debit),
        r(l.credit),
        l.bucket ? bucketDef(l.bucket).label : "Not mapped",
        CONFIDENCE_LABELS[l.confidence],
        LEDGER_SOURCE_LABELS[l.source],
        l.reason,
      ]),
    },
    {
      name: "Checks",
      freeze: false,
      headers: ["Check", "Result", "Difference", "Detail"],
      moneyColumns: [2],
      widths: [48, 12, 18, 100],
      preamble: [[`${head} · FY ${fy} · ${FS_STATUS_META[d.row.status].label} · last saved ${formatDateTime(d.updatedAt)}`], []],
      rows: [
        ...s.checks.map((c) => [c.title, c.status === "pass" ? "Passes" : c.status === "fail" ? "Fails" : "Not run", c.difference === null ? null : r(c.difference), c.message] as Array<string | number | null>),
        ...s.warnings.map((w) => ["Warning", null, null, w] as Array<string | number | null>),
      ],
    },
  ];
  const bytes = await writeXlsx(sheets, { title: `Financial statements · ${d.client.name} · FY ${fy}` });
  return { bytes, counts: { ledgers: d.ledgers.length, notes: s.notes.length, checks: s.checks.length } };
}

/** "taxwise-financial-statements-TW-C-0042-2025-26.xlsx". */
export function financialStatementsFileName(clientCode: string, fy: string, ext: "xlsx" | "pdf"): string {
  return `taxwise-financial-statements-${clientCode.replace(/[^A-Za-z0-9-]+/g, "-")}-${fy}.${ext}`;
}

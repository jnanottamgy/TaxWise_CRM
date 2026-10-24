import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { fromPaise, type Paise } from "@/lib/domain/money";
import { GSTR2B_SECTION_LABELS, type Gstr2bSection } from "@/lib/domain/gstr2b";
import { RECON_BUCKET_LABELS, RECON_EXPORT_HEADERS, reconExportRows, type MatchTier, type ReconBucket, type ReconEntry } from "@/lib/domain/recon";
import { EMPTY, formatDate, formatDateTime } from "@/lib/format";
import { BUCKET_META, IMS_META, RESOLUTION_META, docTypeLabel, periodLongLabel, readEntryData, type ImsAction, type ReconResolution } from "@/lib/schemas/gst-recon";
import { allRunLines, allRunSuppliers, type LineRow, type RunDetail } from "@/lib/data/gst-recon";
import { writeXlsx, type XlsxSheet } from "@/server/exports/revenue-ledger";

/**
 * The GST reconciliation workbook (§6.12 "Excel export", §7.8.1): the summary (ITC per 2B, per
 * books, matched, mismatched, missing either side, at risk, unclaimed), every line with both sides
 * and the ITC difference, the supplier roll-up, the IMS action list, the lines carried forward
 * from earlier months, and what the files' readers reported. Read under the caller's session
 * (RLS); amounts are rupees with two decimals, computed from paise.
 */

const r = (p: Paise | null | undefined): number | null => (p === null || p === undefined ? null : fromPaise(p));

function asEntry(line: LineRow): ReconEntry {
  const d = readEntryData(line.data);
  return {
    key: line.entry_key ?? line.id,
    bucket: line.bucket as ReconBucket,
    tier: (line.match_tier as MatchTier | null) ?? null,
    supplierGstin: line.supplier_gstin,
    supplierName: line.supplier_name,
    portal: d.portal,
    books: d.books,
    deltas: d.deltas,
    dateDeltaDays: d.dateDeltaDays,
    itc: d.itc,
    notes: d.notes,
  };
}

const resolutionLabel = (v: string) => RESOLUTION_META[(v as ReconResolution) in RESOLUTION_META ? (v as ReconResolution) : "open"].label;

export async function buildGstReconWorkbook(supabase: ServerSupabase, detail: RunDetail): Promise<{ bytes: Buffer; counts: Record<string, number> }> {
  const [lines, suppliers] = await Promise.all([allRunLines(supabase, detail.run.id), allRunSuppliers(supabase, detail.run.id)]);
  const s = detail.summary.summary;
  const itc = s.itc;
  const run = detail.run;

  const summary: XlsxSheet = {
    name: "Summary",
    freeze: false,
    widths: [44, 26, 18],
    headers: ["Item", "Value", "Documents"],
    preamble: [
      [`GST reconciliation · ${detail.client.name} (${detail.client.code})`],
      [`${periodLongLabel(run.period)} · GSTIN ${detail.client.gstin ?? "not on file"}`],
      [],
    ],
    moneyColumns: [1],
    rows: [
      ["ITC per GSTR-2B", r(itc.per2b), s.documents.portal],
      ["ITC per books (purchase register)", r(itc.perBooks), s.documents.books],
      ["Matched (books ITC)", r(itc.matched), s.buckets.matched.count],
      ["Mismatched (books ITC)", r(itc.mismatched), s.buckets.mismatch.count],
      ["Mismatch difference (2B − books)", r(itc.mismatchDifference), null],
      ["In 2B, not in books: unclaimed ITC", r(itc.unclaimed), s.buckets.missing_in_books.count],
      ["Credit notes in 2B not booked: ITC to reverse", r(itc.reversalPending), null],
      ["In books, not in 2B: ITC at risk", r(itc.atRiskMissingIn2b), s.buckets.missing_in_2b.count],
      ["Books ITC above 2B on mismatches", r(itc.atRiskExcessOverTwoB), null],
      ["ITC at risk (total)", r(itc.atRisk), null],
      ["ITC marked not available in 2B", r(itc.notAvailablePer2b), null],
      [],
      ["Matched on document number", null, s.byTier.exact],
      ["Matched on document number written differently", null, s.byTier.loose],
      ["Matched on amount and date", null, s.byTier.fuzzy],
      [],
      ["GSTR-2B file", detail.sources.gstr2b?.fileName ?? EMPTY, null],
      ["GSTR-2B is for GSTIN", run.portal_gstin ?? EMPTY, null],
      ["GSTR-2B generated on", detail.summary.gstr2b.generatedOn ? formatDate(detail.summary.gstr2b.generatedOn) : EMPTY, null],
      ["Purchase register", detail.sources.register?.fileName ?? EMPTY, detail.summary.register.accepted],
      ["Register rows left out", null, detail.summary.register.rejected],
      ["Run by", run.created_by_name ?? EMPTY, null],
      ["Run on", formatDateTime(run.created_at), null],
      ...(detail.summary.carryForward ? [["Open lines carried from", periodLongLabel(detail.summary.carryForward.fromPeriod), detail.summary.carryForward.stillOpen] as Array<string | number | null>] : []),
      ...detail.summary.warnings.map((w) => ["Warning", w.message, null] as Array<string | number | null>),
    ],
  };

  const exportRows = reconExportRows({ entries: lines.map(asEntry) });
  const lineSheet: XlsxSheet = {
    name: "Lines",
    headers: [...RECON_EXPORT_HEADERS, "Carried from", "Resolution", "Resolution note", "IMS action", "IMS reason"],
    moneyColumns: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    widths: [18, 22, 18, 30, 14, 18, 12, 18, 12, 14, 14, 12, 12, 12, 12, 12, 12, 10, 10, 16, 60, 14, 16, 40, 14, 50],
    rows: exportRows.map((row, i) => {
      const l = lines[i];
      return [
        ...row.map((c, j) => (j === 6 || j === 8 ? (typeof c === "string" && c ? formatDate(c) : c) : c)),
        l.origin === "carried" ? periodLongLabel(l.first_seen_period ?? run.period) : null,
        resolutionLabel(l.resolution),
        l.resolution_note,
        l.ims_action ? IMS_META[l.ims_action as ImsAction]?.label ?? l.ims_action : null,
        l.ims_reason,
      ];
    }),
  };

  const supplierSheet: XlsxSheet = {
    name: "Suppliers",
    headers: ["Supplier GSTIN", "Supplier", "Matched", "Mismatch", "Not in books", "Not in 2B", "Open lines", "To chase", "ITC at risk (open)", "Unclaimed ITC (open)", "Mismatch difference (2B − books)", "Last follow-up"],
    moneyColumns: [8, 9, 10],
    widths: [18, 32, 10, 10, 12, 10, 10, 10, 16, 16, 18, 18],
    rows: suppliers.map((x) => [
      x.supplier_gstin || EMPTY,
      x.supplier_name,
      x.matched_count,
      x.mismatch_count,
      x.missing_in_books_count,
      x.missing_in_2b_count,
      x.open_count,
      x.chase_count,
      r(x.itc_at_risk_paise),
      r(x.unclaimed_itc_paise),
      r(x.mismatch_difference_paise),
      x.last_follow_up_at ? formatDate(x.last_follow_up_at) : null,
    ]),
  };

  const ims = lines.filter((l) => l.ims_action);
  const imsSheet: XlsxSheet = {
    name: "IMS actions",
    headers: ["Section", "Supplier GSTIN", "Supplier", "Document", "Number", "Date", "ITC", "Action", "Reason", "Decided by", "Decided on"],
    moneyColumns: [6],
    widths: [24, 18, 30, 14, 18, 12, 14, 14, 60, 18, 16],
    rows: ims.map((l) => [
      l.portal_section && l.portal_section in GSTR2B_SECTION_LABELS ? GSTR2B_SECTION_LABELS[l.portal_section as Gstr2bSection] : l.portal_section,
      l.supplier_gstin,
      l.supplier_name,
      docTypeLabel(l.doc_type),
      l.portal_doc_number,
      l.portal_doc_date ? formatDate(l.portal_doc_date) : null,
      r(l.itc_portal_paise),
      IMS_META[l.ims_action as ImsAction]?.label ?? l.ims_action,
      l.ims_reason,
      l.ims_decided_by ? (l.ims_decided_by_name ?? "Staff") : "Suggested by the app",
      l.ims_decided_at ? formatDate(l.ims_decided_at) : null,
    ]),
  };

  const carried = lines.filter((l) => l.origin === "carried");
  const carriedSheet: XlsxSheet = {
    name: "Carried forward",
    headers: ["First seen", "Bucket", "Supplier GSTIN", "Supplier", "Document", "Number", "Date", "ITC", "Resolution", "Note"],
    moneyColumns: [7],
    widths: [14, 20, 18, 30, 14, 18, 12, 14, 16, 60],
    rows: carried.map((l) => [
      periodLongLabel(l.first_seen_period ?? run.period),
      BUCKET_META[l.bucket as ReconBucket]?.label ?? RECON_BUCKET_LABELS[l.bucket as ReconBucket] ?? l.bucket,
      l.supplier_gstin,
      l.supplier_name,
      docTypeLabel(l.doc_type),
      l.doc_number,
      l.doc_date ? formatDate(l.doc_date) : null,
      r(l.itc_paise),
      resolutionLabel(l.resolution),
      l.resolution_note ?? readEntryData(l.data).notes.join(" "),
    ]),
  };

  const issues: XlsxSheet = {
    name: "File issues",
    headers: ["File", "Where", "Level", "Issue"],
    widths: [16, 24, 10, 90],
    rows: [
      ...detail.diagnostics.gstr2b.map((d) => ["GSTR-2B", d.ref ?? "file", d.level, d.message] as Array<string | number | null>),
      ...detail.diagnostics.register.map((d) => ["Register", d.row > 0 ? `Row ${d.row}` : "file", d.level, d.message] as Array<string | number | null>),
    ],
  };

  const bytes = await writeXlsx([summary, lineSheet, supplierSheet, imsSheet, carriedSheet, issues], {
    title: `GST reconciliation · ${detail.client.name} · ${periodLongLabel(run.period)}`,
  });
  return { bytes, counts: { lines: lines.length, suppliers: suppliers.length, ims: ims.length, carried: carried.length } };
}

/** "taxwise-gst-recon-TW-C-0042-092026.xlsx". */
export function gstReconFileName(clientCode: string, period: string): string {
  return `taxwise-gst-recon-${clientCode.replace(/[^A-Za-z0-9-]+/g, "-")}-${period}.xlsx`;
}


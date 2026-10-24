import "server-only";

import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PDF, PdfDocument, PdfFacts, PdfParagraph, PdfSection, PdfTable, loadFirmLogo, pdfDateTime, renderPdf, type PdfColumn } from "@/server/pdf";
import { isNumericKind, reportCellText, type ReportResult, type ReportSection } from "@/components/reports/report-types";

/**
 * A report as a PDF (§7.16 "PDF export", §11): the firm's letterhead, the report's title, what it
 * counts, the period and filters, the headline figures, then every section as a table with its
 * totals. Landscape when a section is wide. Marked confidential (it can hold fees and people's
 * attendance). Rendered on the server (§2.1).
 */

const MAX_PDF_ROWS = 2000;

function columnsFor(s: ReportSection): PdfColumn[] {
  return s.columns.map((c, i) => ({
    key: c.key,
    header: c.header,
    flex: i === 0 ? 2.6 : c.kind === "text" || c.kind === "link" ? 1.6 : c.kind === "status" ? 1.3 : 1,
    align: isNumericKind(c.kind) ? "right" : "left",
  }));
}

function SectionBlock({ s }: { s: ReportSection }) {
  const rows = s.rows.slice(0, MAX_PDF_ROWS).map((r) => Object.fromEntries(s.columns.map((c) => [c.key, reportCellText(c.kind, r[c.key])])));
  const totals = s.totals
    ? [
        {
          label: reportCellText("text", s.totals[s.columns[0].key]),
          values: Object.fromEntries(s.columns.slice(1).map((c) => [c.key, s.totals?.[c.key] === null || s.totals?.[c.key] === undefined ? "" : reportCellText(c.kind, s.totals?.[c.key])])),
          emphasis: true,
        },
      ]
    : [];
  const shown = Math.min(s.rows.length, MAX_PDF_ROWS);
  const total = s.total ?? s.rows.length;
  return (
    <PdfSection title={s.title}>
      {s.description ? <PdfParagraph muted>{s.description}</PdfParagraph> : null}
      {s.rows.length === 0 ? (
        <PdfParagraph muted>{s.empty}</PdfParagraph>
      ) : (
        <PdfTable columns={columnsFor(s)} rows={rows} totals={totals} fontSize={PDF.size.label} />
      )}
      {total > shown ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>{`${shown} of ${total} rows shown. The rest are in the app.`}</Text> : null}
    </PdfSection>
  );
}

export function ReportPdf({ firm, logo, report, generatedBy }: { firm: FirmProfile; logo: Awaited<ReturnType<typeof loadFirmLogo>>; report: ReportResult; generatedBy: string }) {
  const wide = report.sections.some((s) => s.columns.length > 6);
  return (
    <PdfDocument
      firm={firm}
      logo={logo}
      landscape={wide}
      title={`${report.title} report`}
      documentTitle={`${report.title} report · ${report.period.label}`}
      meta={[
        { label: "Period", value: report.period.label },
        { label: "Prepared", value: `${pdfDateTime(report.generatedAt)} IST` },
      ]}
      footerNote="Confidential report"
    >
      <PdfParagraph>{report.counts}</PdfParagraph>
      <PdfParagraph muted>{`Filters: ${report.scope.length ? report.scope.join("; ") : "none (the whole firm)"}. Prepared by ${generatedBy}.`}</PdfParagraph>
      <View style={{ marginTop: 4 }}>
        <PdfFacts columns={3} facts={report.kpis.map((k) => ({ label: k.label, value: `${reportCellText(k.kind, k.value)}${k.sub ? ` (${k.sub})` : ""}` }))} />
      </View>
      {report.sections.map((s) => (
        <SectionBlock key={s.id} s={s} />
      ))}
    </PdfDocument>
  );
}

export async function buildReportPdf(input: { firm: FirmProfile; report: ReportResult; generatedBy: string }): Promise<Buffer> {
  const logo = await loadFirmLogo(input.firm);
  return renderPdf(<ReportPdf firm={input.firm} logo={logo} report={input.report} generatedBy={input.generatedBy} />);
}

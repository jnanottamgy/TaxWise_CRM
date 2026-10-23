import "server-only";

import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PDF, PdfDocument, PdfFacts, PdfParagraph, PdfSection, PdfTable, pdfDate, pdfText, type PdfLogo } from "@/server/pdf";
import { getStatus } from "@/lib/status";
import type { DateString } from "@/lib/domain/fy";
import type { ReportData } from "@/lib/data/compliance";
import { eventDisplayStatus, reportOutcome, type ReportOutcome } from "@/components/compliance/logic/event";

/**
 * The client compliance report (§7.7, §11): for a client and a date range, every statutory deadline
 * due in it, its status, the filed-on date, the acknowledgement number and whether it was on time.
 * Branded (letterhead and the J-TACS footer), for sending to the client. Due dates are the dates in
 * force, so a government extension counts (the circular is noted under the date). No fees.
 */

export interface ReportSummary {
  total: number;
  onTime: number;
  late: number;
  filedNoDate: number;
  overdue: number;
  due: number;
}

export function summarise(data: ReportData, today: DateString): { rows: Array<ReportData["rows"][number] & { outcome: ReturnType<typeof reportOutcome> }>; summary: ReportSummary } {
  const summary: ReportSummary = { total: 0, onTime: 0, late: 0, filedNoDate: 0, overdue: 0, due: 0 };
  const count: Record<ReportOutcome, keyof ReportSummary> = { on_time: "onTime", late: "late", filed: "filedNoDate", overdue: "overdue", due: "due" };
  const rows = data.rows.map((r) => {
    const outcome = reportOutcome(r, r.filed_on, today);
    summary.total++;
    summary[count[outcome.outcome]]++;
    return { ...r, outcome };
  });
  return { rows, summary };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ComplianceReportPdf({
  firm,
  logo,
  data,
  range,
  today,
  preparedBy,
}: {
  firm: FirmProfile;
  logo: PdfLogo | null;
  data: ReportData;
  range: { from: DateString; to: DateString };
  today: DateString;
  preparedBy: string;
}) {
  const { rows, summary } = summarise(data, today);
  const filed = summary.onTime + summary.late + summary.filedNoDate;
  const address = [data.client.address, data.client.city, data.client.pincode].filter(Boolean).join(", ");
  const sentence = [
    plural(summary.total, "deadline", "deadlines"),
    `${filed} filed`,
    summary.onTime ? `${summary.onTime} on time` : null,
    summary.late ? `${summary.late} late` : null,
    summary.overdue ? `${summary.overdue} not filed` : null,
    summary.due ? `${summary.due} not yet due` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PdfDocument
      firm={firm}
      logo={logo}
      title="Compliance report"
      documentTitle={`Compliance report · ${data.client.display_name}`}
      meta={[
        { label: "Client code", value: data.client.client_code },
        { label: "Period", value: `${pdfDate(range.from)} – ${pdfDate(range.to)}` },
        { label: "Prepared on", value: pdfDate(today) },
      ]}
      landscape
    >
      <PdfSection title="Client">
        <PdfFacts
          columns={3}
          facts={[
            { label: "Name", value: data.client.legal_name ?? data.client.display_name },
            { label: "PAN", value: data.client.pan },
            { label: "GSTIN", value: data.client.gstin },
            { label: "TAN", value: data.client.tan },
            { label: "Address", value: address || null },
            { label: "Prepared by", value: preparedBy },
          ]}
        />
      </PdfSection>

      <PdfSection title="Summary">
        <PdfParagraph>{summary.total === 0 ? "No statutory deadlines fell due in this period." : sentence}.</PdfParagraph>
      </PdfSection>

      {rows.length > 0 ? (
        <PdfTable
          fontSize={PDF.size.label}
          columns={[
            { key: "due", header: "Due date", width: 92 },
            { key: "return", header: "Return or form", flex: 3 },
            { key: "period", header: "Period", width: 78 },
            { key: "status", header: "Status", width: 72 },
            { key: "filed", header: "Filed on", width: 62, align: "right" },
            { key: "ack", header: "Acknowledgement", width: 120 },
            { key: "outcome", header: "On time?", width: 92 },
          ]}
          rows={rows.map((r) => {
            const display = eventDisplayStatus(r, today);
            const label = display === "overdue" ? "Overdue" : getStatus("compliance_workflow", display).label;
            return {
              due: (
                <View>
                  <Text>{pdfDate(r.due_date)}</Text>
                  {r.original_due_date && r.original_due_date !== r.due_date ? (
                    <Text style={{ color: PDF.colour.textMuted, fontSize: PDF.size.small }}>
                      Extended from {pdfDate(r.original_due_date)}
                      {r.override_ref ? ` (${r.override_ref})` : ""}
                    </Text>
                  ) : null}
                </View>
              ),
              return: r.form_code && !r.title.startsWith(r.form_code) ? `${r.form_code} · ${r.title}` : r.title,
              period: pdfText(r.filing_period),
              status: label,
              filed: r.filed_on ? pdfDate(r.filed_on) : "—",
              ack: pdfText(r.acknowledgement_no),
              outcome: (
                <Text style={{ color: r.outcome.outcome === "late" || r.outcome.outcome === "overdue" ? PDF.colour.dangerText : r.outcome.outcome === "on_time" ? PDF.colour.successText : PDF.colour.text }}>
                  {r.outcome.text}
                </Text>
              ),
            };
          })}
        />
      ) : null}

      <PdfParagraph muted>
        Due dates are the dates in force, including government extensions (the circular is noted under the date). A return counts as on time when it was filed on or before that date.
        Acknowledgement numbers are the ARN, acknowledgement or SRN issued by the portal.
      </PdfParagraph>
    </PdfDocument>
  );
}

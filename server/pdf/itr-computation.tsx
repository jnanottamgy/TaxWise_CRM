import "server-only";

import type * as React from "react";
import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PDF, PdfDocument, PdfFacts, PdfParagraph, PdfSection, PdfSignature, PdfTable, loadFirmLogo, pdfDate, pdfDateTime, pdfFileName, renderPdf, type PdfLogo } from "@/server/pdf";
import { formatINR, type Paise } from "@/lib/domain/money";
import { AGE_BAND_LABELS, REGIMES, type Regime } from "@/lib/domain/itr-rulesets";
import type { ItrResult } from "@/lib/domain/itr";
import { ITR_STATUS_INFO, REGIME_LABEL, RETURN_KIND_LABEL, interestSectionLabels, regimeSummary, sideBySideRows, type ItrStatus, type StoredItrInputs } from "@/lib/schemas/itr";

/**
 * The ITR computation sheet (§11 "ITR computation sheet", §6.11, §7.8.2) on the firm's letterhead:
 * the assessee, the recommended regime and the saving, both regimes side by side line by line with
 * each line's working, the interest workings under the year's statute (ss.234A–234C under the 1961
 * Act; under the 2025 Act the corresponding provisions, printed as the 1961 section "(corresponding
 * provision of the Income-tax Act, 2025)" while the mapping is unverified, §6.1), the notes, and who
 * prepared, reviewed and finalised it. The year is labelled "AY 2026-27" or "Tax year 2026-27" by
 * statute (§6.1). Drawn from the same rows as the screen (lib/schemas/itr.ts sideBySideRows).
 */

export type ItrPdfData = {
  id: string;
  status: ItrStatus;
  label: string | null;
  client: { name: string; legalName: string | null; code: string; pan: string | null; address: string | null };
  inputs: StoredItrInputs;
  result: ItrResult;
  regimeChosen: Regime | null;
  preparedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  finalisedBy: string | null;
  finalisedAt: string | null;
  ruleSetVerified: boolean | null;
  printedBy: string;
  printedOn: string;
};

function amount(p: Paise | undefined): string {
  if (p === undefined) return "—";
  const v = p === 0 ? 0 : p;
  return v % 100 === 0 ? formatINR(v, { decimals: 0 }) : formatINR(v);
}

function Cell({ value, note, detail, bold }: { value: Paise | undefined; note?: string; detail?: string; bold?: boolean }) {
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text style={{ fontWeight: bold ? 700 : 400, color: value === undefined ? PDF.colour.textMuted : PDF.colour.text }}>{amount(value)}</Text>
      {detail ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, textAlign: "right" }}>{detail}</Text> : null}
      {note ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, textAlign: "right" }}>{note}</Text> : null}
    </View>
  );
}

export function ItrComputationPdf({ firm, logo, data }: { firm: FirmProfile; logo: PdfLogo | null; data: ItrPdfData }) {
  const r = data.result;
  const rec = r.recommendedRegime;
  const rows = sideBySideRows(r);
  const labels = interestSectionLabels(r, "pdf");
  const e = data.inputs.engine;
  const summaries = { new: regimeSummary(r.regimes.new), old: regimeSummary(r.regimes.old) };
  const statusLine =
    data.status === "final"
      ? `Final${data.finalisedBy ? `, by ${data.finalisedBy}` : ""}${data.finalisedAt ? ` on ${pdfDate(data.finalisedAt)}` : ""}`
      : data.status === "reviewed"
        ? `Reviewed${data.reviewedBy ? ` by ${data.reviewedBy}` : ""}${data.reviewedAt ? ` on ${pdfDate(data.reviewedAt)}` : ""}; not yet final`
        : "Draft: not yet reviewed";
  const balance = (b: Paise) => (b > 0 ? `Payable ${amount(b)}` : b < 0 ? `Refund ${amount(-b)}` : "Nil");

  return (
    <PdfDocument
      firm={firm}
      logo={logo}
      title="Computation of income and tax"
      documentTitle={`ITR computation · ${data.client.name} · ${r.yearLabel}`}
      meta={[
        { label: "Year", value: r.yearLabel },
        { label: "Client code", value: data.client.code },
        { label: "Status", value: ITR_STATUS_INFO[data.status].label },
        { label: "Printed on", value: pdfDate(data.printedOn) },
      ]}
      footerNote={`Computation under the ${r.actName}`}
    >
      {data.status !== "final" ? (
        <View style={{ borderWidth: PDF.hairline, borderColor: PDF.colour.border, paddingVertical: 4, paddingHorizontal: 6, marginBottom: 10 }}>
          <Text style={{ fontSize: PDF.size.label, color: PDF.colour.dangerText, fontWeight: 600 }}>{statusLine}. For discussion; the figures may change.</Text>
        </View>
      ) : null}

      <PdfSection title="Assessee">
        <PdfFacts
          columns={3}
          facts={[
            { label: "Name", value: data.client.legalName ?? data.client.name },
            { label: "PAN", value: data.client.pan },
            { label: "Status", value: `${e.assesseeType === "huf" ? "Hindu undivided family" : "Individual"}, ${e.resident === false ? "non-resident" : "resident"}` },
            { label: "Age band", value: e.assesseeType === "huf" ? "Not applicable" : AGE_BAND_LABELS[e.ageBand] },
            { label: "Year", value: `FY ${r.financialYear} · ${r.yearLabel}` },
            { label: "Kind of return", value: RETURN_KIND_LABEL[data.inputs.returnKind] },
            { label: "Filing date (for interest)", value: pdfDate(r.dates.filingDate) },
            { label: "Due date of the return", value: pdfDate(r.dates.dueDate) },
            { label: "Address", value: data.client.address },
          ]}
        />
      </PdfSection>

      <PdfSection title="Regimes compared">
        <PdfParagraph>
          Recommended: {REGIME_LABEL[rec]}
          {r.saving > 0 ? `, saving ${amount(r.saving)}` : ""}. {r.comparison.note}
          {data.regimeChosen ? ` Regime chosen by the reviewer: ${REGIME_LABEL[data.regimeChosen]}.` : ""}
        </PdfParagraph>
        <PdfTable
          columns={[
            { key: "label", header: "", flex: 3 },
            { key: "new", header: REGIME_LABEL.new + (rec === "new" ? " (recommended)" : ""), width: 130, align: "right" },
            { key: "old", header: REGIME_LABEL.old + (rec === "old" ? " (recommended)" : ""), width: 130, align: "right" },
          ]}
          rows={[
            { label: "Total income", new: amount(summaries.new.totalIncome), old: amount(summaries.old.totalIncome) },
            { label: "Tax liability", new: amount(summaries.new.liability), old: amount(summaries.old.liability) },
            { label: "Interest", new: amount(summaries.new.interest), old: amount(summaries.old.interest) },
            { label: "Tax and interest", new: amount(summaries.new.taxAndInterest), old: amount(summaries.old.taxAndInterest) },
            { label: "Taxes paid", new: amount(summaries.new.paid), old: amount(summaries.old.paid) },
          ]}
          totals={[{ label: "Balance", values: { new: balance(summaries.new.balance), old: balance(summaries.old.balance) }, emphasis: true }]}
        />
      </PdfSection>

      <PdfSection title="Computation, both regimes">
        <PdfTable
          fontSize={PDF.size.label}
          columns={[
            { key: "label", header: "Particulars", flex: 3 },
            { key: "new", header: REGIME_LABEL.new, width: 150, align: "right" },
            { key: "old", header: REGIME_LABEL.old, width: 150, align: "right" },
          ]}
          rows={rows.flatMap((row) => {
            const out: Array<Record<string, React.ReactElement | string>> = [];
            if (row.group) {
              out.push({ label: <Text style={{ fontWeight: 600, color: PDF.colour.textMuted }}>{row.group}</Text>, new: <View />, old: <View /> });
            }
            out.push({
              label: (
                <View>
                  <Text style={{ fontWeight: row.emphasis ? 700 : 400 }}>{row.label}</Text>
                  {row.section ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>{row.section.pdfLabel}</Text> : null}
                </View>
              ),
              ...Object.fromEntries(
                // Interest workings run long; they are set out in full under "Interest" below.
                REGIMES.map((g) => [g, <Cell key={g} value={row.cells[g]?.amount} note={row.code.startsWith("interest.234") ? undefined : row.cells[g]?.note} detail={row.cells[g]?.detail} bold={row.emphasis} />]),
              ),
            });
            return out;
          })}
        />
      </PdfSection>

      <PdfSection title="Interest">
        {REGIMES.map((g) => {
          const i = r.regimes[g].interest;
          return (
            <View key={g} wrap={false} style={{ marginBottom: 6 }}>
              <Text style={{ fontWeight: 600, marginBottom: 2 }}>{REGIME_LABEL[g]}</Text>
              <Text style={{ fontSize: PDF.size.label }}>
                {labels.s234A}: {amount(i.s234A.interest)}. {i.s234A.reason}
              </Text>
              <Text style={{ fontSize: PDF.size.label }}>
                {labels.s234B}: {amount(i.s234B.interest)}. {i.s234B.reason}
              </Text>
              <Text style={{ fontSize: PDF.size.label }}>
                {labels.s234C}: {amount(i.s234C.interest)}. {i.s234C.reason}
              </Text>
            </View>
          );
        })}
      </PdfSection>

      {r.notes.length || data.ruleSetVerified === false ? (
        <PdfSection title="Notes">
          {r.notes.map((n) => (
            <Text key={n} style={{ fontSize: PDF.size.label, marginBottom: 2 }}>
              • {n}
            </Text>
          ))}
          {data.ruleSetVerified === false ? (
            <Text style={{ fontSize: PDF.size.label, marginBottom: 2 }}>• Some rates or section references for this year are awaiting a Partner&apos;s confirmation on the firm&apos;s Law &amp; rules page.</Text>
          ) : null}
        </PdfSection>
      ) : null}

      <PdfSection title="Record">
        <PdfFacts
          columns={3}
          facts={[
            { label: "Prepared by", value: data.preparedBy },
            { label: "Reviewed", value: data.reviewedBy ? `${data.reviewedBy}${data.reviewedAt ? `, ${pdfDateTime(data.reviewedAt)}` : ""}` : null },
            { label: "Final", value: data.finalisedBy ? `${data.finalisedBy}${data.finalisedAt ? `, ${pdfDateTime(data.finalisedAt)}` : ""}` : null },
          ]}
        />
      </PdfSection>
      <PdfSignature
        firmName={firm.firmName}
        signerName={data.finalisedBy ?? data.reviewedBy ?? data.preparedBy}
        designation={data.status === "final" ? "Finalised by" : data.status === "reviewed" ? "Reviewed by" : "Prepared by"}
      />
    </PdfDocument>
  );
}

export async function buildItrPdf(firm: FirmProfile, data: ItrPdfData): Promise<{ bytes: Buffer; fileName: string }> {
  const logo = await loadFirmLogo(firm).catch(() => null);
  const bytes = await renderPdf(<ItrComputationPdf firm={firm} logo={logo} data={data} />);
  const fileName = pdfFileName(`${data.client.code} ${data.result.yearLabel}`, "ITR-computation");
  return { bytes, fileName };
}

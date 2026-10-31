import "server-only";

import type * as React from "react";
import { Text, View } from "@react-pdf/renderer";
import { formatINR, type Paise } from "@/lib/domain/money";
import { ENTITY_TYPE_LABELS, type EntityType } from "@/lib/domain/enums";
import type { StatementLine, StatementNote, Statements } from "@/lib/domain/schedule3";
import { FS_STATUS_META, comparativeYear, financialStatementsFileName, yearEndedLabel } from "@/lib/schemas/financial-statements";
import type { StatementDetail } from "@/lib/data/financial-statements";
import type { FirmProfile } from "@/server/firm";
import { PdfDocument, PdfFacts, PdfSection, loadFirmLogo, pdfDate, renderPdf } from "@/server/pdf";
import { PDF } from "@/server/pdf/theme";

/**
 * The financial statements on the firm's letterhead (§6.13 "Export to PDF", §7.8.3 step 6, §11):
 * the balance sheet and the statement of profit and loss in Schedule III (Division I) order with
 * last year's figures, then the notes (accounting policies, each line's ledger break-up, the
 * ageing schedules and the MSME disclosure). A statement that isn't Final says so at the top and
 * lists its checks. Amounts in rupees; negatives in brackets, as statements print them.
 */

function amount(p: Paise | null): string {
  if (p === null) return "";
  if (p === 0) return "–";
  return p < 0 ? `(${formatINR(-p)})` : formatINR(p);
}

const COL = { note: 34, value: 92 } as const;

function Row({ label, note, current, previous, weight = 400, indent = 0, rule = false, shade = false, showPrevious }: {
  label: string;
  note?: string | null;
  current: string;
  previous: string;
  weight?: 400 | 600 | 700;
  indent?: number;
  rule?: boolean;
  shade?: boolean;
  showPrevious: boolean;
}) {
  return (
    <View
      wrap={false}
      style={{
        flexDirection: "row",
        borderTopWidth: rule ? 0.8 : 0,
        borderTopColor: PDF.colour.text,
        borderBottomWidth: PDF.hairline,
        borderBottomColor: PDF.colour.border,
        backgroundColor: shade ? PDF.colour.surface2 : undefined,
      }}
    >
      <Text style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingVertical: 3, paddingLeft: 5 + indent * 10, paddingRight: 5, fontWeight: weight }}>{label}</Text>
      <Text style={{ width: COL.note, paddingVertical: 3, paddingHorizontal: 4, textAlign: "center", color: PDF.colour.textMuted }}>{note ?? ""}</Text>
      <Text style={{ width: COL.value, paddingVertical: 3, paddingHorizontal: 5, textAlign: "right", fontWeight: weight }}>{current}</Text>
      {showPrevious ? <Text style={{ width: COL.value, paddingVertical: 3, paddingHorizontal: 5, textAlign: "right", fontWeight: weight, color: PDF.colour.textMuted }}>{previous}</Text> : null}
    </View>
  );
}

function Header({ years, showPrevious }: { years: { current: string; previous: string }; showPrevious: boolean }) {
  return (
    <View style={{ flexDirection: "row", backgroundColor: PDF.colour.surface2, borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.border, borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border }}>
      <Text style={{ flexGrow: 1, flexBasis: 0, padding: 4, fontSize: PDF.size.label, fontWeight: 600, color: PDF.colour.textMuted }}>Particulars</Text>
      <Text style={{ width: COL.note, padding: 4, fontSize: PDF.size.label, fontWeight: 600, color: PDF.colour.textMuted, textAlign: "center" }}>Note</Text>
      <Text style={{ width: COL.value, padding: 4, fontSize: PDF.size.label, fontWeight: 600, color: PDF.colour.textMuted, textAlign: "right" }}>{years.current}</Text>
      {showPrevious ? <Text style={{ width: COL.value, padding: 4, fontSize: PDF.size.label, fontWeight: 600, color: PDF.colour.textMuted, textAlign: "right" }}>{years.previous}</Text> : null}
    </View>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: PDF.size.title, fontWeight: 600, color: PDF.colour.navy, marginBottom: 6 }} minPresenceAhead={60}>
      {children}
    </Text>
  );
}

function StatementTable({ lines, years, showPrevious }: { lines: StatementLine[]; years: { current: string; previous: string }; showPrevious: boolean }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Header years={years} showPrevious={showPrevious} />
      {lines.map((l) => {
        const heading = l.kind === "heading" || l.kind === "group";
        const label = `${l.ref ? `${l.ref}  ` : ""}${l.label}`;
        return (
          <Row
            key={l.key}
            label={label}
            note={l.note ? String(l.note) : null}
            current={heading ? "" : amount(l.current)}
            previous={heading ? "" : amount(l.previous)}
            weight={l.kind === "heading" || l.kind === "total" ? 700 : l.kind === "group" ? 600 : 400}
            indent={l.kind === "group" ? 1 : l.kind === "item" ? 2 : l.kind === "subitem" ? 3 : 0}
            rule={l.kind === "total"}
            shade={l.kind === "total" && l.label === "TOTAL"}
            showPrevious={showPrevious}
          />
        );
      })}
    </View>
  );
}

function NoteBlock({ note, extra, policies, showPrevious }: { note: StatementNote; extra: string | null; policies: string | null; showPrevious: boolean }) {
  return (
    <View style={{ marginBottom: 10 }} wrap>
      <Text style={{ fontSize: PDF.size.emphasis, fontWeight: 600, marginBottom: 4 }} minPresenceAhead={40}>
        {note.number}. {note.title}
      </Text>
      {note.kind === "text" ? (
        <Text style={{ fontSize: PDF.size.body, lineHeight: 1.45 }}>{policies ?? note.text ?? ""}</Text>
      ) : note.table ? (
        <View>
          <View style={{ flexDirection: "row", backgroundColor: PDF.colour.surface2, borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border }}>
            <Text style={{ flexGrow: 1, flexBasis: 0, padding: 3, fontSize: PDF.size.small, fontWeight: 600, color: PDF.colour.textMuted }}>Particulars</Text>
            {note.table.columns.map((c) => (
              <Text key={c} style={{ width: 52, padding: 3, fontSize: PDF.size.small, fontWeight: 600, color: PDF.colour.textMuted, textAlign: "right" }}>
                {c}
              </Text>
            ))}
          </View>
          {note.table.rows.map((row, i) => (
            <View key={`${row.label}-${i}`} wrap={false} style={{ flexDirection: "row", borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border }}>
              <Text style={{ flexGrow: 1, flexBasis: 0, padding: 3, fontSize: PDF.size.small, fontWeight: i === note.table!.rows.length - 1 ? 600 : 400 }}>{row.label}</Text>
              {row.values.map((v, j) => (
                <Text key={j} style={{ width: 52, padding: 3, fontSize: PDF.size.small, textAlign: "right", fontWeight: i === note.table!.rows.length - 1 ? 600 : 400 }}>
                  {amount(v)}
                </Text>
              ))}
            </View>
          ))}
          <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, marginTop: 3 }}>Outstanding for the periods shown from the due date of payment.</Text>
        </View>
      ) : (
        <View>
          {note.lines.map((l, i) => (
            <Row key={`${l.label}-${i}`} label={l.label} current={amount(l.current)} previous={amount(l.previous)} showPrevious={showPrevious} indent={note.kind === "msme" ? 0 : 1} />
          ))}
          {note.total ? <Row label="Total" current={amount(note.total.current)} previous={amount(note.total.previous)} weight={600} rule showPrevious={showPrevious} /> : null}
        </View>
      )}
      {extra ? <Text style={{ fontSize: PDF.size.body, lineHeight: 1.45, marginTop: 4 }}>{extra}</Text> : null}
      {note.kind !== "text" && !note.table && note.lines.length === 0 ? <Text style={{ color: PDF.colour.textMuted }}>Nil</Text> : null}
    </View>
  );
}

export async function buildFinancialStatementsPdf(input: { firm: FirmProfile; detail: StatementDetail; preparedFor: string }): Promise<{ bytes: Buffer; fileName: string }> {
  const { firm, detail } = input;
  const s = detail.statements as Statements;
  const fy = detail.row.financial_year;
  const end = yearEndedLabel(fy);
  const showPrevious = s.totals.previous !== null;
  const years = { current: `FY ${fy}`, previous: `FY ${comparativeYear(fy)}` };
  const status = detail.row.status;
  const logo = await loadFirmLogo(firm).catch(() => null);
  const entity = detail.client.entityType && detail.client.entityType in ENTITY_TYPE_LABELS ? ENTITY_TYPE_LABELS[detail.client.entityType as EntityType] : null;

  const bytes = await renderPdf(
    <PdfDocument
      firm={firm}
      logo={logo}
      title="Financial statements"
      documentTitle={`Financial statements · ${detail.client.name} · FY ${fy}`}
      meta={[
        { label: "Client", value: detail.client.code },
        { label: "Year ended", value: end },
        { label: "Status", value: FS_STATUS_META[status].label },
      ]}
      footerNote={status === "final" ? "Prepared from the trial balance" : `${FS_STATUS_META[status].label}: not final`}
    >
      <PdfFacts
        columns={3}
        facts={[
          { label: "Entity", value: detail.client.name },
          { label: "Constitution", value: entity },
          { label: "GSTIN", value: detail.client.gstin },
          { label: "Prepared by", value: detail.row.prepared_by_name ?? detail.createdByName },
          { label: "Reviewed by", value: detail.row.reviewed_by_name ? `${detail.row.reviewed_by_name}, ${pdfDate(detail.row.reviewed_at)}` : null },
          { label: "Final", value: detail.row.finalised_by_name ? `${detail.row.finalised_by_name}, ${pdfDate(detail.row.finalised_at)}` : null },
        ]}
      />
      {status !== "final" ? (
        <View style={{ borderWidth: PDF.hairline, borderColor: PDF.colour.border, padding: 6, marginBottom: 10 }}>
          <Text style={{ fontSize: PDF.size.body, fontWeight: 600 }}>{FS_STATUS_META[status].label}: these statements are not final.</Text>
          {s.checks.map((c) => (
            <Text key={c.code} style={{ fontSize: PDF.size.label, marginTop: 2, color: c.status === "fail" ? PDF.colour.text : PDF.colour.textMuted }}>
              {c.status === "pass" ? "Passes" : c.status === "fail" ? "Fails" : "Not run"} · {c.title}: {c.message}
            </Text>
          ))}
        </View>
      ) : null}

      <Heading>Balance sheet as at {end}</Heading>
      <StatementTable lines={s.balanceSheet} years={years} showPrevious={showPrevious} />
      <View break>
        <Heading>Statement of profit and loss for the year ended {end}</Heading>
        <StatementTable lines={s.profitAndLoss} years={years} showPrevious={showPrevious} />
      </View>
      <View break>
        <Heading>Notes to the financial statements</Heading>
        <PdfSection>
          {s.notes.map((n) => (
            <NoteBlock key={n.key} note={n} extra={detail.inputs.noteTexts[n.key] ?? null} policies={detail.inputs.policies} showPrevious={showPrevious && n.kind === "ledgers"} />
          ))}
        </PdfSection>
        <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, marginTop: 6 }}>
          Amounts in Indian rupees. Prepared in the format of Schedule III (Division I) to the Companies Act, 2013{showPrevious ? `; previous year's figures are from the FY ${comparativeYear(fy)} statement.` : "."}
        </Text>
      </View>
    </PdfDocument>,
  );
  return { bytes, fileName: financialStatementsFileName(detail.client.code, fy) };
}

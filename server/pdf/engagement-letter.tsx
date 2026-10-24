import "server-only";

import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PdfDocument } from "@/server/pdf/document";
import { PdfSection } from "@/server/pdf/blocks";
import { PdfTable } from "@/server/pdf/table";
import { pdfDate, pdfMoney } from "@/server/pdf/format";
import { loadFirmLogo, type PdfLogo } from "@/server/pdf/logo";
import { renderPdf } from "@/server/pdf/render";
import { PDF } from "@/server/pdf/theme";
import { formatDate } from "@/lib/format";
import { stateName } from "@/lib/domain/india-validators";
import { istDateOf, todayIST } from "@/lib/domain/fy";
import { multiplyPaise, toPaise } from "@/lib/domain/money";
import type { LetterDocument } from "@/lib/data/engagement-letters";
import {
  LETTER_AUDIT_TYPES,
  OCCURRENCES_PER_YEAR,
  addresseeHeading,
  closingParagraphs,
  confidentialityTerms,
  feeParagraph,
  frequencyLabel,
  isAuditLetter,
  letterFileName,
  letterReference,
  letterSubject,
  nonAuditOpening,
  nonAuditTerms,
  sa210Sections,
  scheduleAnnualPaise,
  type LetterAuditType,
  type LetterSection,
} from "@/lib/schemas/engagement-letters";

/**
 * The engagement letter PDF (§7.15.3, §11 "Engagement letter (audit / non-audit templates)"), on the
 * TaxWise letterhead:
 *   - the reference, date and FY; the addressee by the client's constitution; the subject;
 *   - for an audit, the SA 210 contents (objective and scope, the auditor's and management's
 *     responsibilities, the applicable financial reporting framework, the expected form and content
 *     of the report);
 *   - for other work, the opening, scope and exclusions, the services schedule with fees (excl. GST)
 *     and each side's responsibilities;
 *   - the fee terms (fixed, never contingent, CA Act First Schedule Part I Clause 10), confidentiality
 *     and personal data, how long the letter runs;
 *   - signature blocks for the firm (the signing Partner, membership no., FRN) and for the client.
 * A draft prints "Draft" in the letterhead and a line saying it isn't issued. Rendered on demand
 * (app/api/pdf/engagement-letter/[id]) and attached to the email for signature.
 */

function Section({ section }: { section: LetterSection }) {
  return (
    <PdfSection title={section.title}>
      {section.paragraphs.map((p, i) => (
        <Text key={i} style={{ fontSize: PDF.size.body, lineHeight: 1.45, marginBottom: 4 }}>
          {p}
        </Text>
      ))}
    </PdfSection>
  );
}

function SignatureBlock({ heading, lines, note }: { heading: string; lines: string[]; note?: string }) {
  return (
    <View style={{ width: "46%" }}>
      <Text style={{ fontSize: PDF.size.body, fontWeight: 600 }}>{heading}</Text>
      {note ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, marginTop: 1 }}>{note}</Text> : null}
      <View style={{ height: 38 }} />
      <View style={{ borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.text, paddingTop: 3 }}>
        {lines.map((l, i) => (
          <Text key={i} style={{ fontSize: i === 0 ? PDF.size.body : PDF.size.label, color: i === 0 ? PDF.colour.text : PDF.colour.textMuted, marginTop: i === 0 ? 0 : 1 }}>
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}

export function EngagementLetterPdf({ firm, logo, doc, printedOn }: { firm: FirmProfile; logo?: PdfLogo | null; doc: LetterDocument; printedOn: string }) {
  const l = doc.letter;
  const c = doc.client;
  const draft = l.status === "draft";
  const audit = isAuditLetter(l.service_types);
  const auditType = (LETTER_AUDIT_TYPES as readonly string[]).includes(l.audit_type ?? "") ? (l.audit_type as LetterAuditType) : null;
  const clientName = c.legalName?.trim() || c.name;
  const date = l.issued_at ? istDateOf(l.issued_at) : printedOn;
  const firmName = firm.legalName ?? firm.firmName;
  const schedule = l.services_schedule;
  const annual = scheduleAnnualPaise(schedule);
  const feeText = l.fee_agreed !== null && l.fee_agreed !== undefined ? pdfMoney(toPaise(l.fee_agreed)) : null;
  const addressLines = [c.address, [c.city, c.pincode].filter(Boolean).join(" "), c.stateCode ? stateName(c.stateCode) : null].filter((v): v is string => Boolean(v && v.trim()));
  const heading = addresseeHeading(c.entityType);
  const greeting = doc.primaryContact?.name ? `Dear ${doc.primaryContact.name},` : "Dear Sir or Madam,";

  const meta = [
    { label: "Ref.", value: letterReference(l.financial_year, c.code) },
    { label: "Date", value: pdfDate(date) },
    { label: "FY", value: l.financial_year },
  ];

  const sections: LetterSection[] = [];
  if (audit) {
    sections.push(
      ...sa210Sections({
        auditType,
        fy: l.financial_year,
        clientName,
        framework: l.reporting_framework ?? "",
        reportForm: l.report_form ?? "",
        scope: l.scope,
        exclusions: l.exclusions,
      }),
    );
  } else {
    const scope: string[] = [];
    if (l.scope?.trim()) scope.push(l.scope.trim());
    if (l.exclusions?.trim()) scope.push(`The engagement does not cover: ${l.exclusions.trim()}`);
    if (scope.length) sections.push({ title: "Scope of our work", paragraphs: scope });
  }

  return (
    <PdfDocument
      firm={firm}
      logo={logo}
      title={draft ? "ENGAGEMENT LETTER · DRAFT" : "ENGAGEMENT LETTER"}
      documentTitle={`Engagement letter FY ${l.financial_year} · ${c.name}`}
      meta={meta}
      footerNote={draft ? "Draft engagement letter, not issued" : "Engagement letter"}
    >
      {draft ? (
        <View style={{ borderWidth: PDF.hairline, borderColor: PDF.colour.border, paddingVertical: 4, paddingHorizontal: 6, marginBottom: 10 }}>
          <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>Draft for review. This letter has not been issued to the client.</Text>
        </View>
      ) : null}

      <View style={{ marginBottom: 10 }}>
        <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginBottom: 2 }}>To</Text>
        {heading ? <Text style={{ fontSize: PDF.size.body }}>{heading}</Text> : null}
        <Text style={{ fontSize: PDF.size.emphasis, fontWeight: 600 }}>{clientName}</Text>
        {addressLines.map((a, i) => (
          <Text key={i} style={{ fontSize: PDF.size.body }}>
            {a}
          </Text>
        ))}
        {c.pan ? <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 2 }}>PAN {c.pan}{c.gstin ? ` · GSTIN ${c.gstin}` : ""}</Text> : null}
      </View>

      <Text style={{ fontSize: PDF.size.body, marginBottom: 6 }}>{greeting}</Text>
      <Text style={{ fontSize: PDF.size.emphasis, fontWeight: 600, marginBottom: 8 }}>
        {letterSubject({ fy: l.financial_year, clientName, auditType, audit, serviceCount: l.service_types.length })}
      </Text>

      {audit ? null : (
        <Text style={{ fontSize: PDF.size.body, lineHeight: 1.45, marginBottom: 8 }}>{nonAuditOpening(clientName, l.financial_year)}</Text>
      )}

      {sections.map((s) => (
        <Section key={s.title} section={s} />
      ))}

      {schedule.length ? (
        <PdfSection title={audit ? "Other services in this engagement" : "Services and fees"}>
          <PdfTable
            columns={[
              { key: "n", header: "#", width: 18 },
              { key: "service", header: "Service", flex: 5 },
              { key: "frequency", header: "Frequency", width: 70 },
              { key: "fee", header: "Fee (excl. GST)", width: 86, align: "right" },
              { key: "annual", header: "For the year", width: 86, align: "right" },
            ]}
            rows={schedule.map((r, i) => {
              const fee = r.fee ? toPaise(r.fee) : null;
              return {
                n: String(i + 1),
                service: r.description,
                frequency: frequencyLabel(r.frequency),
                fee: fee === null ? "As agreed" : `${pdfMoney(fee)}${r.frequency === "monthly" ? " a month" : r.frequency === "quarterly" ? " a quarter" : ""}`,
                annual: fee === null ? null : pdfMoney(multiplyPaise(fee, OCCURRENCES_PER_YEAR[r.frequency])),
              };
            })}
            totals={annual > 0 ? [{ label: "Fees for the year, excluding GST", values: { annual: pdfMoney(annual) }, emphasis: true }] : undefined}
          />
        </PdfSection>
      ) : null}

      {audit ? null : nonAuditTerms(clientName).map((s) => <Section key={s.title} section={s} />)}

      <Section section={{ title: "Fees", paragraphs: feeParagraph(feeText) }} />
      <Section section={confidentialityTerms()} />
      <Section section={{ title: "Period and acceptance", paragraphs: closingParagraphs({ expiresAt: l.expires_at, renewedFromFy: l.renewed_from_fy, formatDate }) }} />

      <Text style={{ fontSize: PDF.size.body, marginTop: 4, marginBottom: 2 }}>Yours faithfully,</Text>

      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
        <SignatureBlock
          heading={`For ${firmName}`}
          note={`Chartered Accountants${doc.frn ? ` · FRN ${doc.frn}` : ""}`}
          lines={[
            doc.signatory?.name ? `CA ${doc.signatory.name.replace(/^CA\s+/i, "")}` : "Partner",
            doc.signatory?.membershipNo ? `Partner · Membership No. ${doc.signatory.membershipNo}` : "Partner",
            `Place: ${firm.city ?? "Bengaluru"} · Date: ${pdfDate(date)}`,
          ]}
        />
        <SignatureBlock
          heading={`Accepted on behalf of ${clientName}`}
          note="By an authorised signatory"
          lines={["Signature", "Name and designation", "Date"]}
        />
      </View>

    </PdfDocument>
  );
}

/** Renders the letter to PDF bytes with the firm's logo. Throws on a rendering error (the caller answers with a Ref). */
export async function buildEngagementLetterPdf(input: { firm: FirmProfile; doc: LetterDocument; today?: string }): Promise<{ bytes: Buffer; fileName: string }> {
  const logo = await loadFirmLogo(input.firm).catch(() => null);
  const printedOn = input.today ?? todayIST();
  const bytes = await renderPdf(<EngagementLetterPdf firm={input.firm} logo={logo} doc={input.doc} printedOn={printedOn} />);
  return { bytes, fileName: letterFileName(input.doc.letter.financial_year, input.doc.client.code, input.doc.letter.status === "draft") };
}

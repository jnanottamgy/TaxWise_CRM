import "server-only";

import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PDF, PdfFooter, pdfDate, pdfFileName, pdfMoneyFromRupees, pdfStyles, renderPdf } from "@/server/pdf";
import { formatFirmAddress } from "@/server/firm";
import { AUDIT_TYPE_LABELS, representationLetter } from "@/lib/domain/audit-stages";
import type { RepresentationLetterData } from "@/lib/data/audits";

/**
 * The management representation letter template (SA 580; §6.9 Completion "written representations
 * (SA 580), with a management representation letter template"; §11). Written representations come
 * from management, addressed to the auditor and on the entity's own letterhead, so the template
 * carries the entity's name and address at the top (not the firm's letterhead) and a band saying
 * who prepared it and how to use it. The firm's footer and "Powered by J-TACS" run on every page.
 *
 * The paragraphs come from lib/domain/audit-stages.ts `representationLetter`: SA 580's required
 * representations, those SA 240, 250, 450, 501, 540, 550, 560 and 570 add, and the ones the type of
 * engagement adds. Financial-statement audits get the schedule of uncorrected misstatements, with
 * the clearly-trivial threshold from the engagement's materiality (SA 320, SA 450).
 */

const blankLine = { borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.text, height: 14 } as const;

function SignatureBlock({ entityName, designation }: { entityName: string; designation: string }) {
  return (
    <View wrap={false} style={{ width: "46%", marginTop: 18 }}>
      <Text style={{ fontSize: PDF.size.body }}>{`For ${entityName}`}</Text>
      <View style={{ ...blankLine, marginTop: 28 }} />
      <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 3 }}>Signature</Text>
      <View style={{ ...blankLine, marginTop: 10 }} />
      <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 3 }}>Name</Text>
      <Text style={{ fontSize: PDF.size.body, marginTop: 6, fontWeight: 600 }}>{designation}</Text>
    </View>
  );
}

export function ManagementRepresentationPdf({ firm, data, preparedBy }: { firm: FirmProfile; data: RepresentationLetterData; preparedBy: string }) {
  const letter = representationLetter({
    auditType: data.auditType,
    entityName: data.client.name,
    entityType: data.client.entityType,
    financialYear: data.financialYear,
    engagementLetterDate: data.engagementLetterDate,
    reportDate: data.reportDate,
    caroApplicable: data.caroApplicable,
    framework: data.framework,
    formatDate: (d) => pdfDate(d),
  });
  const firmName = firm.legalName ?? firm.firmName;
  const firmAddress = formatFirmAddress(firm);
  const ids = [data.client.cin ? `CIN/LLPIN ${data.client.cin}` : null, data.client.pan ? `PAN ${data.client.pan}` : null].filter(Boolean).join("  ·  ");
  // Paragraphs are numbered straight through the letter.
  const numbered = letter.sections.map((section, si) => {
    const before = letter.sections.slice(0, si).reduce((sum, x) => sum + x.items.length, 0);
    return { title: section.title, items: section.items.map((text, i) => ({ n: before + i + 1, text })) };
  });

  return (
    <Document
      title={`Management representation letter · ${data.client.name} · FY ${data.financialYear}`}
      author={firm.firmName}
      creator={firm.firmName}
      producer="J-TACS"
      subject="Management representation letter (SA 580)"
      language="en-IN"
    >
      <Page size={PDF.page.size} style={pdfStyles.page} wrap>
        <View style={{ backgroundColor: PDF.colour.surface2, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 8, marginBottom: 14 }}>
          <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>
            {`Template prepared by ${firmName} for ${data.client.name} (${data.client.code}): ${AUDIT_TYPE_LABELS[data.auditType]}, FY ${data.financialYear}. Print it on the entity's own letterhead, check each statement is true, sign and date it. ${letter.dateNote}`}
          </Text>
        </View>

        <View style={{ marginBottom: 14 }}>
          <Text style={{ fontSize: PDF.size.firm, fontWeight: 600, color: PDF.colour.text }}>{data.client.name}</Text>
          {data.client.address ? <Text style={{ fontSize: PDF.size.label, marginTop: 3 }}>{data.client.address}</Text> : null}
          {ids ? <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 1 }}>{ids}</Text> : null}
        </View>

        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
          <View style={{ maxWidth: "60%" }}>
            <Text style={{ fontSize: PDF.size.body }}>To</Text>
            <Text style={{ fontSize: PDF.size.body, fontWeight: 600 }}>{firmName}</Text>
            <Text style={{ fontSize: PDF.size.body }}>Chartered Accountants{data.firmFrn ? ` (FRN ${data.firmFrn})` : ""}</Text>
            {firmAddress ? <Text style={{ fontSize: PDF.size.body }}>{firmAddress}</Text> : null}
          </View>
          <View style={{ width: "32%" }}>
            <Text style={{ fontSize: PDF.size.body }}>Date</Text>
            <View style={{ ...blankLine, marginTop: 4 }} />
          </View>
        </View>

        <Text style={{ fontSize: PDF.size.body, marginBottom: 8 }}>Dear Sirs,</Text>
        <Text style={{ fontSize: PDF.size.emphasis, fontWeight: 600, marginBottom: 8 }}>{`Subject: ${letter.subject}`}</Text>
        <Text style={pdfStyles.paragraph}>{letter.opening}</Text>
        <Text style={pdfStyles.paragraph}>{letter.lead}</Text>

        {numbered.map((section) => (
          <View key={section.title} style={{ marginTop: 4, marginBottom: 4 }}>
            <Text style={{ fontSize: PDF.size.body, fontWeight: 600, marginBottom: 3 }}>{section.title}</Text>
            {section.items.map((item) => (
              <View key={item.n} wrap={false} style={{ flexDirection: "row", marginBottom: 4 }}>
                <Text style={{ width: 18, fontSize: PDF.size.body }}>{`${item.n}.`}</Text>
                <Text style={{ flex: 1, fontSize: PDF.size.body }}>{item.text}</Text>
              </View>
            ))}
          </View>
        ))}

        <Text style={{ ...pdfStyles.paragraph, marginTop: 6 }}>
          Information is material if omitting or misstating it could, individually or in aggregate, influence the economic decisions users take on the basis of the financial statements.
        </Text>
        <Text style={{ fontSize: PDF.size.body, marginTop: 4 }}>Yours faithfully,</Text>

        <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap" }}>
          {letter.signatories.map((d, i) => (
            <SignatureBlock key={`${d}-${i}`} entityName={data.client.name} designation={d} />
          ))}
        </View>

        {letter.misstatementSchedule ? (
          <View break style={{ marginTop: 0 }}>
            <Text style={{ fontSize: PDF.size.title, fontWeight: 600, marginBottom: 4 }}>Schedule: uncorrected misstatements (SA 450)</Text>
            <Text style={{ ...pdfStyles.paragraph, color: PDF.colour.textMuted }}>
              {data.trivialRupees !== null
                ? `Misstatements below ${pdfMoneyFromRupees(data.trivialRupees)}, the clearly-trivial threshold set for this audit (SA 320), are not listed. Amounts in rupees; a positive figure increases the item.`
                : "List every misstatement above the clearly-trivial threshold set for this audit (SA 320). Amounts in rupees; a positive figure increases the item."}
            </Text>
            <View style={{ flexDirection: "row", borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border, paddingVertical: 4, marginTop: 4 }}>
              {["Particulars", "Profit before tax", "Assets", "Liabilities", "Equity"].map((h, i) => (
                <Text key={h} style={{ width: i === 0 ? "36%" : "16%", fontSize: PDF.size.label, color: PDF.colour.textMuted, textAlign: i === 0 ? "left" : "right" }}>
                  {h}
                </Text>
              ))}
            </View>
            {Array.from({ length: 8 }, (_, i) => (
              <View key={i} style={{ flexDirection: "row", borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border, height: 22 }} />
            ))}
            <View style={{ flexDirection: "row", paddingVertical: 4 }}>
              <Text style={{ width: "36%", fontSize: PDF.size.body, fontWeight: 600 }}>Total</Text>
            </View>
            <Text style={{ ...pdfStyles.paragraph, marginTop: 10 }}>
              {`We consider the effects of these uncorrected misstatements immaterial, individually and in aggregate, to the financial statements as a whole. ${data.partnerName ? `Prepared for ${data.partnerName}, engagement partner.` : ""}`.trim()}
            </Text>
          </View>
        ) : null}

        <PdfFooter firmName={firm.firmName} note={`SA 580 template · prepared by ${preparedBy}`} />
      </Page>
    </Document>
  );
}

export async function buildManagementRepresentationPdf(input: { firm: FirmProfile; data: RepresentationLetterData; preparedBy: string }): Promise<{ bytes: Buffer; fileName: string }> {
  const bytes = await renderPdf(<ManagementRepresentationPdf firm={input.firm} data={input.data} preparedBy={input.preparedBy} />);
  return { bytes, fileName: pdfFileName(`${input.data.client.code} FY ${input.data.financialYear}`, "Management-representation") };
}

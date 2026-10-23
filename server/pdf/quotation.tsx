import "server-only";

import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PdfDocument } from "@/server/pdf/document";
import { PdfAmountInWords, PdfFacts, PdfKeyValue, PdfNotes, PdfSection } from "@/server/pdf/blocks";
import { PdfTable } from "@/server/pdf/table";
import { pdfDate, pdfDateTime, pdfMoney } from "@/server/pdf/format";
import type { PdfLogo } from "@/server/pdf/logo";
import { PDF } from "@/server/pdf/theme";
import { formatNumber } from "@/lib/format";
import { toPaise } from "@/lib/domain/money";
import { lineMeta, placeOfSupplyLabel, quotationTotals, recipientHeading, totalRows, type QuotationDocument } from "@/lib/schemas/quotations";

/**
 * The quotation PDF, laid out as §7.5.3 asks: the letterhead (logo, firm name, address, GSTIN,
 * contact) · "QUOTATION" with its number, issue date, valid-until and prepared-by · Prepared for ·
 * the line table · totals with the CGST/SGST or IGST split · the total in words · notes · terms ·
 * the acceptance block (a signature line, or "Accepted electronically by <name> on <date>") · the
 * footer "TaxWise Consultants · Powered by J-TACS". The same document is rendered for staff
 * (app/api/pdf/quotation/[id]) and for the client's link (app/api/q/[token]/pdf), and attached to
 * the quotation email.
 *
 *   const bytes = await renderPdf(<QuotationPdf firm={firm} logo={logo} doc={doc} />);
 */
export function QuotationPdf({ firm, logo, doc }: { firm: FirmProfile; logo?: PdfLogo | null; doc: QuotationDocument }) {
  const totals = quotationTotals(
    doc.lines.map((l) => ({ quantity: l.quantity, unit_price: l.unitPrice, tax_rate: l.taxRate })),
    doc.recipient.placeOfSupplyCode,
    firm.stateCode,
  );
  const who = recipientHeading(doc.recipient);
  const meta = [
    { label: "Quotation no.", value: doc.number },
    { label: "Issue date", value: pdfDate(doc.issueDate) },
    { label: "Valid until", value: pdfDate(doc.validUntil) },
    ...(doc.preparedBy ? [{ label: "Prepared by", value: doc.preparedBy }] : []),
    ...(doc.revisionNumber > 0 ? [{ label: "Revision", value: doc.revisesNumber ? `${doc.revisionNumber}, replaces ${doc.revisesNumber}` : String(doc.revisionNumber) }] : []),
  ];

  return (
    <PdfDocument firm={firm} logo={logo} title="QUOTATION" documentTitle={`Quotation ${doc.number}`} meta={meta}>
      <PdfSection title="Prepared for">
        <Text style={{ fontSize: PDF.size.emphasis, fontWeight: 600 }}>{who.primary}</Text>
        {who.secondary ? <Text style={{ fontSize: PDF.size.body, marginTop: 1 }}>{who.secondary}</Text> : null}
        <View style={{ marginTop: 6 }}>
          <PdfFacts
            columns={3}
            facts={[
              { label: "Email", value: doc.recipient.email },
              { label: "Phone", value: doc.recipient.phone },
              { label: "GSTIN", value: doc.recipient.gstin },
              { label: "Place of supply", value: placeOfSupplyLabel(doc.recipient.placeOfSupplyCode) },
            ]}
          />
        </View>
      </PdfSection>

      <PdfTable
        columns={[
          { key: "n", header: "#", width: 18 },
          { key: "description", header: "Description", flex: 5 },
          { key: "qty", header: "Qty", width: 40, align: "right" },
          { key: "price", header: "Unit price", width: 74, align: "right" },
          { key: "rate", header: "GST", width: 34, align: "right" },
          { key: "amount", header: "Amount", width: 80, align: "right" },
        ]}
        rows={doc.lines.map((l, i) => {
          const meta = lineMeta(l.serviceType, l.frequency);
          return {
            n: String(i + 1),
            description: (
              <View>
                <Text style={{ fontSize: PDF.size.body }}>{l.description}</Text>
                {meta ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, marginTop: 1 }}>{meta}</Text> : null}
              </View>
            ),
            qty: formatNumber(l.quantity, { maxDecimals: 2 }),
            price: pdfMoney(toPaise(l.unitPrice)),
            rate: `${formatNumber(l.taxRate, { maxDecimals: 2 })}%`,
            amount: pdfMoney(totals.lines[i]?.amountPaise ?? 0),
          };
        })}
      />

      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <View style={{ width: "52%", paddingRight: 16 }}>
          <PdfAmountInWords words={totals.words} />
          <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>
            {totals.intraState
              ? `Supply within ${placeOfSupplyLabel(doc.recipient.placeOfSupplyCode)}: CGST and SGST apply.`
              : `Supply to ${placeOfSupplyLabel(doc.recipient.placeOfSupplyCode)}: IGST applies.`}
          </Text>
        </View>
        <PdfKeyValue width="44%" rows={totalRows(totals).map((r) => ({ label: r.label, value: pdfMoney(r.paise), emphasis: r.emphasis }))} />
      </View>

      <PdfNotes title="Notes" text={doc.notes} />
      <PdfNotes title="Terms" text={doc.terms} />

      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 14, borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.border, paddingTop: 10 }}>
        <View style={{ width: "52%", paddingRight: 16 }}>
          <Text style={{ fontSize: PDF.size.label, fontWeight: 600, color: PDF.colour.textMuted, marginBottom: 4 }}>Acceptance</Text>
          {doc.acceptance ? (
            <Text style={{ fontSize: PDF.size.body }}>
              Accepted electronically by <Text style={{ fontWeight: 600 }}>{doc.acceptance.name}</Text>
              {doc.acceptance.at ? ` on ${pdfDateTime(doc.acceptance.at)}` : ""}.
            </Text>
          ) : (
            <View>
              <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginBottom: 22 }}>
                We accept this quotation on the terms above. (Or accept it online from the link in our email.)
              </Text>
              <View style={{ flexDirection: "row" }}>
                <View style={{ flexGrow: 1, marginRight: 12, borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.text, paddingTop: 2 }}>
                  <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>Signature, name and designation</Text>
                </View>
                <View style={{ width: 80, borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.text, paddingTop: 2 }}>
                  <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>Date</Text>
                </View>
              </View>
            </View>
          )}
        </View>
        <View style={{ width: "40%", alignItems: "flex-end" }}>
          <Text style={{ fontSize: PDF.size.body, fontWeight: 600 }}>For {firm.legalName ?? firm.firmName}</Text>
          <View style={{ height: 26 }} />
          <View style={{ borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.text, paddingTop: 3, alignItems: "flex-end", minWidth: 150 }}>
            {doc.preparedBy ? <Text style={{ fontSize: PDF.size.body }}>{doc.preparedBy}</Text> : null}
            <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>Authorised Signatory</Text>
          </View>
        </View>
      </View>
    </PdfDocument>
  );
}

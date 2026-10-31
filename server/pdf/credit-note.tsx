import "server-only";

import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import {
  PDF,
  PdfAmountInWords,
  PdfDocument,
  PdfFacts,
  PdfKeyValue,
  PdfNotes,
  PdfParagraph,
  PdfSignature,
  PdfTable,
  loadFirmLogo,
  pdfAmountInWords,
  pdfDate,
  pdfFileName,
  pdfMoney,
  pdfPercent,
  renderPdf,
  type PdfLogo,
} from "@/server/pdf";
import { CREDIT_NOTE_REASON_LABELS, isEnumValue } from "@/lib/domain/enums";
import { stateName } from "@/lib/domain/india-validators";
import { toPaise } from "@/lib/domain/money";
import type { CreditNoteDocument } from "@/lib/data/credit-notes";

/**
 * The credit note PDF (§7.9.7, §11): its own number and date, the invoice it adjusts (number and
 * date), the recipient (name, address, GSTIN), the place of supply, the reason, the taxable amount
 * credited with the GST at the invoice's rate split the invoice's way, the total in figures and in
 * words, and the signature block. A commercial credit (after the s.34 deadline) says plainly that
 * it does not reduce the GST charged.
 */

function stateLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const name = stateName(code);
  return name ? `${name} (${code})` : code;
}

export function CreditNotePdf({ firm, logo, doc, signerName }: { firm: FirmProfile; logo: PdfLogo | null; doc: CreditNoteDocument; signerName: string | null }) {
  const commercial = !doc.reduces_gst;
  const intra = toPaise(doc.igst_amount) === 0;
  const reasonLabel = doc.reason_code && isEnumValue("credit_note_reason", doc.reason_code) ? CREDIT_NOTE_REASON_LABELS[doc.reason_code] : null;
  const rate = doc.tax_rate === null ? null : Number(doc.tax_rate);
  const firmForLetterhead: FirmProfile = { ...firm, gstin: doc.invoice.firm_gstin ?? firm.gstin };

  const columns = commercial
    ? [
        { key: "description", header: "Description", flex: 1 },
        { key: "amount", header: "Amount credited", width: 90, align: "right" as const },
      ]
    : [
        { key: "description", header: "Description", flex: 1 },
        { key: "taxable", header: "Taxable value", width: 72, align: "right" as const },
        ...(intra
          ? [
              { key: "cgst", header: `CGST ${rate === null ? "" : pdfPercent(rate / 2)}`.trim(), width: 66, align: "right" as const },
              { key: "sgst", header: `SGST ${rate === null ? "" : pdfPercent(rate / 2)}`.trim(), width: 66, align: "right" as const },
            ]
          : [{ key: "igst", header: `IGST ${rate === null ? "" : pdfPercent(rate)}`.trim(), width: 72, align: "right" as const }]),
      ];
  const description = reasonLabel ? `${reasonLabel}: ${doc.reason}` : doc.reason;
  const row = commercial
    ? { description, amount: pdfMoney(toPaise(doc.total_amount)) }
    : {
        description,
        taxable: pdfMoney(toPaise(doc.taxable_amount)),
        ...(intra ? { cgst: pdfMoney(toPaise(doc.cgst_amount)), sgst: pdfMoney(toPaise(doc.sgst_amount)) } : { igst: pdfMoney(toPaise(doc.igst_amount)) }),
      };
  const summary: Array<{ label: string; value: string; emphasis?: boolean }> = commercial
    ? [{ label: "Total credited", value: pdfMoney(toPaise(doc.total_amount)), emphasis: true }]
    : [
        { label: "Taxable value", value: pdfMoney(toPaise(doc.taxable_amount)) },
        ...(intra
          ? [
              { label: "CGST", value: pdfMoney(toPaise(doc.cgst_amount)) },
              { label: "SGST", value: pdfMoney(toPaise(doc.sgst_amount)) },
            ]
          : [{ label: "IGST", value: pdfMoney(toPaise(doc.igst_amount)) }]),
        { label: "Total credited", value: pdfMoney(toPaise(doc.total_amount)), emphasis: true },
      ];

  return (
    <PdfDocument
      firm={firmForLetterhead}
      logo={logo}
      title={commercial ? "Credit note (commercial)" : "Credit note"}
      documentTitle={`Credit note ${doc.credit_note_number}`}
      meta={[
        { label: "Credit note no.", value: doc.credit_note_number },
        { label: "Date", value: pdfDate(doc.issue_date) },
      ]}
      footerNote="Computer-generated credit note"
    >
      {commercial ? (
        <View style={{ backgroundColor: PDF.colour.surface2, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8, marginBottom: 10 }}>
          <Text style={{ fontSize: PDF.size.body, color: PDF.colour.text }}>
            A commercial credit: it reduces the amount you owe on the invoice but does not reduce the GST charged on it.
          </Text>
        </View>
      ) : null}
      <PdfFacts
        columns={2}
        facts={[
          { label: "Issued to", value: doc.invoice.client_name },
          { label: "GSTIN", value: doc.invoice.client_gstin ?? "Unregistered" },
          { label: "Address", value: doc.invoice.client_address },
          { label: "Against invoice", value: `${doc.invoice.invoice_number ?? "—"} dated ${pdfDate(doc.invoice.issue_date)}` },
          { label: "Place of supply", value: stateLabel(doc.place_of_supply_code) },
          { label: "Tax payable on reverse charge", value: "No" },
        ]}
      />
      <PdfTable columns={columns} rows={[row]} fontSize={8} />
      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <View style={{ width: "52%", paddingRight: 12 }}>
          <PdfAmountInWords words={pdfAmountInWords(toPaise(doc.total_amount))} />
        </View>
        <PdfKeyValue rows={summary} width="44%" />
      </View>
      <PdfParagraph muted>{`This credit note reduces the amount due on invoice ${doc.invoice.invoice_number ?? ""}.`}</PdfParagraph>
      <PdfNotes title="Notes" text={doc.notes} />
      <PdfSignature firmName={firm.legalName ?? firm.firmName} signerName={signerName} />
    </PdfDocument>
  );
}

export async function buildCreditNotePdf(input: { firm: FirmProfile; doc: CreditNoteDocument; signerName: string | null }): Promise<{ bytes: Buffer; fileName: string }> {
  const logo = await loadFirmLogo(input.firm).catch(() => null);
  const bytes = await renderPdf(<CreditNotePdf firm={input.firm} logo={logo} doc={input.doc} signerName={input.signerName} />);
  return { bytes, fileName: pdfFileName(input.doc.credit_note_number, "Credit note") };
}

import "server-only";

import { Text, View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import {
  PDF,
  PdfAmountInWords,
  PdfDocument,
  PdfFacts,
  PdfKeyValue,
  PdfParagraph,
  PdfSignature,
  loadFirmLogo,
  pdfAmountInWords,
  pdfDate,
  pdfFileName,
  pdfMoney,
  renderPdf,
  type PdfLogo,
} from "@/server/pdf";
import { PAYMENT_METHOD_LABELS, isEnumValue } from "@/lib/domain/enums";
import { toPaise } from "@/lib/domain/money";
import { istDateOf } from "@/lib/domain/fy";
import type { ReceiptDocument } from "@/lib/data/receipts";

/**
 * The payment receipt PDF (§7.9.4, §11): the receipt number and date, who paid, the invoice it
 * settles, the amount received and the TDS the client deducted (with its section), how it was paid,
 * what is still due on the invoice, the amount received in words, and the signature block. A
 * reversed receipt says so at the top (receipts are reversed, never deleted).
 */

export function ReceiptPdf({ firm, logo, doc, signerName }: { firm: FirmProfile; logo: PdfLogo | null; doc: ReceiptDocument; signerName: string | null }) {
  const received = toPaise(doc.amount_received);
  const tds = toPaise(doc.tds_amount);
  const method = isEnumValue("payment_method", doc.method) ? PAYMENT_METHOD_LABELS[doc.method] : doc.method;
  const rows: Array<{ label: string; value: string; emphasis?: boolean }> = [{ label: "Amount received", value: pdfMoney(received), emphasis: true }];
  if (tds > 0) rows.push({ label: doc.tds_section ? `TDS deducted (${doc.tds_section === "393" ? "s.393" : doc.tds_section})` : "TDS deducted", value: pdfMoney(tds) });
  if (tds > 0) rows.push({ label: "Settled on the invoice", value: pdfMoney(received + tds) });
  const balance = Math.max(0, toPaise(doc.invoice.outstanding_amount));

  return (
    <PdfDocument
      firm={firm}
      logo={logo}
      title="Payment receipt"
      documentTitle={`Receipt ${doc.receipt_number}`}
      meta={[
        { label: "Receipt no.", value: doc.receipt_number },
        { label: "Date", value: pdfDate(istDateOf(doc.created_at)) },
      ]}
      footerNote="Computer-generated receipt"
    >
      {doc.reversed_at ? (
        <View style={{ backgroundColor: PDF.colour.dangerSoft, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8, marginBottom: 10 }}>
          <Text style={{ fontSize: PDF.size.body, color: PDF.colour.dangerText, fontWeight: 600 }}>
            {`Reversed on ${pdfDate(istDateOf(doc.reversed_at))}${doc.reversal_reason ? `: ${doc.reversal_reason}` : ""}. This receipt no longer settles the invoice.`}
          </Text>
        </View>
      ) : null}
      <PdfFacts
        columns={2}
        facts={[
          { label: "Received from", value: doc.invoice.client_name },
          { label: "GSTIN", value: doc.invoice.client_gstin ?? "Unregistered" },
          { label: "Address", value: doc.invoice.client_address },
          { label: "Against invoice", value: `${doc.invoice.invoice_number ?? "—"} dated ${pdfDate(doc.invoice.issue_date)}` },
          { label: "Payment date", value: pdfDate(doc.payment_date) },
          { label: "Paid by", value: doc.reference ? `${method} · ${doc.reference}` : method },
        ]}
      />
      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4, marginBottom: 6 }}>
        <View style={{ width: "52%", paddingRight: 12 }}>
          <PdfAmountInWords words={`Received with thanks: ${pdfAmountInWords(received)}`} />
        </View>
        <PdfKeyValue rows={rows} width="44%" />
      </View>
      <PdfParagraph muted>
        {balance > 0
          ? `Still due on invoice ${doc.invoice.invoice_number ?? ""}: ${pdfMoney(balance)} (as at the date of this copy).`
          : `Invoice ${doc.invoice.invoice_number ?? ""} is settled in full.`}
      </PdfParagraph>
      {tds > 0 ? <PdfParagraph muted>Please send us the TDS certificate for the TDS deducted once it is issued, so we can match the credit.</PdfParagraph> : null}
      <PdfSignature firmName={firm.legalName ?? firm.firmName} signerName={signerName} />
    </PdfDocument>
  );
}

export async function buildReceiptPdf(input: { firm: FirmProfile; doc: ReceiptDocument; signerName: string | null }): Promise<{ bytes: Buffer; fileName: string }> {
  const logo = await loadFirmLogo(input.firm).catch(() => null);
  const bytes = await renderPdf(<ReceiptPdf firm={input.firm} logo={logo} doc={input.doc} signerName={input.signerName} />);
  return { bytes, fileName: pdfFileName(input.doc.receipt_number, "Receipt") };
}

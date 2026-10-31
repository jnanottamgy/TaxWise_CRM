import "server-only";

import { Image, Text, View } from "@react-pdf/renderer";
import { createAdminClient } from "@/server/admin";
import type { FirmProfile } from "@/server/firm";
import {
  PDF,
  PdfAmountInWords,
  PdfDocument,
  PdfFacts,
  PdfKeyValue,
  PdfNotes,
  PdfSection,
  PdfSignature,
  PdfTable,
  loadFirmLogo,
  logoFormat,
  pdfAmountInWords,
  pdfDate,
  pdfDateTime,
  pdfFileName,
  pdfMoney,
  pdfPercent,
  qrPng,
  renderPdf,
  type PdfColumn,
  type PdfLogo,
} from "@/server/pdf";
import { log } from "@/lib/log";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import type { ServerSupabase } from "@/lib/supabase/server";
import { stateName } from "@/lib/domain/india-validators";
import { isIntraState, splitTax } from "@/lib/domain/gst";
import { percentOf, toPaise, type Paise } from "@/lib/domain/money";
import { upiPayUrl } from "@/lib/domain/messaging";
import type { InvoiceDocument } from "@/lib/data/invoices";
import { getNoticeState } from "@/lib/data/portal";

/**
 * The tax invoice PDF (§11, §6.4 Rule 46), and the debit note / supplementary invoice that shares its
 * layout (§7.9.3). Every mandatory Rule 46 field: supplier name, address and GSTIN (letterhead, with
 * the GSTIN as at issue); the number (≤ 16 characters) and date; the recipient's name and address,
 * their GSTIN, or "Unregistered" with their state; the place of supply as state name and code; per
 * line the SAC and description, the taxable value, and the CGST + SGST or IGST rate and amount, with
 * the totals; pure-agent reimbursements in their own table, labelled as reimbursements; the total in
 * figures and in words; "Reverse charge: No"; "Authorised Signatory" under the Partner's name (with
 * their signature image when they uploaded one); bank details and the UPI QR; the terms; and the
 * footer "Computer-generated invoice · TaxWise Consultants · Powered by J-TACS". IRN, acknowledgement
 * and the signed QR print when e-invoicing applies (§6.4). A draft says plainly that it isn't a tax
 * invoice yet; a cancelled one says it was cancelled.
 */

export type InvoicePdfAssets = {
  logo: PdfLogo | null;
  signature: PdfLogo | null;
  upiQr: Buffer | null;
  irnQr: Buffer | null;
};

const r = (n: number | string): Paise => toPaise(n);
const money = (n: number | string) => pdfMoney(r(n));

function stateLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const name = stateName(code);
  return name ? `${name} (${code})` : code;
}

function Banner({ tone, children }: { tone: "warning" | "danger" | "muted"; children: string }) {
  const colour = tone === "danger" ? PDF.colour.dangerText : tone === "warning" ? PDF.colour.warningText : PDF.colour.textMuted;
  const fill = tone === "danger" ? PDF.colour.dangerSoft : tone === "warning" ? PDF.colour.warningSoft : PDF.colour.surface2;
  return (
    <View style={{ backgroundColor: fill, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8, marginBottom: 10 }}>
      <Text style={{ fontSize: PDF.size.body, color: colour, fontWeight: 600 }}>{children}</Text>
    </View>
  );
}

function AmountCell({ amount, rate }: { amount: string; rate: string }) {
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text>{amount}</Text>
      <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>{rate}</Text>
    </View>
  );
}

export function documentTitle(doc: Pick<InvoiceDocument, "invoice_kind" | "status">): string {
  const draft = doc.status === "draft" || doc.status === "awaiting_approval";
  if (doc.invoice_kind === "debit_note") return draft ? "Draft debit note" : "Debit note";
  return draft ? "Draft invoice" : "Tax invoice";
}

export function InvoicePdf({ firm, doc, assets, firmStateCode, eInvoicing }: { firm: FirmProfile; doc: InvoiceDocument; assets: InvoicePdfAssets; firmStateCode: string; eInvoicing: boolean }) {
  const draft = doc.status === "draft" || doc.status === "awaiting_approval";
  const intra = isIntraState(doc.place_of_supply_code, firmStateCode);
  const letterheadFirm: FirmProfile = { ...firm, gstin: doc.firm_gstin ?? firm.gstin };
  const title = documentTitle(doc);
  const number = doc.invoice_number ?? "Draft";

  const taxable = doc.items.filter((i) => !i.is_reimbursement);
  const reimbursements = doc.items.filter((i) => i.is_reimbursement);
  const lineTax = taxable.map((i) => splitTax(percentOf(r(i.amount), i.tax_rate), intra));
  const half = (rate: number) => pdfPercent(rate / 2);

  const columns: PdfColumn[] = [
    { key: "n", header: "#", width: 16 },
    { key: "description", header: "Description of service", flex: 1 },
    { key: "sac", header: "SAC", width: 42 },
    { key: "qty", header: "Qty", width: 28, align: "right" },
    { key: "rate", header: "Rate", width: 58, align: "right" },
    { key: "taxable", header: "Taxable value", width: 66, align: "right" },
    ...(intra
      ? [
          { key: "cgst", header: "CGST", width: 58, align: "right" as const },
          { key: "sgst", header: "SGST", width: 58, align: "right" as const },
        ]
      : [{ key: "igst", header: "IGST", width: 66, align: "right" as const }]),
  ];
  const rows = taxable.map((i, idx) => ({
    n: String(idx + 1),
    description: i.description,
    sac: i.sac_code,
    qty: String(Number(i.quantity)),
    rate: money(i.rate),
    taxable: money(i.amount),
    ...(intra
      ? {
          cgst: <AmountCell amount={pdfMoney(lineTax[idx].cgstPaise)} rate={half(i.tax_rate)} />,
          sgst: <AmountCell amount={pdfMoney(lineTax[idx].sgstPaise)} rate={half(i.tax_rate)} />,
        }
      : { igst: <AmountCell amount={pdfMoney(lineTax[idx].igstPaise)} rate={pdfPercent(i.tax_rate)} /> }),
  }));
  const t = doc.totals;
  const lineTotals: Record<string, string> = intra
    ? { taxable: money(t.taxable_amount), cgst: money(t.cgst_amount), sgst: money(t.sgst_amount) }
    : { taxable: money(t.taxable_amount), igst: money(t.igst_amount) };

  const summary: Array<{ label: string; value: string; emphasis?: boolean }> = [{ label: "Taxable value", value: money(t.taxable_amount) }];
  if (intra) {
    summary.push({ label: "CGST", value: money(t.cgst_amount) }, { label: "SGST", value: money(t.sgst_amount) });
  } else {
    summary.push({ label: "IGST", value: money(t.igst_amount) });
  }
  if (r(t.reimbursement_amount) !== 0) summary.push({ label: "Reimbursements (no GST)", value: money(t.reimbursement_amount) });
  if (r(t.round_off) !== 0) summary.push({ label: "Round-off", value: money(t.round_off) });
  summary.push({ label: "Total", value: money(t.total_amount), emphasis: true });
  const settled = r(t.amount_received) + r(t.tds_credited) + r(t.credit_noted);
  if (!draft && settled > 0) {
    if (r(t.amount_received) > 0) summary.push({ label: "Received", value: `−${money(t.amount_received)}` });
    if (r(t.tds_credited) > 0) summary.push({ label: "TDS deducted", value: `−${money(t.tds_credited)}` });
    if (r(t.credit_noted) > 0) summary.push({ label: "Credit notes", value: `−${money(t.credit_noted)}` });
    summary.push({ label: "Balance due", value: money(Math.max(0, Number(t.outstanding_amount))), emphasis: true });
  }

  const bank = firm.bank;
  const bankRows = bank
    ? [
        bank.accountName ? { label: "Account name", value: bank.accountName } : null,
        bank.accountNumber ? { label: "Account number", value: bank.accountNumber } : null,
        bank.ifsc ? { label: "IFSC", value: bank.ifsc } : null,
        bank.name ? { label: "Bank", value: bank.branch ? `${bank.name}, ${bank.branch}` : bank.name } : null,
      ].filter((x): x is { label: string; value: string } => x !== null)
    : [];

  const recipientFacts = [
    { label: "Bill to", value: doc.recipient.name },
    { label: "Address", value: doc.recipient.address },
    { label: "GSTIN", value: doc.recipient.gstin ?? "Unregistered" },
    { label: "State", value: stateLabel(doc.recipient.state_code) },
  ];
  const supplyFacts = [
    { label: "Place of supply", value: stateLabel(doc.place_of_supply_code) },
    { label: "Tax payable on reverse charge", value: doc.reverse_charge ? "Yes" : "No" },
    ...(doc.billing_period_label ? [{ label: "Period", value: doc.billing_period_label }] : []),
    ...(doc.original ? [{ label: "Against invoice", value: `${doc.original.invoice_number ?? "—"} dated ${pdfDate(doc.original.issue_date)}` }] : []),
  ];

  const showIrn = eInvoicing && Boolean(doc.e_invoice.irn);

  return (
    <PdfDocument
      firm={letterheadFirm}
      logo={assets.logo}
      title={title}
      documentTitle={`${title} ${number}`}
      meta={[
        { label: doc.invoice_kind === "debit_note" ? "Debit note no." : "Invoice no.", value: number },
        { label: "Date", value: pdfDate(doc.issue_date) },
        { label: "Due by", value: pdfDate(doc.due_date) },
      ]}
      footerNote={doc.invoice_kind === "debit_note" ? "Computer-generated debit note" : "Computer-generated invoice"}
    >
      {draft ? <Banner tone="warning">Draft: not a tax invoice. It takes its number when it is issued.</Banner> : null}
      {doc.cancelled_at ? <Banner tone="danger">{`Cancelled on ${pdfDate(doc.cancelled_at.slice(0, 10))}. This invoice was cancelled and reissued; it is not payable.`}</Banner> : null}
      {!draft && !doc.cancelled_at && doc.status === "paid" ? <Banner tone="muted">Paid in full. Thank you.</Banner> : null}

      <View style={{ flexDirection: "row", marginBottom: 4 }}>
        <View style={{ width: "58%", paddingRight: 12 }}>
          <PdfFacts facts={recipientFacts} columns={2} />
        </View>
        <View style={{ width: "42%" }}>
          <PdfFacts facts={supplyFacts} columns={1} />
        </View>
      </View>

      {showIrn ? (
        <View wrap={false} style={{ flexDirection: "row", borderWidth: PDF.hairline, borderColor: PDF.colour.border, borderRadius: 3, padding: 6, marginBottom: 10 }}>
          <View style={{ flexGrow: 1, flexShrink: 1, paddingRight: 8 }}>
            <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>IRN</Text>
            <Text style={{ fontSize: PDF.size.small }}>{doc.e_invoice.irn}</Text>
            <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 3 }}>Acknowledgement</Text>
            <Text style={{ fontSize: PDF.size.small }}>
              {[doc.e_invoice.ack_no, doc.e_invoice.ack_date ? pdfDateTime(doc.e_invoice.ack_date) : null].filter(Boolean).join(" · ") || "—"}
            </Text>
          </View>
          {assets.irnQr ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt attribute
            <Image src={{ data: assets.irnQr, format: "png" }} style={{ width: 64, height: 64 }} />
          ) : null}
        </View>
      ) : null}

      {taxable.length ? <PdfTable columns={columns} rows={rows} totals={[{ label: "Total", values: lineTotals, emphasis: true }]} fontSize={8} /> : null}

      {reimbursements.length ? (
        <PdfSection title="Reimbursements: expenses incurred as pure agent on your behalf (Rule 33), no GST">
          <PdfTable
            columns={[
              { key: "n", header: "#", width: 16 },
              { key: "description", header: "Reimbursement", flex: 1 },
              { key: "amount", header: "Amount", width: 80, align: "right" },
            ]}
            rows={reimbursements.map((i, idx) => ({ n: String(idx + 1), description: i.description, amount: money(i.amount) }))}
            totals={[{ label: "Total reimbursements", values: { amount: money(t.reimbursement_amount) } }]}
            fontSize={8}
          />
        </PdfSection>
      ) : null}

      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <View style={{ width: "52%", paddingRight: 12 }}>
          <PdfAmountInWords words={pdfAmountInWords(r(t.total_amount))} />
        </View>
        <PdfKeyValue rows={summary} width="44%" />
      </View>

      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
        <View style={{ width: "58%", paddingRight: 12 }}>
          {bankRows.length || firm.upi ? (
            <PdfSection title="Payment details">
              <View style={{ flexDirection: "row" }}>
                <View style={{ flexGrow: 1, flexShrink: 1, paddingRight: 8 }}>
                  {bankRows.length ? <PdfKeyValue rows={bankRows} /> : null}
                  {firm.upi ? <Text style={{ fontSize: PDF.size.label, marginTop: 4 }}>{`UPI: ${firm.upi.id}`}</Text> : null}
                  <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, marginTop: 4 }}>
                    {`Please quote ${number === "Draft" ? "the invoice number" : number} with your payment. If you deduct TDS, send us the TDS certificate when it is issued.`}
                  </Text>
                </View>
                {assets.upiQr ? (
                  <View style={{ alignItems: "center", width: 86, paddingLeft: 10 }}>
                    {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt attribute */}
                    <Image src={{ data: assets.upiQr, format: "png" }} style={{ width: 70, height: 70 }} />
                    <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>Scan to pay</Text>
                  </View>
                ) : null}
              </View>
            </PdfSection>
          ) : null}
        </View>
        <View style={{ width: "40%", alignItems: "flex-end" }}>
          {assets.signature ? (
            <View style={{ alignItems: "flex-end", marginTop: 6 }}>
              <Text style={{ fontSize: PDF.size.body, fontWeight: 600 }}>{`For ${firm.legalName ?? firm.firmName}`}</Text>
              {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt attribute */}
              <Image src={{ data: assets.signature.data, format: assets.signature.format }} style={{ height: 32, maxWidth: 140, objectFit: "contain", marginVertical: 3 }} />
              <View style={{ borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.text, paddingTop: 3, alignItems: "flex-end", minWidth: 160 }}>
                {doc.signatory_name ? <Text style={{ fontSize: PDF.size.body }}>{doc.signatory_name}</Text> : null}
                <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>Authorised Signatory</Text>
              </View>
            </View>
          ) : (
            <PdfSignature firmName={firm.legalName ?? firm.firmName} signerName={doc.signatory_name} />
          )}
        </View>
      </View>

      <View wrap={false}>
        <PdfNotes title="Notes" text={doc.notes} />
      </View>
      <View wrap={false}>
        <PdfNotes title="Terms" text={doc.terms} />
      </View>
    </PdfDocument>
  );
}

// -------------------------------------------------------------------------------------------------
// Assets and rendering
// -------------------------------------------------------------------------------------------------

/**
 * A Partner's signature image for the PDF (§7.1: optional, in the private profile-images bucket).
 * Read with the service role after the caller's own access check; PNG or JPEG only. Never throws.
 */
export async function loadSignatureImage(profileId: string | null): Promise<PdfLogo | null> {
  if (!profileId) return null;
  try {
    const admin = createAdminClient();
    const { data: p, error } = await admin.from("profiles").select("signature_path, role").eq("id", profileId).maybeSingle();
    if (error || !p?.signature_path || p.role !== "partner") return null;
    const { data: file, error: dlError } = await admin.storage.from("profile-images").download(p.signature_path);
    if (dlError || !file) return null;
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 2 * 1024 * 1024) return null;
    const format = logoFormat(buf);
    return format ? { data: buf, format } : null;
  } catch (err) {
    log("warn", "signature image not loaded for a PDF", { source: "pdf:invoice", err });
    return null;
  }
}

/**
 * The signatory printed on the PDF (set at issue) and the payee details a portal reader can't see
 * through portal_invoices. Service role, after the caller's access check. Never throws.
 */
export async function loadInvoiceSignatory(invoiceId: string): Promise<{ id: string | null; name: string | null }> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("invoices").select("signatory_id, signatory_name").eq("id", invoiceId).maybeSingle();
    return { id: data?.signatory_id ?? null, name: data?.signatory_name ?? null };
  } catch {
    return { id: null, name: null };
  }
}

/** The UPI QR for what is still due (§11, §7.22 upi://pay); null when nothing is payable or the UPI ID is unusable. */
export async function invoiceUpiQr(firm: FirmProfile, doc: Pick<InvoiceDocument, "invoice_number" | "status" | "cancelled_at" | "totals">): Promise<Buffer | null> {
  if (!firm.upi || doc.cancelled_at || !doc.invoice_number) return null;
  if (!["sent", "partially_paid", "disputed"].includes(doc.status)) return null;
  const due = toPaise(doc.totals.outstanding_amount);
  if (due <= 0) return null;
  try {
    return await qrPng(upiPayUrl({ upiId: firm.upi.id, payee: firm.upi.payeeName, amountPaise: due, note: doc.invoice_number }));
  } catch (err) {
    log("warn", "UPI QR not drawn", { source: "pdf:invoice", err });
    return null;
  }
}

/** The PDF bytes and file name of an invoice, for the download route and the email attachment. */
export async function buildInvoicePdf(input: {
  firm: FirmProfile;
  doc: InvoiceDocument;
  firmStateCode: string;
  eInvoicing: boolean;
}): Promise<{ bytes: Buffer; fileName: string }> {
  const { firm, doc } = input;
  const [logo, signature, upiQr, irnQr] = await Promise.all([
    loadFirmLogo(firm).catch(() => null),
    loadSignatureImage(doc.signatory_id),
    invoiceUpiQr(firm, doc),
    input.eInvoicing && doc.e_invoice.signed_qr ? qrPng(doc.e_invoice.signed_qr, { size: 300 }).catch(() => null) : Promise.resolve(null),
  ]);
  const bytes = await renderPdf(<InvoicePdf firm={firm} doc={doc} assets={{ logo, signature, upiQr, irnQr }} firmStateCode={input.firmStateCode} eInvoicing={input.eInvoicing} />);
  const prefix = doc.invoice_kind === "debit_note" ? "Debit note" : "Invoice";
  const fileName = doc.invoice_number ? pdfFileName(doc.invoice_number, prefix) : pdfFileName(`draft ${doc.id.slice(0, 8)}`, prefix);
  return { bytes, fileName };
}

// -------------------------------------------------------------------------------------------------
// The gate the invoice, receipt and credit-note PDF routes share
// -------------------------------------------------------------------------------------------------

export type PdfGate =
  | { ok: true; audience: "staff" | "client"; userId: string; fullName: string; supabase: ServerSupabase }
  | { ok: false; status: number; body: { ok: false; error: string; code: string } };

/**
 * Who may download a money document (§4.1, §7.22, §12): a Partner or Manager (at two-step sign-in,
 * the same gate as server actions and the compliance report route), or the portal user whose own
 * issued invoice it is (the portal views decide). Employees never: they get no money data anywhere.
 */
export async function gatePdfRequest(): Promise<PdfGate> {
  const deny = (status: number, error: string, code: string): PdfGate => ({ ok: false, status, body: { ok: false, error, code } });
  const session = await getSession();
  if (session.status === "anonymous") return deny(401, "Your session has ended. Please sign in again.", "unauthenticated");
  if (session.status !== "ok") return deny(403, "Your access has been disabled. Ask a Partner.", "forbidden");
  const { user, supabase } = session;
  if (user.role === "employee") return deny(403, "Invoices, receipts and credit notes are kept by Partners and Managers.", "forbidden");
  if (user.mustChangePassword) return deny(403, "Set your own password first.", "must_change_password");
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
    return deny(403, "Enter the code from your authenticator app first.", "mfa_required");
  }
  // A portal user acknowledges the privacy notice before anything else (§7.22), as in the portal's
  // own invoice download route.
  if (user.role === "client" && (await getNoticeState(supabase, user.id)).required) {
    return deny(403, "Read and acknowledge the privacy notice first. Open your portal to see it.", "forbidden");
  }
  return { ok: true, audience: user.role === "client" ? "client" : "staff", userId: user.id, fullName: user.fullName, supabase };
}

import "server-only";

import { View } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { PDF, PdfDocument, PdfFacts, PdfKeyValue, PdfParagraph, PdfSection, PdfTable, loadFirmLogo, pdfDate, pdfFileName, pdfMoney, renderPdf, type PdfLogo } from "@/server/pdf";
import { buildStatement, formatBalance, type Statement, type StatementEvent } from "@/lib/domain/collections";
import type { DateString } from "@/lib/domain/fy";
import type { StatementClient } from "@/lib/data/collections";

/**
 * The statement of account (§7.3.3, §7.4, §11): for one client, or a client group's members
 * together, over any period. The opening balance (everything before the period), each invoice,
 * debit note, receipt, TDS deducted, credit note, write-off, cancellation and receipt reversal in
 * date order with a running balance, and the closing balance; a group's statement adds each
 * member's balances. Debit (Dr) is owed to the firm; credit (Cr) is in the client's favour.
 */

export type StatementPdfInput = {
  firm: FirmProfile;
  logo: PdfLogo | null;
  kind: "client" | "group";
  /** The client's name, or the group's. */
  name: string;
  clients: StatementClient[];
  events: StatementEvent[];
  range: { from: DateString; to: DateString };
  today: DateString;
  preparedBy: string;
};

const money = (paise: number) => (paise ? pdfMoney(paise) : "");

function clientAddress(c: StatementClient): string | null {
  return [c.address, c.city, c.pincode].filter((v) => v && v.trim()).join(", ") || null;
}

export function StatementPdf(p: StatementPdfInput) {
  const st: Statement = buildStatement(p.events, p.range);
  const group = p.kind === "group";
  const nameOf = new Map(p.clients.map((c) => [c.id, c.displayName]));
  const single = !group ? p.clients[0] : null;
  const invoiced = st.totals.byKind.invoice + st.totals.byKind.debit_note;

  const summary: Array<{ label: string; value: string; emphasis?: boolean }> = [{ label: `Opening balance on ${pdfDate(p.range.from)}`, value: formatBalance(st.openingPaise) }];
  if (invoiced) summary.push({ label: "Invoiced", value: pdfMoney(invoiced) });
  if (st.totals.byKind.receipt) summary.push({ label: "Received", value: pdfMoney(st.totals.byKind.receipt) });
  if (st.totals.byKind.tds) summary.push({ label: "TDS deducted", value: pdfMoney(st.totals.byKind.tds) });
  if (st.totals.byKind.credit_note) summary.push({ label: "Credit notes", value: pdfMoney(st.totals.byKind.credit_note) });
  if (st.totals.byKind.write_off) summary.push({ label: "Written off", value: pdfMoney(st.totals.byKind.write_off) });
  if (st.totals.byKind.cancellation) summary.push({ label: "Cancelled invoices", value: pdfMoney(st.totals.byKind.cancellation) });
  if (st.totals.byKind.reversal) summary.push({ label: "Receipts reversed", value: pdfMoney(st.totals.byKind.reversal) });
  summary.push({ label: `Closing balance on ${pdfDate(p.range.to)}`, value: formatBalance(st.closingPaise), emphasis: true });

  const columns = [
    { key: "date", header: "Date", width: 62 },
    { key: "particulars", header: "Particulars", flex: 4 },
    ...(group ? [{ key: "client", header: "Client", flex: 2 }] : []),
    { key: "ref", header: "Reference", width: 82 },
    { key: "debit", header: "Debit", width: 70, align: "right" as const },
    { key: "credit", header: "Credit", width: 70, align: "right" as const },
    { key: "balance", header: "Balance", width: 84, align: "right" as const },
  ];
  const rows = [
    { date: pdfDate(p.range.from), particulars: "Opening balance", client: "", ref: "", debit: "", credit: "", balance: formatBalance(st.openingPaise) },
    ...st.rows.map((r) => ({
      date: pdfDate(r.date),
      particulars: r.description,
      client: r.clientId ? (nameOf.get(r.clientId) ?? "") : "",
      ref: r.reference,
      debit: money(r.debitPaise),
      credit: money(r.creditPaise),
      balance: formatBalance(r.balancePaise),
    })),
  ];

  // A group's balances by member.
  const members = group
    ? p.clients.map((c) => {
        const s = buildStatement(
          p.events.filter((e) => e.clientId === c.id),
          p.range,
        );
        return { c, s };
      })
    : [];

  return (
    <PdfDocument
      firm={p.firm}
      logo={p.logo}
      title="Statement of account"
      documentTitle={`Statement of account · ${p.name}`}
      meta={[
        ...(single ? [{ label: "Client code", value: single.clientCode }] : [{ label: "Group", value: p.name }]),
        { label: "Period", value: `${pdfDate(p.range.from)} – ${pdfDate(p.range.to)}` },
        { label: "Prepared on", value: pdfDate(p.today) },
      ]}
      footerNote="Computer-generated statement"
    >
      <View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <View style={{ width: "54%", paddingRight: 12 }}>
          <PdfSection title="Account of">
            {single ? (
              <PdfFacts
                columns={1}
                facts={[
                  { label: "Name", value: single.legalName ?? single.displayName },
                  { label: "GSTIN", value: single.gstin ?? "Unregistered" },
                  { label: "PAN", value: single.pan },
                  { label: "Address", value: clientAddress(single) },
                ]}
              />
            ) : (
              <PdfFacts
                columns={1}
                facts={[
                  { label: "Group", value: p.name },
                  { label: "Members", value: p.clients.map((c) => c.displayName).join(", ") || null },
                  { label: "Prepared by", value: p.preparedBy },
                ]}
              />
            )}
          </PdfSection>
        </View>
        <View style={{ width: "44%" }}>
          <PdfSection title="Summary">
            <PdfKeyValue rows={summary} />
          </PdfSection>
        </View>
      </View>

      <PdfTable
        fontSize={PDF.size.label}
        columns={columns}
        rows={rows}
        totals={[{ label: "Totals for the period", values: { debit: pdfMoney(st.totals.debitPaise), credit: pdfMoney(st.totals.creditPaise), balance: formatBalance(st.closingPaise) }, emphasis: true }]}
      />

      {group && members.length > 1 ? (
        <PdfSection title="Balances by client">
          <PdfTable
            fontSize={PDF.size.label}
            columns={[
              { key: "client", header: "Client", flex: 3 },
              { key: "code", header: "Code", width: 70 },
              { key: "opening", header: "Opening", width: 84, align: "right" },
              { key: "debit", header: "Debit", width: 74, align: "right" },
              { key: "credit", header: "Credit", width: 74, align: "right" },
              { key: "closing", header: "Closing", width: 84, align: "right" },
            ]}
            rows={members.map(({ c, s }) => ({
              client: c.displayName,
              code: c.clientCode,
              opening: formatBalance(s.openingPaise),
              debit: money(s.totals.debitPaise),
              credit: money(s.totals.creditPaise),
              closing: formatBalance(s.closingPaise),
            }))}
            totals={[{ label: "Group", values: { opening: formatBalance(st.openingPaise), debit: pdfMoney(st.totals.debitPaise), credit: pdfMoney(st.totals.creditPaise), closing: formatBalance(st.closingPaise) }, emphasis: true }]}
          />
        </PdfSection>
      ) : null}

      <PdfParagraph muted>
        Dr is owed to {p.firm.firmName}; Cr is in your favour. TDS you deducted is shown as paid on the payment date. Please send the TDS certificates (Form 16A) for it, and tell us if
        anything here doesn&apos;t match your books.
      </PdfParagraph>
    </PdfDocument>
  );
}

export async function buildStatementPdf(input: Omit<StatementPdfInput, "logo">): Promise<{ bytes: Buffer; fileName: string }> {
  const logo = await loadFirmLogo(input.firm).catch(() => null);
  const bytes = await renderPdf(<StatementPdf {...input} logo={logo} />);
  const who = input.kind === "client" ? (input.clients[0]?.clientCode ?? input.name) : input.name;
  return { bytes, fileName: pdfFileName(`${who} ${input.range.from} to ${input.range.to}`, "Statement") };
}

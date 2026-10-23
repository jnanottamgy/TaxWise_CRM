import "server-only";

import type * as React from "react";
import { Text, View } from "@react-pdf/renderer";
import { PDF, pdfStyles } from "@/server/pdf/theme";

/**
 * Small building blocks for generated documents (§11): a section with its title, key-value facts in
 * one or two columns, a paragraph, notes / terms, the amount in words, and the signature block
 * ("For TaxWise Consultants … Authorised Signatory").
 */

export function PdfSection({ title, children, style }: { title?: string; children: React.ReactNode; style?: Record<string, unknown> }) {
  return (
    <View style={{ marginBottom: 10, ...style }}>
      {title ? <Text style={pdfStyles.sectionTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export interface PdfFact {
  label: string;
  value: string | null | undefined;
}

/** Label above value, in up to three columns ("Bill to", "Place of supply", …). */
export function PdfFacts({ facts, columns = 2 }: { facts: PdfFact[]; columns?: 1 | 2 | 3 }) {
  const width = `${100 / columns}%`;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 6 }}>
      {facts.map((f, i) => (
        <View key={`${f.label}-${i}`} style={{ width, paddingRight: 10, marginBottom: 6 }}>
          <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>{f.label}</Text>
          <Text style={{ fontSize: PDF.size.body, color: f.value ? PDF.colour.text : PDF.colour.textMuted, marginTop: 1 }}>{f.value?.trim() || "—"}</Text>
        </View>
      ))}
    </View>
  );
}

/** Label left, value right: totals, bank details. */
export function PdfKeyValue({ rows, width }: { rows: Array<{ label: string; value: string; emphasis?: boolean }>; width?: number | string }) {
  return (
    <View style={{ width: width ?? "100%" }}>
      {rows.map((r, i) => (
        <View
          key={`${r.label}-${i}`}
          style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5, borderBottomWidth: i === rows.length - 1 ? 0 : PDF.hairline, borderBottomColor: PDF.colour.border }}
        >
          <Text style={{ fontSize: PDF.size.body, color: PDF.colour.textMuted, marginRight: 8 }}>{r.label}</Text>
          <Text style={{ fontSize: r.emphasis ? PDF.size.emphasis : PDF.size.body, fontWeight: r.emphasis ? 700 : 500, textAlign: "right" }}>{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function PdfParagraph({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={{ ...pdfStyles.paragraph, ...(muted ? pdfStyles.muted : {}) }}>{children}</Text>;
}

/** Notes or terms: a title and the text, keeping the writer's line breaks. */
export function PdfNotes({ title, text }: { title: string; text: string | null | undefined }) {
  const t = text?.trim();
  if (!t) return null;
  return (
    <PdfSection title={title}>
      <Text style={{ fontSize: PDF.size.label, color: PDF.colour.text, lineHeight: 1.45 }}>{t}</Text>
    </PdfSection>
  );
}

/** "Amount in words: Rupees … Only" (§0.1 rule 7). */
export function PdfAmountInWords({ words }: { words: string }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>Amount in words</Text>
      <Text style={{ fontSize: PDF.size.body, fontWeight: 500, marginTop: 1 }}>{words}</Text>
    </View>
  );
}

/** "For TaxWise Consultants", space to sign, then the signer and "Authorised Signatory". */
export function PdfSignature({ firmName, signerName, designation = "Authorised Signatory", note }: { firmName: string; signerName?: string | null; designation?: string; note?: string | null }) {
  return (
    <View wrap={false} style={{ alignSelf: "flex-end", alignItems: "flex-end", marginTop: 18, minWidth: 180 }}>
      <Text style={{ fontSize: PDF.size.body, fontWeight: 600 }}>For {firmName}</Text>
      <View style={{ height: 34 }} />
      {note ? <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted, marginBottom: 2 }}>{note}</Text> : null}
      <View style={{ borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.text, paddingTop: 3, alignItems: "flex-end", minWidth: 160 }}>
        {signerName ? <Text style={{ fontSize: PDF.size.body }}>{signerName}</Text> : null}
        <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted }}>{designation}</Text>
      </View>
    </View>
  );
}

import "server-only";

import type * as React from "react";
import { Text, View } from "@react-pdf/renderer";
import { PDF } from "@/server/pdf/theme";

/**
 * A table for generated documents (§11): sentence-case grey headers on a light band, 0.6pt rules,
 * amounts and quantities right-aligned (the PDF font's digits are tabular), rows that never split
 * across a page, and optional total rows under a heavier rule with their label right-aligned against
 * the first value column.
 *
 *   <PdfTable
 *     columns={[
 *       { key: "description", header: "Description", flex: 4 },
 *       { key: "sac", header: "SAC", width: 48 },
 *       { key: "taxable", header: "Taxable value", width: 78, align: "right" },
 *     ]}
 *     rows={lines.map((l) => ({ description: l.description, sac: l.sac, taxable: pdfMoney(l.taxablePaise) }))}
 *     totals={[{ label: "Total", values: { taxable: pdfMoney(totalPaise) }, emphasis: true }]}
 *   />
 */

export interface PdfColumn {
  key: string;
  header: string;
  /** Fixed width in points; or `flex` (default 1) to share the rest of the line. */
  width?: number;
  flex?: number;
  align?: "left" | "right" | "center";
}

export type PdfCell = string | number | null | undefined | React.ReactElement;

export interface PdfTotalRow {
  label: string;
  /** Values by column key; the label sits in the columns before the first of them. */
  values: Record<string, string>;
  emphasis?: boolean;
}

const PAD = { paddingVertical: 4, paddingHorizontal: 5 } as const;

function box(width: number | undefined, flex: number | undefined) {
  return width !== undefined
    ? { width, flexGrow: 0, flexShrink: 0 }
    : { flexGrow: flex ?? 1, flexShrink: 1, flexBasis: 0 };
}

function cell(value: PdfCell, col: PdfColumn, weight: 400 | 600 | 700 = 400) {
  const layout = { ...box(col.width, col.flex), ...PAD };
  if (value !== null && typeof value === "object") return <View key={col.key} style={layout}>{value}</View>;
  const missing = value === null || value === undefined || value === "";
  return (
    <Text key={col.key} style={{ ...layout, textAlign: col.align ?? "left", fontWeight: weight, color: missing ? PDF.colour.textMuted : PDF.colour.text }}>
      {missing ? "—" : String(value)}
    </Text>
  );
}

export function PdfTable({
  columns,
  rows,
  totals = [],
  fontSize = PDF.size.body,
}: {
  columns: PdfColumn[];
  rows: Array<Record<string, PdfCell>>;
  totals?: PdfTotalRow[];
  fontSize?: number;
}) {
  const valueKeys = new Set(totals.flatMap((t) => Object.keys(t.values)));
  const first = Math.max(0, columns.findIndex((c) => valueKeys.has(c.key)));
  const lead = columns.slice(0, first);
  // One merged cell as wide as the lead columns together: fixed widths as its basis, flex shares as its grow.
  const leadFixed = lead.reduce((n, c) => n + (c.width ?? 0), 0);
  const leadFlex = lead.reduce((n, c) => n + (c.width === undefined ? (c.flex ?? 1) : 0), 0);

  return (
    <View style={{ fontSize, borderTopWidth: PDF.hairline, borderTopColor: PDF.colour.border, marginBottom: 10 }}>
      <View wrap={false} style={{ flexDirection: "row", backgroundColor: PDF.colour.surface2, borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border }}>
        {columns.map((c) => (
          <Text key={c.key} style={{ ...box(c.width, c.flex), ...PAD, textAlign: c.align ?? "left", fontSize: PDF.size.label, fontWeight: 600, color: PDF.colour.textMuted }}>
            {c.header}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={i} wrap={false} style={{ flexDirection: "row", borderBottomWidth: PDF.hairline, borderBottomColor: PDF.colour.border }}>
          {columns.map((c) => cell(r[c.key], c))}
        </View>
      ))}
      {totals.map((t, i) => (
        <View
          key={`total-${i}`}
          wrap={false}
          style={{
            flexDirection: "row",
            borderTopWidth: i === 0 ? 1 : 0,
            borderTopColor: PDF.colour.text,
            borderBottomWidth: PDF.hairline,
            borderBottomColor: PDF.colour.border,
            backgroundColor: t.emphasis ? PDF.colour.surface2 : undefined,
          }}
        >
          {lead.length ? (
            <Text
              style={{
                flexBasis: leadFixed,
                flexGrow: leadFlex,
                flexShrink: 0,
                ...PAD,
                textAlign: "right",
                fontWeight: t.emphasis ? 700 : 600,
              }}
            >
              {t.label}
            </Text>
          ) : null}
          {columns.slice(first).map((c, j) => cell(lead.length === 0 && j === 0 ? t.label : (t.values[c.key] ?? " "), c, t.emphasis ? 700 : 600))}
        </View>
      ))}
    </View>
  );
}

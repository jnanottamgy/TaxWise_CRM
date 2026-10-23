import "server-only";

import { StyleSheet } from "@react-pdf/renderer";
import { BRAND } from "@/server/firm";
import { PDF_FONT_FAMILY } from "@/server/pdf/fonts";

/**
 * PDF conventions (§11, §3): A4 portrait, Inter, the §3.1 light palette (navy for the letterhead,
 * grey hairlines, ink text), sizes in points. Every amount is right-aligned in Indian grouping and
 * every date reads `22 Oct 2026` (server/pdf/format.ts).
 */

export const PDF = {
  page: { size: "A4" as const, marginX: 40, marginTop: 36, marginBottom: 56 },
  size: { small: 7.5, label: 8, body: 9, emphasis: 10, title: 13, firm: 15 },
  colour: BRAND,
  hairline: 0.6,
} as const;

export const pdfStyles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: PDF.size.body,
    lineHeight: 1.4,
    color: PDF.colour.text,
    paddingTop: PDF.page.marginTop,
    paddingBottom: PDF.page.marginBottom,
    paddingHorizontal: PDF.page.marginX,
  },
  sectionTitle: {
    fontSize: PDF.size.label,
    fontWeight: 600,
    color: PDF.colour.textMuted,
    marginBottom: 4,
    letterSpacing: 0.2,
  },
  paragraph: { fontSize: PDF.size.body, marginBottom: 6 },
  muted: { color: PDF.colour.textMuted },
  small: { fontSize: PDF.size.small, color: PDF.colour.textMuted },
  strong: { fontWeight: 600 },
  right: { textAlign: "right" },
  row: { flexDirection: "row" },
});

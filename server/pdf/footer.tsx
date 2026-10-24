import "server-only";

import { Text, View } from "@react-pdf/renderer";
import { FIRM_DEFAULTS } from "@/lib/auth/firm-defaults";
import { PDF } from "@/server/pdf/theme";
import { footerLine } from "@/server/pdf/letterhead";

/** A4 in points (react-pdf's own page sizes), for placing the footer from the top. */
const A4_HEIGHT = { portrait: 841.89, landscape: 595.28 } as const;
/** The footer band's height: the hairline, 6pt above the text, one line of small text. */
const FOOTER_HEIGHT = 18;
const FOOTER_BOTTOM = 24;

/**
 * The footer on every page of every generated document (§0, §11): "TaxWise Consultants · Powered by
 * J-TACS" (after an optional note, e.g. "Computer-generated invoice" on tax invoices), with the page
 * number on the right ("Page 1 of 2"). Fixed: it repeats on each page.
 *
 * It is placed from the top of the page, with no fixed height: with the page's inherited
 * lineHeight, react-pdf 4 drops a bottom-anchored fixed footer from every page, and a fixed height
 * drops its page-number text (laid out again on each page), so the band's height is only used to
 * work out where it starts.
 *
 *   <PdfFooter />                                         → TaxWise Consultants · Powered by J-TACS
 *   <PdfFooter firmName={firm.firmName} note="Computer-generated invoice" />
 *   <PdfFooter orientation="landscape" />                 (on a landscape page)
 */
export function PdfFooter({
  firmName = FIRM_DEFAULTS.firmName,
  note,
  orientation = "portrait",
}: {
  firmName?: string;
  note?: string | null;
  orientation?: "portrait" | "landscape";
}) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        left: PDF.page.marginX,
        right: PDF.page.marginX,
        top: A4_HEIGHT[orientation] - FOOTER_BOTTOM - FOOTER_HEIGHT,
        flexDirection: "row",
        justifyContent: "space-between",
        borderTopWidth: PDF.hairline,
        borderTopColor: PDF.colour.border,
        paddingTop: 6,
      }}
    >
      <Text style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}>{footerLine(firmName, note)}</Text>
      <Text
        style={{ fontSize: PDF.size.small, color: PDF.colour.textMuted }}
        render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : "")}
      />
    </View>
  );
}

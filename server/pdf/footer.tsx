import "server-only";

import { Text, View } from "@react-pdf/renderer";
import { FIRM_DEFAULTS } from "@/lib/auth/firm-defaults";
import { PDF } from "@/server/pdf/theme";
import { footerLine } from "@/server/pdf/letterhead";

/**
 * The footer on every page of every generated document (§0, §11): "TaxWise Consultants · Powered by
 * J-TACS" (after an optional note, e.g. "Computer-generated invoice" on tax invoices), with the page
 * number on the right ("Page 1 of 2"). Fixed: it repeats on each page.
 *
 *   <PdfFooter />                                         → TaxWise Consultants · Powered by J-TACS
 *   <PdfFooter firmName={firm.firmName} note="Computer-generated invoice" />
 */
export function PdfFooter({ firmName = FIRM_DEFAULTS.firmName, note }: { firmName?: string; note?: string | null }) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        left: PDF.page.marginX,
        right: PDF.page.marginX,
        bottom: 24,
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

import "server-only";

import type * as React from "react";
import { Document, Page } from "@react-pdf/renderer";
import type { FirmProfile } from "@/server/firm";
import { Letterhead, type LetterheadMeta } from "@/server/pdf/letterhead";
import { PdfFooter } from "@/server/pdf/footer";
import type { PdfLogo } from "@/server/pdf/logo";
import { PDF, pdfStyles } from "@/server/pdf/theme";

/**
 * One generated document on A4 (§11): the letterhead on the first page, the footer on every page,
 * the content in between. Document metadata names the firm as author and J-TACS as producer.
 *
 *   const firm = await getFirmProfile(supabase);
 *   const logo = await loadFirmLogo(firm);
 *   const pdf = await renderPdf(
 *     <PdfDocument firm={firm} logo={logo} title="Tax invoice" documentTitle={`Invoice ${number}`}
 *       meta={[{ label: "Invoice no.", value: number }, { label: "Date", value: pdfDate(date) }]}
 *       footerNote="Computer-generated invoice">
 *       …PdfFacts, PdfTable, PdfAmountInWords, PdfSignature…
 *     </PdfDocument>,
 *   );
 */
export function PdfDocument({
  firm,
  logo,
  title,
  documentTitle,
  meta,
  footerNote,
  landscape = false,
  pan,
  children,
}: {
  firm: FirmProfile;
  logo?: PdfLogo | null;
  /** The heading on the letterhead ("Tax invoice"). */
  title?: string;
  /** The PDF's own title (viewer tab, file properties): "Invoice TW/26-27/0042". */
  documentTitle: string;
  meta?: LetterheadMeta[];
  /** Before the firm name in the footer: "Computer-generated invoice". */
  footerNote?: string | null;
  landscape?: boolean;
  /** Shown on the letterhead when given (PAN isn't in the public profile). */
  pan?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Document title={documentTitle} author={firm.firmName} creator={firm.firmName} producer="J-TACS" subject={documentTitle} language="en-IN">
      <Page size={PDF.page.size} orientation={landscape ? "landscape" : "portrait"} style={pdfStyles.page} wrap>
        <Letterhead firm={firm} logo={logo} title={title} meta={meta} showPan={Boolean(pan)} pan={pan} />
        {children}
        <PdfFooter firmName={firm.firmName} note={footerNote} />
      </Page>
    </Document>
  );
}

import "server-only";

import type * as React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { registerPdfFonts } from "@/server/pdf/fonts";

/**
 * Renders a generated document to PDF bytes on the server (§2.1 "PDFs are generated on the server
 * and streamed; nothing is generated in the browser", §11).
 *
 *   const bytes = await renderPdf(<PdfDocument …>…</PdfDocument>);
 *   return new Response(new Uint8Array(bytes), { headers: pdfResponseHeaders(pdfFileName(number)) });
 *
 * Registers Inter first (server/pdf/fonts.ts). Throws on a rendering error: a route handler catches
 * it and answers with its Ref (CONVENTIONS §3.5).
 */
export async function renderPdf(element: React.ReactElement<DocumentProps>): Promise<Buffer> {
  registerPdfFonts();
  return renderToBuffer(element);
}

/**
 * Headers for streaming a PDF: inline (opens in the browser's viewer) or as a download; never cached.
 * Spaces stay ("Invoice TW-26-27-0042.pdf"); anything else a file name can't carry becomes a hyphen.
 */
export function pdfResponseHeaders(fileName: string, opts: { download?: boolean } = {}): Record<string, string> {
  const safe = fileName.replace(/[^A-Za-z0-9 ._-]+/g, "-").replace(/ {2,}/g, " ").trim() || "document.pdf";
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${opts.download ? "attachment" : "inline"}; filename="${safe}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * Generated documents (§11): render, the A4 frame with letterhead and footer, tables, building
 * blocks, money/date formatting, the logo and the UPI QR. Server-only (every module imports
 * "server-only"); see each file for its usage.
 */
export { renderPdf, pdfResponseHeaders } from "@/server/pdf/render";
export { PdfDocument } from "@/server/pdf/document";
export { Letterhead, footerLine, type LetterheadMeta } from "@/server/pdf/letterhead";
export { PdfFooter } from "@/server/pdf/footer";
export { PdfTable, type PdfColumn, type PdfCell, type PdfTotalRow } from "@/server/pdf/table";
export { PdfSection, PdfFacts, PdfKeyValue, PdfParagraph, PdfNotes, PdfAmountInWords, PdfSignature, type PdfFact } from "@/server/pdf/blocks";
export { pdfMoney, pdfMoneyFromRupees, pdfAmountInWords, pdfDate, pdfDateTime, pdfPercent, pdfText, pdfFileName } from "@/server/pdf/format";
export { loadFirmLogo, logoFormat, type PdfLogo } from "@/server/pdf/logo";
export { qrPng } from "@/server/pdf/qr";
export { registerPdfFonts, PDF_FONT_FAMILY } from "@/server/pdf/fonts";
export { PDF, pdfStyles } from "@/server/pdf/theme";

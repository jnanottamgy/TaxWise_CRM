import "server-only";

import { log } from "@/lib/log";

/**
 * The firm's logo for the letterhead (§1, §7.21: PNG/SVG/JPG ≤ 1 MB in the public `branding`
 * bucket). PDFs embed PNG and JPEG only, so an SVG logo prints the firm's name in type instead.
 * The file is fetched from its public URL with a short timeout and checked by its magic bytes;
 * any failure returns null and the letterhead falls back to the name (a document never fails for
 * want of a logo).
 */

export interface PdfLogo {
  data: Buffer;
  format: "png" | "jpg";
}

const MAX_LOGO_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;

/** PNG or JPEG by magic bytes; null for anything else (SVG, WebP, HTML error pages). Exported for tests. */
export function logoFormat(bytes: Uint8Array): PdfLogo["format"] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

export async function loadFirmLogo(firm: { logoUrl: string | null }): Promise<PdfLogo | null> {
  if (!firm.logoUrl) return null;
  try {
    const res = await fetch(firm.logoUrl, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) {
      log("warn", "logo not fetched for a PDF", { source: "pdf:logo", status: res.status });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO_BYTES) return null;
    const format = logoFormat(buf);
    return format ? { data: buf, format } : null;
  } catch (err) {
    log("warn", "logo not fetched for a PDF", { source: "pdf:logo", err });
    return null;
  }
}

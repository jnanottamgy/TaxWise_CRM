import "server-only";

import { Font } from "@react-pdf/renderer";
import { INTER_400_TTF_BASE64 } from "@/server/pdf/fonts/inter-400";
import { INTER_500_TTF_BASE64 } from "@/server/pdf/fonts/inter-500";
import { INTER_600_TTF_BASE64 } from "@/server/pdf/fonts/inter-600";
import { INTER_700_TTF_BASE64 } from "@/server/pdf/fonts/inter-700";

/**
 * Inter for PDFs (§3.2 "PDFs use Inter as well").
 *
 * The fonts are bundled as base64 TrueType inside the server code (server/pdf/fonts/*.ts), so they
 * load the same on a laptop and on the host's serverless functions without reading files from disk
 * (nothing to trace into the bundle, nothing to fetch). They are static instances of Inter 4.1 (400, 500, 600,
 * 700) subset to Latin, Latin Extended-A, punctuation and ₹ by server/pdf/fonts/subset-inter.py,
 * with tabular figures frozen in, so amounts line up in PDF columns. SIL Open Font License 1.1
 * (server/pdf/fonts/OFL.txt).
 *
 * Registration is process-wide in @react-pdf/renderer's font store; it holds no user data.
 */

export const PDF_FONT_FAMILY = "Inter";

let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: `data:font/ttf;base64,${INTER_400_TTF_BASE64}`, fontWeight: 400 },
      { src: `data:font/ttf;base64,${INTER_500_TTF_BASE64}`, fontWeight: 500 },
      { src: `data:font/ttf;base64,${INTER_600_TTF_BASE64}`, fontWeight: 600 },
      { src: `data:font/ttf;base64,${INTER_700_TTF_BASE64}`, fontWeight: 700 },
    ],
  });
  // Names, GSTINs, invoice numbers and addresses must never be hyphenated at a line end.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

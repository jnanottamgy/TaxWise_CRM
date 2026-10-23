import "server-only";

import QRCode from "qrcode";

/**
 * A QR code as a PNG for PDFs (§11 tax invoice "bank details + UPI QR"): encode the UPI pay link from
 * lib/domain/messaging.ts upiPayUrl and place it with <Image src={{ data, format: "png" }} />.
 * Error correction M, a quiet zone of 2 modules, ink on white. Throws on input QR can't hold.
 */
export async function qrPng(text: string, opts: { size?: number } = {}): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: opts.size ?? 240,
    color: { dark: "#0F172AFF", light: "#FFFFFFFF" },
  });
}

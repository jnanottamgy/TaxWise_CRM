import "server-only";

import { Image, Text, View } from "@react-pdf/renderer";
import { POWERED_BY, displayWebsite, formatFirmAddress, type FirmProfile } from "@/server/firm";
import { PDF } from "@/server/pdf/theme";
import type { PdfLogo } from "@/server/pdf/logo";

/**
 * The letterhead every generated document starts with (§11 "letterhead from Settings"): the logo
 * (or the firm's name set in type), the firm block (address, GSTIN, phone, email, website) and, on
 * the right, the document's title with its key facts (number, date …). A navy rule closes it
 * (§3.1 --brand-navy "PDF headers"). Ink-light: no filled band, so it prints well in an office.
 *
 *   <Letterhead firm={firm} logo={logo} title="Tax invoice"
 *     meta={[{ label: "Invoice no.", value: "TW/26-27/0042" }, { label: "Date", value: "22 Oct 2026" }]} />
 */

export interface LetterheadMeta {
  label: string;
  value: string;
}

export function Letterhead({
  firm,
  logo,
  title,
  meta = [],
  showPan,
  pan,
}: {
  firm: FirmProfile;
  /** From loadFirmLogo(firm); null prints the name in type. */
  logo?: PdfLogo | null;
  /** "Tax invoice", "QUOTATION", "Receipt voucher", "Statement of account" … */
  title?: string;
  meta?: LetterheadMeta[];
  /** PAN isn't in the public profile; documents that need it pass it. */
  showPan?: boolean;
  pan?: string | null;
}) {
  const address = formatFirmAddress(firm);
  const contact = [firm.phone, firm.email, displayWebsite(firm.website)].filter(Boolean).join("  ·  ");
  const ids = [firm.gstin ? `GSTIN ${firm.gstin}` : null, showPan && pan ? `PAN ${pan}` : null].filter(Boolean).join("  ·  ");
  return (
    <View fixed={false} style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", maxWidth: "62%" }}>
          {logo ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt attribute
            <Image src={{ data: logo.data, format: logo.format }} style={{ height: 40, maxWidth: 120, objectFit: "contain", marginRight: 10 }} />
          ) : null}
          <View style={{ flexShrink: 1 }}>
            <Text style={{ fontSize: PDF.size.firm, lineHeight: 1.25, fontWeight: 600, color: PDF.colour.navy, letterSpacing: -0.1 }}>{firm.legalName ?? firm.firmName}</Text>
            {firm.tagline ? <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 2 }}>{firm.tagline}</Text> : null}
            {address ? <Text style={{ fontSize: PDF.size.label, color: PDF.colour.text, marginTop: 4 }}>{address}</Text> : null}
            {contact ? <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginTop: 1 }}>{contact}</Text> : null}
            {ids ? <Text style={{ fontSize: PDF.size.label, color: PDF.colour.text, marginTop: 1 }}>{ids}</Text> : null}
          </View>
        </View>
        {title || meta.length ? (
          <View style={{ alignItems: "flex-end", maxWidth: "36%" }}>
            {title ? <Text style={{ fontSize: PDF.size.title, lineHeight: 1.25, fontWeight: 700, color: PDF.colour.navy, letterSpacing: 0.3 }}>{title}</Text> : null}
            {meta.map((m, i) => (
              <View key={`${m.label}-${i}`} style={{ flexDirection: "row", marginTop: i === 0 ? 5 : 1.5 }}>
                <Text style={{ fontSize: PDF.size.label, color: PDF.colour.textMuted, marginRight: 6 }}>{m.label}</Text>
                <Text style={{ fontSize: PDF.size.label, color: PDF.colour.text, fontWeight: 500 }}>{m.value}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <View style={{ marginTop: 10, borderBottomWidth: 1.5, borderBottomColor: PDF.colour.navy }} />
    </View>
  );
}

/** "TaxWise Consultants · Powered by J-TACS", optionally after a note ("Computer-generated invoice"). */
export function footerLine(firmName: string, note?: string | null): string {
  return [note?.trim() || null, firmName, POWERED_BY].filter(Boolean).join(" · ");
}

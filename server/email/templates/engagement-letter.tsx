import "server-only";

import { renderEmail, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { day, greeting, signOff } from "@/server/email/templates/parts";

/**
 * §10.13 Engagement letter for signature (§7.15.3): the letter is attached as a PDF; the client signs
 * it and returns it, or uploads the signed copy in the portal.
 */

export interface EngagementLetterData {
  recipientName: string;
  clientName: string;
  /** "2026-27" */
  financialYear: string;
  services: string[];
  /** Absolute URL where the signed copy can be uploaded (the portal request), if any. */
  uploadUrl?: string | null;
  /** YYYY-MM-DD: the letter's expiry, if it has one. */
  expiresOn?: string | null;
  partnerName: string;
  /** Audit engagements (SA 210) use slightly different wording. */
  isAudit?: boolean;
}

export function engagementLetterEmail(d: EngagementLetterData, firm: EmailFirm): RenderedEmail {
  const blocks: EmailBlock[] = [
    {
      kind: "paragraph",
      text: d.isAudit
        ? `Please find attached our engagement letter for the audit of ${d.clientName} for FY ${d.financialYear}. It sets out the objective and scope of the audit, our responsibilities and those of management, the financial reporting framework, the form of our report, and our fees.`
        : `Please find attached our engagement letter for FY ${d.financialYear}. It sets out the services we'll provide to ${d.clientName}, what each of us is responsible for, and our fees.`,
    },
  ];
  if (d.services.length) blocks.push({ kind: "list", title: "Services covered", items: d.services.map((s) => ({ title: s })) });
  blocks.push({
    kind: "paragraph",
    text: d.uploadUrl
      ? "Please read it, sign where marked by an authorised signatory, and upload the signed copy from the link below, or reply to this email with it attached."
      : "Please read it, sign where marked by an authorised signatory, and reply to this email with the signed copy attached.",
  });
  if (d.uploadUrl) blocks.push({ kind: "button", label: "Upload the signed copy", url: d.uploadUrl });
  if (d.expiresOn) blocks.push({ kind: "small", text: `This letter covers our work until ${day(d.expiresOn)}.` });
  blocks.push({ kind: "small", text: "We agree the terms of each year's work in writing before we begin, as the ICAI's standards expect." });
  return renderEmail(
    {
      subjectItem: `Engagement letter for FY ${d.financialYear}: please sign`,
      preheader: `For ${d.clientName}, FY ${d.financialYear}.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.partnerName),
    },
    firm,
  );
}

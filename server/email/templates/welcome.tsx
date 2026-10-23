import "server-only";

import { renderEmail, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { greeting, joinParts, signOff } from "@/server/email/templates/parts";

/**
 * §10.4 Welcome to TaxWise (after onboarding, optional, §7.3.2): who looks after them, how to share
 * documents, and the portal link.
 */

export interface WelcomeData {
  contactName: string;
  clientName: string;
  ownerName: string;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  /** The services taken, in words ("GST returns (monthly)", "Income tax return"). */
  services?: string[];
  /** Absolute URL of the portal, when they have (or are getting) a login. */
  portalUrl?: string | null;
  senderName?: string | null;
}

export function welcomeEmail(d: WelcomeData, firm: EmailFirm): RenderedEmail {
  const contact = joinParts([d.ownerEmail, d.ownerPhone], " · ");
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: `Thank you for choosing ${firm.firmName}. We're glad to be working with ${d.clientName}.` },
    {
      kind: "details",
      title: "Who looks after you",
      rows: [{ label: "Your contact at the firm", value: contact ? `${d.ownerName}\n${contact}` : d.ownerName }],
    },
  ];
  if (d.services?.length) {
    blocks.push({ kind: "list", title: "What we'll do for you", items: d.services.map((s) => ({ title: s })) });
  }
  blocks.push({ kind: "subheading", text: "How to share documents with us" });
  if (d.portalUrl) {
    blocks.push(
      {
        kind: "paragraph",
        text: "Upload them in your client portal, against the request we send you. Each file goes straight into your client file, and you can see what we still need.",
      },
      { kind: "button", label: "Open the client portal", url: d.portalUrl },
    );
  } else {
    blocks.push({
      kind: "paragraph",
      text: `Reply to this email with the documents attached, or send them to ${d.ownerName}. We'll confirm when we have everything.`,
    });
  }
  blocks.push({
    kind: "paragraph",
    text: "Before each deadline we'll remind you what's due and exactly what we need from you, so nothing is left to the last day.",
  });

  return renderEmail(
    {
      subjectItem: `Welcome, ${d.clientName}`,
      preheader: `${d.ownerName} looks after you. Here's how to share documents with us.`,
      greeting: greeting(d.contactName),
      blocks,
      signOff: signOff(firm, d.senderName ?? d.ownerName),
    },
    firm,
  );
}

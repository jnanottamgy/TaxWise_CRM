import "server-only";

import { renderEmail, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { greeting, signOff } from "@/server/email/templates/parts";

/**
 * §10.3 Client portal invite (§7.22 Access): what the portal is for, the sign-in link, the email
 * and the temporary password. On first sign-in the client sets a password and reads the privacy
 * notice (§6.10).
 */

export interface PortalInviteData {
  contactName: string;
  clientName: string;
  email: string;
  temporaryPassword: string;
  /** Absolute URL of /login (clients sign in on the same page as staff). */
  loginUrl: string;
  /** Who at the firm looks after them. */
  ownerName?: string | null;
  senderName?: string | null;
  reset?: boolean;
}

export function portalInviteEmail(d: PortalInviteData, firm: EmailFirm): RenderedEmail {
  return renderEmail(
    {
      subjectItem: d.reset ? "Your client portal password has been reset" : `Your client portal for ${d.clientName}`,
      preheader: "See your deadlines, upload documents and view invoices in one place.",
      greeting: greeting(d.contactName),
      blocks: [
        {
          kind: "paragraph",
          text: d.reset
            ? `We've reset your password for the ${firm.firmName} client portal. Use the temporary password below to sign in.`
            : `We've set up your ${firm.firmName} client portal for ${d.clientName}. It keeps everything between us in one place:`,
        },
        ...(d.reset
          ? []
          : [
              {
                kind: "list" as const,
                items: [
                  { title: "Your upcoming deadlines, and what we need from you for each" },
                  { title: "Documents we ask for: upload them from your phone or computer, and see what's still pending" },
                  { title: "The status of your returns, with acknowledgements to download" },
                  { title: "Invoices and receipts, with bank and UPI details to pay" },
                  { title: "Messages with our team" },
                ],
              },
            ]),
        {
          kind: "details",
          rows: [
            { label: "Sign-in page", value: d.loginUrl, mono: true },
            { label: "Email", value: d.email, mono: true },
            { label: "Temporary password", value: d.temporaryPassword, mono: true, emphasis: true },
          ],
        },
        { kind: "button", label: "Open the client portal", url: d.loginUrl },
        {
          kind: "paragraph",
          text: "The first time you sign in you'll choose your own password (at least 8 characters, with an uppercase letter, a lowercase letter, a digit and a symbol) and read our privacy notice.",
        },
        {
          kind: "small",
          text: d.ownerName
            ? `Questions? Reply to this email or speak to ${d.ownerName}. Never share this password with anyone; we will never ask you for it.`
            : "Questions? Reply to this email. Never share this password with anyone; we will never ask you for it.",
        },
      ],
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}

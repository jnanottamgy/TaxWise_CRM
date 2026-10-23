import "server-only";

import { renderEmail, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { greeting, signOff } from "@/server/email/templates/parts";

/**
 * §10.1 Staff invite (§4.5 step 2 "Login is issued on save"): the sign-in link, the email, the
 * temporary password, and that they set their own on first sign-in. Partners and Managers are told
 * about two-step sign-in, which §12 requires of them.
 */

export interface StaffInviteData {
  name: string;
  email: string;
  temporaryPassword: string;
  /** Absolute URL of /login. */
  loginUrl: string;
  role: "partner" | "manager" | "employee";
  invitedByName?: string | null;
  /** A password reset by a Partner or Manager uses the same email with a different opening. */
  reset?: boolean;
}

const ROLE_WORD: Record<StaffInviteData["role"], string> = { partner: "Partner", manager: "Manager", employee: "Employee" };

export function staffInviteEmail(d: StaffInviteData, firm: EmailFirm): RenderedEmail {
  const by = d.invitedByName?.trim();
  const opening = d.reset
    ? `${by ?? "A Partner"} has reset your password for the ${firm.firmName} practice app. Use the temporary password below to sign in.`
    : `${by ?? "A Partner"} has created your login for the ${firm.firmName} practice app, as ${ROLE_WORD[d.role] === "Employee" ? "a team member" : `a ${ROLE_WORD[d.role]}`}. It is where the firm's clients, tasks, deadlines and timesheets live.`;

  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: opening },
    {
      kind: "details",
      rows: [
        { label: "Sign-in page", value: d.loginUrl, mono: true },
        { label: "Email", value: d.email, mono: true },
        { label: "Temporary password", value: d.temporaryPassword, mono: true, emphasis: true },
      ],
    },
    { kind: "button", label: "Sign in", url: d.loginUrl },
    {
      kind: "paragraph",
      text: "You'll set your own password the first time you sign in; the temporary one stops working then. Your password needs at least 8 characters, with an uppercase letter, a lowercase letter, a digit and a symbol.",
    },
  ];
  if (d.role !== "employee") {
    blocks.push({
      kind: "callout",
      tone: "info",
      text: "Partners and Managers also set up two-step sign-in with an authenticator app (Google Authenticator, Microsoft Authenticator or similar) the first time, because they can see fees and stored portal passwords.",
    });
  }
  blocks.push({
    kind: "small",
    text: `Didn't expect this email? Tell us at ${firm.email ?? "the office"}; someone may have typed the wrong address. Never share this password with anyone.`,
  });

  return renderEmail(
    {
      subjectItem: d.reset ? "Your password has been reset" : "Your login to the practice app",
      preheader: d.reset ? "A temporary password to sign in with." : "Your sign-in details and a temporary password.",
      greeting: greeting(d.name),
      blocks,
      signOff: signOff(firm, by),
    },
    firm,
  );
}

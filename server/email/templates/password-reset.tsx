import "server-only";

import { renderEmail, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";

/**
 * §10.2 Password reset. Supabase sends it with its own mailer (it works before Resend is verified,
 * §4.4), so the app doesn't send this one: Settings → Email shows this branded template for a
 * Partner to paste into Supabase → Authentication → Email templates → Reset password.
 * `{{ .ConfirmationURL }}` is Supabase's placeholder for the reset link.
 */

export const SUPABASE_CONFIRMATION_URL = "{{ .ConfirmationURL }}";

export function passwordResetTemplate(firm: EmailFirm): RenderedEmail {
  return renderEmail(
    {
      subjectItem: "Reset your password",
      preheader: "A link to choose a new password.",
      greeting: "Hello,",
      blocks: [
        { kind: "paragraph", text: `Someone asked to reset the password for your ${firm.firmName} login. Choose a new one with the button below. The link works once and expires after a short while.` },
        { kind: "button", label: "Choose a new password", url: SUPABASE_CONFIRMATION_URL },
        { kind: "link", label: "If the button doesn't work, open this link:", url: SUPABASE_CONFIRMATION_URL },
        {
          kind: "small",
          text: "Didn't ask for this? Ignore this email: your password stays as it is. If it keeps happening, tell a Partner.",
        },
      ],
    },
    firm,
  );
}

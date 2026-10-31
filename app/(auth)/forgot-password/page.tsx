import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { AuthCard } from "../_components/auth-card";

export const metadata: Metadata = { title: "Forgot your password" };

/**
 * Forgot password (§4.4). The app sends no email, so there is no reset link: a Partner or Manager
 * resets a staff password in People (server/actions/people.ts resetPassword), and the firm resets a
 * client's portal password from the client's page (server/actions/portal-access.ts). Either way the
 * new temporary password is shared on WhatsApp, and is changed at the next sign-in.
 */
export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Forgot your password?"
      description="Passwords aren't reset by email here. Someone at the firm gives you a new temporary one."
      footer={
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          Back to sign in
        </Link>
      }
    >
      <div className="flex flex-col gap-5 text-base text-text">
        <section aria-labelledby="forgot-staff" className="flex flex-col gap-1.5">
          <h2 id="forgot-staff" className="font-medium">
            Work at the firm?
          </h2>
          <p className="text-text-muted">
            Ask a Partner or a Manager to reset your password. They do it from your page in People, and send you a temporary password on WhatsApp.
          </p>
        </section>
        <section aria-labelledby="forgot-client" className="flex flex-col gap-1.5">
          <h2 id="forgot-client" className="font-medium">
            A client of the firm?
          </h2>
          <p className="text-text-muted">Ask the person at the firm who looks after you to reset your portal access. They send you a temporary password on WhatsApp.</p>
        </section>
        <p className="text-sm text-text-muted">You choose your own password the first time you sign in with the temporary one.</p>
      </div>
    </AuthCard>
  );
}

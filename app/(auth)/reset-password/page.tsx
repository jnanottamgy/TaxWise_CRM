import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/current-user";
import { getMfaState } from "@/lib/auth/mfa";
import { log } from "@/lib/log";
import { cameFromEmailLink } from "@/server/auth";
import { AuthCard, TroubleLine } from "../_components/auth-card";
import { MfaCodeForm } from "../_components/mfa-code-form";
import { NewPasswordForm } from "../_components/new-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

/**
 * Where the reset email lands (§4.4), after /auth/confirm has turned the link into a session.
 * Sets the new password and signs them in.
 */
export default async function ResetPasswordPage() {
  const session = await getSession();

  const fromLink = session.status === "ok" && (session.user.mustChangePassword || (await cameFromEmailLink(session.supabase)));

  // No session, or a session that didn't come from a reset email: setting a password here would
  // skip the current-password check, so send them for a fresh link instead.
  if (session.status === "anonymous" || (session.status === "ok" && !fromLink)) {
    return (
      <AuthCard
        title={session.status === "ok" ? "Use the link from your email" : "This link has expired"}
        description={
          session.status === "ok"
            ? "To choose a new password here, open the reset link we email you. Signed in already? Change it from your profile instead."
            : "Reset links work once and stop working after a while. Ask for a new one and use the newest email."
        }
        footer={<TroubleLine />}
      >
        <div className="flex flex-col gap-2">
          <Button asChild size="lg" className="w-full">
            <Link href="/forgot-password">Send a new link</Link>
          </Button>
          <Button asChild variant="ghost" size="lg" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }
  if (session.status !== "ok") redirect("/no-access");
  const { user, supabase } = session;

  let needsCode: string | null = null;
  try {
    const state = await getMfaState(supabase);
    if (state.verified.length > 0 && state.currentLevel !== "aal2") needsCode = state.verified[0].id;
  } catch (err) {
    log("warn", "MFA state lookup failed on /reset-password", { source: "page:/reset-password", userId: user.id, err });
  }

  if (needsCode) {
    return (
      <AuthCard
        title="Enter your sign-in code"
        description="Before you choose a new password, enter the 6-digit code from your authenticator app."
        footer={<TroubleLine />}
      >
        <MfaCodeForm factorId={needsCode} after="reload" />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description={
        <>
          For <span className="font-medium break-all text-text">{user.email}</span>.
        </>
      }
      footer={<TroubleLine />}
    >
      <NewPasswordForm email={user.email} submitLabel="Save and sign in" />
    </AuthCard>
  );
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { homePathFor } from "@/lib/auth/roles";
import { getMfaState } from "@/lib/auth/mfa";
import { log } from "@/lib/log";
import { AuthCard } from "../_components/auth-card";
import { MfaCodeForm } from "../_components/mfa-code-form";
import { NewPasswordForm } from "../_components/new-password-form";
import { SignOutButton } from "../_components/sign-out-button";

export const metadata: Metadata = { title: "Set your password" };

/**
 * Forced password change (§4.4). A login created or reset by a Partner or Manager carries
 * must_change_password; until it is changed every route redirects here and every action refuses.
 */
export default async function SetPasswordPage() {
  const { user, supabase } = await requireUser({ allowMustChangePassword: true, allowPendingMfa: true });
  if (!user.mustChangePassword) redirect(homePathFor(user.role));

  // Supabase only lets someone with an authenticator change their password after its code (aal2).
  let needsCode: string | null = null;
  try {
    const state = await getMfaState(supabase);
    if (state.verified.length > 0 && state.currentLevel !== "aal2") needsCode = state.verified[0].id;
  } catch (err) {
    log("warn", "MFA state lookup failed on /set-password", { source: "page:/set-password", userId: user.id, err });
  }

  if (needsCode) {
    return (
      <AuthCard
        title="Enter your sign-in code"
        description="Before you choose a new password, enter the 6-digit code from your authenticator app."
        footer={<SignOutButton variant="link" />}
      >
        <MfaCodeForm factorId={needsCode} after="reload" />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set your own password"
      description="You signed in with a temporary password. Choose your own to carry on. Nobody else will know it."
      footer={<SignOutButton variant="link" />}
    >
      <NewPasswordForm email={user.email} submitLabel="Save password" />
    </AuthCard>
  );
}

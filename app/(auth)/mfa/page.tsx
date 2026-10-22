import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/current-user";
import { getMfaState, mfaRequiredFor, mfaStep, type MfaState } from "@/lib/auth/mfa";
import { destinationFor, safeNextPath } from "@/lib/supabase/proxy";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { AuthCard } from "../_components/auth-card";
import { FormMessage } from "../_components/form-bits";
import { MfaCodeForm } from "../_components/mfa-code-form";
import { MfaEnrol } from "../_components/mfa-enrol";
import { SignOutButton } from "../_components/sign-out-button";

export const metadata: Metadata = { title: "Two-step sign-in" };

/**
 * Two-step sign-in (§12). One page for both halves:
 * - challenge: someone with an authenticator enters the code after their password;
 * - enrol: Partners and Managers must add one before going further; Employees can choose to,
 *   from Profile (link here with `?enrol=1&next=/profile`).
 */
export default async function MfaPage({ searchParams }: PageProps<"/mfa">) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(first(params.next));
  const wantsEnrol = first(params.enrol) === "1";

  const session = await getSession();
  if (session.status === "anonymous") redirect("/login");
  if (session.status !== "ok") redirect("/no-access");
  const { user, supabase } = session;
  if (user.mustChangePassword) redirect("/set-password");

  let state: MfaState;
  try {
    state = await getMfaState(supabase);
  } catch (err) {
    const ref = logUnexpected(err, { source: "page:/mfa", userId: user.id, role: user.role });
    return (
      <AuthCard title="Two-step sign-in" footer={<SignOutButton variant="link" />}>
        <div className="flex flex-col gap-4">
          <FormMessage notice={{ message: unexpectedMessage(ref), ref }} />
          <a
            href={next ? `/mfa?next=${encodeURIComponent(next)}` : "/mfa"}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Try again
          </a>
        </div>
      </AuthCard>
    );
  }

  const destination = destinationFor(user.role, next);
  const hasAuthenticator = state.verified.length > 0;
  const step = mfaStep({ role: user.role, currentLevel: state.currentLevel, hasVerifiedFactor: hasAuthenticator });

  if (step === "challenge") {
    return (
      <AuthCard
        title="Enter your sign-in code"
        description="Open the authenticator app on your phone and enter the 6-digit code shown for TaxWise."
        footer={
          <div className="flex flex-col items-center gap-2">
            <p>Lost your phone? Ask a Partner to reset your two-step sign-in.</p>
            <SignOutButton variant="link" />
          </div>
        }
      >
        <MfaCodeForm factorId={state.verified[0].id} next={destination} />
      </AuthCard>
    );
  }

  const required = mfaRequiredFor(user.role);
  if (step === "enrol" || (wantsEnrol && !hasAuthenticator)) {
    return (
      <AuthCard
        size="md"
        title="Turn on two-step sign-in"
        description={
          required
            ? "Partners and Managers sign in with their password and a code from their phone. It keeps fees and clients' portal passwords safe."
            : "Each time you sign in, you'll also enter a code from your phone. It keeps your account safe if your password ever leaks."
        }
        footer={
          required ? (
            <SignOutButton variant="link" label="Sign out and do this later" />
          ) : (
            <Link href={destination} className="font-medium text-primary underline-offset-4 hover:underline">
              Not now
            </Link>
          )
        }
      >
        <MfaEnrol next={destination} />
      </AuthCard>
    );
  }

  redirect(destination);
}

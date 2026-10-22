import type { Metadata } from "next";
import { safeNextPath } from "@/lib/supabase/proxy";
import { AuthCard, TroubleLine } from "../_components/auth-card";
import type { FormNotice } from "../_components/use-auth-form";
import { LoginForm } from "./login-form";

// The one page search engines may index (§12); every other response carries X-Robots-Tag: noindex.
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: true, follow: false },
};

const NOTICES: Record<string, { notice: FormNotice; tone: "info" | "success" | "danger" }> = {
  idle: { notice: { message: "You were signed out after a long time without activity. Sign in again to carry on." }, tone: "info" },
  signed_out: { notice: { message: "You've signed out." }, tone: "success" },
  link: { notice: { message: "That link has expired or was already used. Use Forgot password to get a new one." }, tone: "danger" },
  password_set: { notice: { message: "Your password is saved. Sign in with it." }, tone: "success" },
};

/**
 * Sign in (§3.5). No sign-up link anywhere: the firm creates every login. Clients sign in here too;
 * their role sends them to the portal.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(first(params.next));
  const reason = first(params.reason) ?? first(params.error);
  const message = reason ? NOTICES[reason] : undefined;

  return (
    <AuthCard title="Sign in to TaxWise" footer={<TroubleLine />}>
      <LoginForm next={next} notice={message?.notice ?? null} noticeTone={message?.tone ?? "info"} />
    </AuthCard>
  );
}

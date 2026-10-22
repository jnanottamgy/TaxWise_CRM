import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { UserXIcon } from "lucide-react";
import { getSession } from "@/lib/auth/current-user";
import { homePathFor } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { AuthCard } from "../_components/auth-card";
import { SignOutButton } from "../_components/sign-out-button";

export const metadata: Metadata = { title: "No access" };

/**
 * A session the app can't let in (§4.4, §0.1 rule 9): no profile yet, a disabled profile, or a
 * sign-in token whose role hint is missing or out of date. Always a clear page, never a crash.
 */
export default async function NoAccessPage() {
  const session = await getSession();
  if (session.status === "anonymous") redirect("/login");

  if (session.status === "ok") {
    // The profile is fine. If the token's role hint agrees, they belong at home; if not (it is
    // missing or changed), signing in again repairs it (§4.5 step 5).
    let hint: unknown = null;
    try {
      const { data } = await session.supabase.auth.getClaims();
      hint = (data?.claims?.app_metadata as Record<string, unknown> | undefined)?.role ?? null;
    } catch {
      hint = null;
    }
    if (hint === session.user.role) redirect(homePathFor(session.user.role));
    return (
      <NoAccessCard
        title="Sign in again to continue"
        description="Your access was changed since you signed in. Sign out, then sign in again to pick up the change."
        email={session.user.email}
      />
    );
  }

  let email: string | null = session.status === "no_profile" ? session.email : null;
  if (!email) {
    try {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      email = data.user?.email ?? null;
    } catch {
      email = null;
    }
  }

  if (session.status === "inactive") {
    return (
      <NoAccessCard
        title="Your access has been disabled"
        description="Ask a Partner if you think this is a mistake. Your work and history are kept."
        email={email}
      />
    );
  }

  return <NoAccessCard title="Your account isn't set up yet" description="Ask a Partner." email={email} />;
}

function NoAccessCard({ title, description, email }: { title: string; description: string; email: string | null }) {
  return (
    <AuthCard title={title} description={description}>
      <div className="flex flex-col gap-5">
        {email ? (
          <p className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm text-text">
            <UserXIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
            <span className="min-w-0">
              Signed in as <span className="font-medium break-all">{email}</span>
            </span>
          </p>
        ) : null}
        <SignOutButton variant="default" className="w-full" />
      </div>
    </AuthCard>
  );
}

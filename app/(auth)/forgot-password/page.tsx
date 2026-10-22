import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { AuthCard } from "../_components/auth-card";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

/** Forgot password (§4.4): Supabase emails a one-time link to /auth/confirm, then /reset-password. */
export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  const params = await searchParams;
  const raw = Array.isArray(params.email) ? params.email[0] : params.email;
  const initialEmail = typeof raw === "string" && raw.length <= 254 ? raw.trim() : "";

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email you sign in with. We'll send you a link to choose a new password."
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
      <ForgotPasswordForm initialEmail={initialEmail} />
    </AuthCard>
  );
}

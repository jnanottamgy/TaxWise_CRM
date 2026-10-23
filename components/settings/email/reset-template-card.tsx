import { CopyButton } from "@/components/app/copy-button"

/**
 * Settings → Email → Password reset email (§10.2 "Supabase template, restyled with TaxWise
 * branding"; §4.4 the reset comes from Supabase's own mailer, so it works before Resend is
 * verified). The branded subject and HTML to paste into Supabase once. Server component.
 */
export function ResetTemplateCard({ subject, html }: { subject: string; html: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-base text-text">
        Supabase sends the &ldquo;Forgot password?&rdquo; email itself. To make it look like every other email from the firm, open Supabase →
        Authentication → Email templates → Reset password, and paste these in.
      </p>
      <dl className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <dt className="text-sm text-text-muted">Subject</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate text-base text-text">{subject}</span>
            <CopyButton value={subject} label="reset email subject" showText />
          </dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <dt className="text-sm text-text-muted">Message body (HTML)</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span className="text-sm text-text-muted">{Math.round(html.length / 100) / 10} KB, with the reset link placeholder</span>
            <CopyButton value={html} label="reset email HTML" showText />
          </dd>
        </div>
      </dl>
    </div>
  )
}

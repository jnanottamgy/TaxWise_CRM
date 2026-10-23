import Link from "next/link"
import { MailWarningIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { EMAIL_NOT_SET_UP_MESSAGE } from "@/lib/handoff"

/**
 * The banner §7.13.5 asks for wherever an automatic email would go while the sending domain isn't
 * verified: "Email isn't set up yet. Use WhatsApp or Gmail, or finish email setup." Partners get a
 * link to Settings → Email (only they can set it up, §4.1); everyone else is told who can. Put the
 * WhatsApp and Gmail hand-off buttons right after it. Server-safe.
 *
 *   const email = await getEmailReadiness(supabase)          // server/email/readiness.ts
 *   {!email.ready ? <EmailSetupBanner canSetUp={user.role === "partner"} /> : null}
 */
export function EmailSetupBanner({ canSetUp, className }: { canSetUp: boolean; className?: string }) {
  return (
    <div role="note" className={cn("flex gap-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-base text-text", className)}>
      <MailWarningIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
      <p className="min-w-0">
        {EMAIL_NOT_SET_UP_MESSAGE}{" "}
        {canSetUp ? (
          <Link href="/settings/email" className="font-medium text-primary underline-offset-4 hover:underline">
            Finish email setup
          </Link>
        ) : (
          <span className="text-text-muted">A Partner sets it up in Settings → Email.</span>
        )}
      </p>
    </div>
  )
}

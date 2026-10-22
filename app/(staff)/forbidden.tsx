import Link from "next/link";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Not available for your role" };

/**
 * 403 inside the firm's app (§4.1): a page this role may not open, refused by the page guard
 * (lib/auth/guards.ts denyAccess → forbidden()). The shell stays on screen, so the person keeps
 * their navigation. Says what happened and where to go; never which role would see it.
 */
export default function StaffForbidden() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <LockIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Not available for your role</h1>
            <p className="mt-1 text-base text-text-muted">
              Your role can&apos;t open this page. If you need it for your work, ask a Partner.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button asChild>
            <Link href="/">Go to my home page</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

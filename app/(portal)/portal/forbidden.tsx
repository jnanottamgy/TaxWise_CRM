import Link from "next/link";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Not available" };

/** 403 inside the client portal (§7.22): something this portal login may not open. */
export default function PortalForbidden() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <LockIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Not available</h1>
            <p className="mt-1 text-base text-text-muted">
              This isn&apos;t part of your portal. If you think it should be, message your accountant.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button asChild>
            <Link href="/portal">Back to your portal</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

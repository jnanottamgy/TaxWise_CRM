import Link from "next/link";
import { ErrorBlock } from "@/components/app/error-block";
import { Button } from "@/components/ui/button";
import { PoweredBy, TwMonogram } from "./brand";

/**
 * What a layout renders when it cannot even confirm who is signed in (the auth service or database
 * is unreachable). It never throws (§0.1 rule 3): one sentence, the Ref, Retry, and a way back to
 * sign-in.
 */
export function ShellUnavailable({ errorRef, area }: { errorRef: string; area: "staff" | "portal" }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex h-14 items-center gap-2.5 bg-brand-navy px-5 text-white">
          <TwMonogram className="size-8" />
          <span className="text-base font-semibold tracking-[-0.01em]">TaxWise Consultants</span>
        </div>
        <div className="px-5 pt-5">
          <h1 className="text-lg font-semibold text-text">We couldn&apos;t open {area === "portal" ? "your portal" : "TaxWise"}</h1>
        </div>
        <ErrorBlock
          className="px-5 pt-2 pb-4"
          message="TaxWise couldn't confirm your sign-in just now. This is usually brief."
          errorRef={errorRef}
        />
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button asChild variant="outline" size="sm">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </div>
      <PoweredBy className="mt-6" />
    </div>
  );
}

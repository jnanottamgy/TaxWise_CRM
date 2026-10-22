import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { denyAccess } from "@/lib/auth/guards"
import { DIAGNOSTIC_CHECKS, diagnosticsAccess, diagnosticsContext } from "@/server/diagnostics"
import { DiagnosticsRunner } from "@/components/settings/diagnostics-runner"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionHeader } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Diagnostics · Settings" }

/**
 * Settings → Diagnostics (§7.24, §0.1 rule 1). Partner only, gated on the Supabase session alone
 * (server/diagnostics.ts diagnosticsAccess), not on the profiles table, so it still opens when the
 * database is the thing that's broken. The checks run one at a time from the browser.
 */
export default async function DiagnosticsPage() {
  const access = await diagnosticsAccess()
  if (!access.ok) {
    if (access.reason === "anonymous") redirect("/login?next=/settings/diagnostics")
    if (access.reason === "forbidden") denyAccess()
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SectionHeader
        title="Diagnostics"
        description="Whether this deployment's database, schema, storage, email, environment and scheduled jobs are as the code expects."
      />
      {access.ok ? (
        <DiagnosticsRunner checks={DIAGNOSTIC_CHECKS.map((c) => ({ id: c.id, label: c.label, description: c.description }))} context={diagnosticsContext()} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message={access.message} errorRef={access.ref} />
        </div>
      )}
    </div>
  )
}

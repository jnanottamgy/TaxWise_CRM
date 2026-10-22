import { unstable_rethrow } from "next/navigation"
import { DatabaseIcon } from "lucide-react"
import { logUnexpected } from "@/lib/log"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"

/**
 * Loads a settings section's data and renders it, or the block's error with its Ref (§0.1 rule 2:
 * nothing unexpected reaches the user as a crash). Framework signals (redirect, notFound) pass
 * through. Server-only.
 */
export async function loadSection<T>(source: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:settings:${source}` }) }
  }
}

export function SectionHeader({ title, description, actions }: { title: string; description: React.ReactNode; actions?: React.ReactNode }) {
  return <PageHeader title={title} description={description} actions={actions} />
}

export function SectionLoadError({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

/** The firm_settings row is missing: the database hasn't been seeded (§16). */
export function SettingsMissing() {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <EmptyState
        icon={<DatabaseIcon />}
        message="The firm's settings row is missing, so there is nothing to edit yet. Whoever set up the database needs to run the database seed; Diagnostics shows what else is missing."
      />
    </div>
  )
}

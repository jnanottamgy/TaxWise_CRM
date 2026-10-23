import type { Metadata } from "next"
import { ShieldCheckIcon } from "lucide-react"
import { requireClient } from "@/lib/auth/guards"
import { safeNextPath } from "@/lib/supabase/proxy"
import { readParam } from "@/components/app/data-table/params"
import { formatDate, formatDateTime } from "@/lib/format"
import { getFirmContact, getNoticeState } from "@/lib/data/portal"
import { PageHeader } from "@/components/app/page-header"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { attempt } from "@/components/portal/load"
import { PortalBlockError } from "@/components/portal/portal-ui"
import { PrivacyNotice } from "@/components/portal/privacy-notice"
import { WelcomeForm } from "@/components/portal/welcome-form"

export const metadata: Metadata = { title: "Privacy notice" }

/**
 * /portal/welcome (§6.10, §7.22 first sign-in): the current privacy notice and its acknowledgement,
 * before anything else in the portal. The layout sends every portal page here until the client
 * acknowledges the published version; acknowledging writes a consent record and opens the portal.
 * Once acknowledged, the page shows the notice for reference with when it was acknowledged (Help
 * links here). Links out are full page loads, so the layout checks the gate again.
 */
/** Where to go after acknowledging: a portal page the client was sent from, never outside the portal. */
function nextPortalPath(raw: string | null): string {
  const p = safeNextPath(raw)
  if (!p || !/^\/portal(?:[/?#]|$)/.test(p) || /^\/portal\/welcome(?:[/?#]|$)/.test(p)) return "/portal"
  return p
}

export default async function PortalWelcomePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireClient()
  const next = nextPortalPath(readParam(await props.searchParams, "next"))
  const [state, firm] = await Promise.all([
    attempt("welcome:notice", user.id, () => getNoticeState(supabase, user.id)),
    attempt("welcome:firm", user.id, () => getFirmContact(supabase)),
  ])
  const firmName = firm.ok ? firm.data.firmName : "the firm"

  if (!state.ok) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Privacy notice" />
        <PortalBlockError title="Privacy notice" message="Couldn't load the privacy notice." errorRef={state.ref} />
      </div>
    )
  }

  const { notice, acknowledgedAt } = state.data
  if (!notice) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Privacy notice" />
        <section className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={<ShieldCheckIcon />}
            message={`${firmName} hasn't published its privacy notice in the portal yet. We'll ask you to read it here once it's ready.`}
            action={
              <Button asChild variant="outline">
                <a href="/portal">Go to your portal</a>
              </Button>
            }
          />
        </section>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Privacy notice"
        description={
          acknowledgedAt
            ? `Version ${notice.version}. You acknowledged it on ${formatDateTime(acknowledgedAt)}.`
            : `Before you use the portal, please read how ${firmName} handles your personal data. Version ${notice.version}${notice.publishedAt ? `, published ${formatDate(notice.publishedAt)}` : ""}.`
        }
        actions={
          acknowledgedAt ? (
            <Button asChild variant="outline">
              <a href="/portal">Back to your portal</a>
            </Button>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <article aria-label={`Privacy notice, version ${notice.version}`} className="rounded-lg border border-border bg-surface px-4 py-5 md:px-6 lg:col-span-2">
          <PrivacyNotice body={notice.body} />
        </article>
        {acknowledgedAt ? null : (
          <aside aria-label="Acknowledge the privacy notice" className="lg:sticky lg:top-32 lg:self-start">
            <div className="rounded-lg border border-border bg-surface px-4 py-5 md:px-5">
              <h2 className="text-md font-semibold text-text">Your acknowledgement</h2>
              <p className="mt-1 mb-4 text-sm text-text-muted">We record the version, the date and time, and where you acknowledged it from.</p>
              <WelcomeForm version={notice.version} firmName={firmName} next={next} />
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

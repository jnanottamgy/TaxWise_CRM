import type { Metadata } from "next"
import Link from "next/link"
import { ChevronDownIcon } from "lucide-react"
import { requireClient } from "@/lib/auth/guards"
import { getFirmContact, getPortalClient } from "@/lib/data/portal"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { CopyButton } from "@/components/app/copy-button"
import { attempt } from "@/components/portal/load"
import { PortalBlockError } from "@/components/portal/portal-ui"
import { FirmContact, OwnerContact } from "@/components/portal/contact-card"
import { PORTAL_FAQ } from "@/components/portal/help-faq"

export const metadata: Metadata = { title: "Help" }

/**
 * Help (§7.22): answers to the questions clients ask, and the firm's contact details from
 * public_firm_profile (the public subset of the firm's settings, §4.6), with the client's own
 * accountant first.
 */
export default async function PortalHelpPage() {
  const { user, supabase } = await requireClient()
  const [firm, client] = await Promise.all([
    attempt("help:firm", user.id, () => getFirmContact(supabase)),
    attempt("help:client", user.id, () => getPortalClient(supabase)),
  ])

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader title="Help" description="How the portal works, and how to reach us." />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:gap-6">
        <SectionCard title="Questions" className="lg:col-span-2" flush>
          <div className="divide-y divide-border/70 border-t border-border">
            {PORTAL_FAQ.map((q) => (
              <details key={q.id} id={q.id} className="group scroll-mt-32">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-base font-medium text-text outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
                  {q.question}
                  <ChevronDownIcon aria-hidden="true" className="size-4 flex-none text-text-muted transition-transform duration-150 group-open:rotate-180" />
                </summary>
                <div className="flex max-w-[70ch] flex-col gap-2 px-4 pb-4 text-base text-text md:px-5">
                  {q.answer.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                  {q.link ? (
                    q.link.href === "/portal/welcome" ? (
                      // A full load: the privacy notice page sits outside the portal's navigation.
                      <a href={q.link.href} className="text-sm font-medium text-primary hover:underline">
                        {q.link.label}
                      </a>
                    ) : (
                      <Link href={q.link.href} className="text-sm font-medium text-primary hover:underline">
                        {q.link.label}
                      </Link>
                    )
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </SectionCard>

        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          {firm.ok ? (
            <SectionCard title="Contact us">
              <div className="flex flex-col gap-4">
                <OwnerContact owner={client.ok && client.data ? client.data.owner : null} />
                <div className="border-t border-border pt-4">
                  <FirmContact firm={firm.data} />
                </div>
                {firm.data.gstin ? (
                  <p className="flex items-center gap-1 border-t border-border pt-3 text-sm text-text-muted">
                    GSTIN <span className="num font-medium text-text tabular-nums">{firm.data.gstin}</span>
                    <CopyButton value={firm.data.gstin} label="the firm's GSTIN" />
                  </p>
                ) : null}
              </div>
            </SectionCard>
          ) : (
            <PortalBlockError title="Contact us" message="Couldn't load the firm's contact details." errorRef={firm.ref} />
          )}
          {client.ok && client.data ? (
            <SectionCard title="Your account">
              <dl className="flex flex-col gap-2 text-base">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-sm text-text-muted">Name</dt>
                  <dd className="text-right text-text">{client.data.legalName ?? client.data.displayName}</dd>
                </div>
                {client.data.clientCode ? (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-text-muted">Client code</dt>
                    <dd className="num flex items-center gap-1 text-text tabular-nums">
                      {client.data.clientCode}
                      <CopyButton value={client.data.clientCode} label="client code" />
                    </dd>
                  </div>
                ) : null}
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-sm text-text-muted">Signed in as</dt>
                  <dd className="min-w-0 truncate text-right text-text">{user.email}</dd>
                </div>
              </dl>
              <p className="mt-3 text-sm text-text-muted">To correct these details, send us a message.</p>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  )
}

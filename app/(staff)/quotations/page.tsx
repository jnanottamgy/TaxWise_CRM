import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { fromPaise } from "@/lib/domain/money"
import { formatNumber } from "@/lib/format"
import { statusOptions } from "@/lib/status"
import { parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { QUOTATION_FILTERS, QUOTATION_FLAGS, QUOTATION_FLAG_LABELS, QUOTATION_SORTABLE } from "@/lib/schemas/quotations"
import { getQuotationSummary, listQuotationAuthors, listQuotations } from "@/lib/data/quotations"
import { getLeadSummary } from "@/lib/data/leads"
import { GrowthSubnav } from "@/components/leads/growth-subnav"
import { QuotationsTable } from "@/components/quotations/quotations-table"
import { QuotationExportButton } from "@/components/quotations/quotation-export"

export const metadata: Metadata = { title: "Quotations" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/quotations:${source}`, userId }) }
  }
}

/**
 * Quotations (§7.5.2–§7.5.3): every quotation with its status (Draft, Pending approval, Approved,
 * Sent, Viewed, Accepted, Rejected, Expired, Superseded), total, validity, when it was sent and
 * opened. What needs someone comes first: approvals waiting (Partners), quotations out with clients,
 * follow-ups to hand off, accepted quotations not yet a client. The dashboards link here with
 * `?status=pending_approval` and `?status=sent,viewed`. Partners and Managers only (§4.1).
 */
export default async function QuotationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: QUOTATION_SORTABLE, defaultSort: { sort: "created_at", dir: "desc" }, filters: QUOTATION_FILTERS })
  const today = todayIST()
  const now = new Date().toISOString()

  const [list, summary, authors, leadSummary] = await Promise.all([
    attempt("list", user.id, () => listQuotations(supabase, t, { userId: user.id, today })),
    attempt("summary", user.id, () => getQuotationSummary(supabase)),
    attempt("authors", user.id, () => listQuotationAuthors(supabase)),
    attempt("lead-summary", user.id, () => getLeadSummary(supabase)),
  ])

  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: statusOptions("quotation_status") },
    ...(authors.ok && authors.data.length ? [{ id: "author", label: "Prepared by", options: authors.data.map((a) => ({ value: a.id, label: a.name })), searchable: true }] : []),
    { id: "flag", label: "Needs attention", options: QUOTATION_FLAGS.map((f) => ({ value: f, label: QUOTATION_FLAG_LABELS[f] })) },
  ]
  const s = summary.ok ? summary.data : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Quotations">
        <p>A quotation starts as a Draft and saves itself as you type. A Manager&apos;s quotation over the quotation approval limit goes to a Partner first; Partners approve, approve and send, or return it with comments.</p>
        <p className="mt-2">Send it by email (with a View quotation link and the PDF), or open it in Gmail or WhatsApp, or copy the link. The client accepts by typing their name, or declines with a reason. Follow-ups go on day 3, 7 and 14 while it is open; after its valid-until date it expires. To change a quotation that has gone out, revise it: the old link then stops taking responses.</p>
      </PageGuide>
      <GrowthSubnav
        active="quotations"
        counts={{
          leads: leadSummary.ok && leadSummary.data.followUpsDue ? { n: leadSummary.data.followUpsDue, label: "follow-ups due" } : null,
          quotations: s?.pendingApproval ? { n: s.pendingApproval, label: "waiting for approval" } : null,
        }}
      />
      <PageHeader
        title="Quotations"
        description={s ? `${formatNumber(s.awaitingResponse)} out with clients · ${formatNumber(s.draft)} in draft` : "Quotations in draft, waiting for approval, sent and answered."}
        actions={
          <Button asChild>
            <Link href="/quotations/new">
              <PlusIcon aria-hidden="true" />
              New quotation
            </Link>
          </Button>
        }
      />
      {s ? (
        <KpiStrip
          className="mb-4"
          aria-label="Quotations that need someone"
          items={[
            { label: "Waiting for approval", value: formatNumber(s.pendingApproval), sub: user.role === "partner" ? "Yours to approve or return" : "With the Partners", href: "/quotations?status=pending_approval" },
            { label: "Out with clients", value: <Money value={fromPaise(s.awaitingValuePaise)} compact />, sub: `${formatNumber(s.awaitingResponse)} sent or viewed, incl. GST`, href: "/quotations?status=sent,viewed" },
            { label: "Follow-ups to hand off", value: formatNumber(s.followUpsToHandOff), sub: "Email couldn't send them", href: "/quotations?flag=needs_handoff" },
            { label: "Accepted, not yet a client", value: formatNumber(s.acceptedNotConverted), sub: "Create the client to onboard", href: "/quotations?flag=not_converted" },
          ]}
        />
      ) : null}
      <FilterBar searchLabel="Search quotations" searchPlaceholder="Number, name, company, email or lead" filters={filters} exportSlot={<QuotationExportButton />} />
      {list.ok ? (
        <QuotationsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} now={now} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the quotations." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

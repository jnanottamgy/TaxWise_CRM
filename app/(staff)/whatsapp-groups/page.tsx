import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatCount, parseTableParams, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { PageGuide } from "@/components/shell/page-slots"
import { REGISTER_STATUSES, REGISTER_STATUS_LABEL } from "@/lib/domain/whatsapp"
import { REGISTER_FILTERS, REGISTER_SORTABLE } from "@/lib/schemas/whatsapp"
import { getDepartedPartnerNumbers, getLinksPerNumber, getRegisterSummary, listFirmNumbers, listWhatsAppRegister } from "@/lib/data/whatsapp"
import { RegisterTable } from "@/components/whatsapp/register-table"
import { LinksStrip } from "@/components/whatsapp/links-strip"

export const metadata: Metadata = { title: "WhatsApp groups" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/whatsapp-groups:${source}`, userId }) }
  }
}

const TONE = { none: "warning", to_create: "warning", active: "success", closed: "muted" } as const

/**
 * WhatsApp groups (§7.25.1, Partners and Managers): "Does every client have its WhatsApp group,
 * and who opened it last?" Every group with its status, members and when it was last opened, plus
 * every active client with no group yet; filters No group yet · To create · Active · Closed, and by
 * firm number (house rule 7: when a Partner leaves, this lists every group to remove their number
 * from). Above the list, PCs linked per number against WhatsApp's limit ("Staff office: 3 of 4").
 * Searched, sorted and paged in SQL (§2.3).
 */
export default async function WhatsAppGroupsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: REGISTER_SORTABLE, defaultSort: { sort: "status_rank", dir: "asc" }, filters: REGISTER_FILTERS })

  const [list, summary, links, numbers] = await Promise.all([
    attempt("list", user.id, () => listWhatsAppRegister(supabase, t)),
    attempt("summary", user.id, () => getRegisterSummary(supabase)),
    attempt("links", user.id, () => getLinksPerNumber(supabase)),
    attempt("numbers", user.id, () => listFirmNumbers(supabase)),
  ])
  const departed = numbers.ok ? await attempt("departed", user.id, () => getDepartedPartnerNumbers(supabase, numbers.data)) : null

  const numberOptions = numbers.ok ? numbers.data.filter((n) => n.number).map((n) => ({ value: n.id, label: n.label })) : []
  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: REGISTER_STATUSES.map((s) => ({ value: s, label: REGISTER_STATUS_LABEL[s], tone: TONE[s] })) },
    ...(numberOptions.length ? [{ id: "number", label: "Has number", options: numberOptions, multi: false }] : []),
    { id: "primary", label: "Primary", options: [{ value: "1", label: "Primary groups only" }], multi: false },
  ]
  const numberId = t.filters.number?.[0] ?? null
  const numberFilter = numberId && numbers.ok ? (numbers.data.find((n) => n.id === numberId) ?? null) : null

  const s = summary.ok ? summary.data : null
  const description = s
    ? [
        `${formatCount(s.active)} active ${s.active === 1 ? "group" : "groups"}`,
        s.to_create ? `${formatCount(s.to_create)} to create` : null,
        s.none ? `${formatCount(s.none)} ${s.none === 1 ? "client" : "clients"} with no group yet` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Every client's WhatsApp group, its members and when it was last opened."

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageGuide title="WhatsApp groups">
        <p>Every client gets one WhatsApp group with the Partners&apos; numbers, the Managers&apos; office, the Staff office and the client&apos;s people. Each row opens the client&apos;s WhatsApp group tab, where the setup checklist and Open chat are.</p>
        <p className="mt-2">Filter by a firm number to see every group that holds it: when a Partner leaves, remove their number from each of those groups in WhatsApp, then select the groups here and record it.</p>
        <p className="mt-2">PCs linked per number counts the PCs where TaxWise Desktop has that number open. WhatsApp allows 4 linked devices per number, or 10 with Meta Verified multi-agent.</p>
      </PageGuide>
      <PageHeader title="WhatsApp groups" description={description} className="pb-0 md:pb-0" />

      {s ? (
        <KpiStrip
          aria-label="Groups by status"
          items={REGISTER_STATUSES.map((st) => ({
            label: REGISTER_STATUS_LABEL[st],
            value: <span className="num">{formatCount(s[st])}</span>,
            href: tableHref("/whatsapp-groups", { filters: { status: [st] } }),
          }))}
        />
      ) : summary.ok ? null : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't count the groups." errorRef={summary.ref} size="compact" />
        </div>
      )}

      {links.ok ? (
        <LinksStrip rows={links.data} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the PCs linked per number." errorRef={links.ref} size="compact" />
        </div>
      )}

      {departed && departed.ok && departed.data.length ? (
        <section aria-label="Numbers to remove" className="rounded-lg border border-border bg-surface px-4 py-3 md:px-5">
          <ul className="flex flex-col gap-1.5 text-sm">
            {departed.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-text">
                  <span className="font-medium">{d.label}</span> is still in <span className="num">{formatCount(d.groups)}</span> {d.groups === 1 ? "group" : "groups"}, but that Partner has left or the number is switched off. Remove it from each group in WhatsApp, then record it here.
                </span>
                <Link href={tableHref("/whatsapp-groups", { filters: { number: [d.id], status: ["active", "to_create"] } })} className="flex-none font-medium text-primary hover:underline">
                  Show the groups
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <FilterBar searchLabel="Search groups" searchPlaceholder="Client, code or group name" filters={filters} />
        {list.ok ? (
          <RegisterTable
            rows={list.data.rows}
            total={list.data.total}
            page={t.page}
            pageSize={t.pageSize}
            sort={t.sort}
            dir={t.dir}
            numberFilter={numberFilter ? { id: numberFilter.id, label: numberFilter.label } : null}
          />
        ) : (
          <div className="rounded-lg border border-border bg-surface">
            <ErrorBlock message="Couldn't load the WhatsApp groups." errorRef={list.ref} />
          </div>
        )}
      </div>
    </div>
  )
}

import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { getSelectedFy, fyOptions } from "@/lib/fy-context"
import { istDateOf, todayIST } from "@/lib/domain/fy"
import { formatINR, fromPaise, toPaise } from "@/lib/domain/money"
import { pickContactForService, pickWhatsAppNumber } from "@/lib/domain/messaging"
import { TDS_CREDIT_STATUSES, TDS_CREDIT_STATUS_INFO, tdsCorrectionDraft } from "@/lib/domain/collections"
import { TDS_CREDIT_FILTERS, TDS_CREDIT_SORTABLE, TDS_SOURCE_LABEL, type TdsSource } from "@/lib/schemas/collections"
import { getMessagingContext } from "@/lib/data/clients"
import {
  getTdsDraftClients,
  getTdsReturnRules,
  getTdsSummary,
  listNotReflected,
  listStatementIssues,
  listTdsCredits,
  listTdsImports,
  type TdsCreditRow,
  type TdsImportRow,
} from "@/lib/data/tds-credits"
import type { ServerSupabase } from "@/lib/supabase/server"
import { formatCount, parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { TdsTable } from "@/components/collections/tds-table"
import { TdsImportButton } from "@/components/collections/tds-import-dialog"
import { StatementIssues, TdsCorrections, type CorrectionGroup } from "@/components/collections/tds-mismatches"
import { BlockError, ViewTabs } from "@/components/collections/ui"
import { formatDate } from "@/lib/format"

export const metadata: Metadata = { title: "TDS credits" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/tds-credits:${source}`, userId }) }
  }
}

/**
 * TDS credits (§7.9.9): "Is the TDS our clients deducted showing in our 26AS, and have we claimed
 * it?" Every receipt with TDS in the selected FY, Expected → Reflected (26AS / AIS, Form 168 under
 * the 2025 Act) → Claimed; marked by hand or by importing the statement, which matches lines by the
 * deductor's TAN and amount. The Mismatches view lists credits that should show by now and don't
 * (with WhatsApp drafts asking the client to correct their TDS statement) and statement
 * lines that didn't match. Partners and Managers only (§4.1).
 */
export default async function TdsCreditsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const fy = await getSelectedFy()
  const today = todayIST()
  const tab = readParam(sp, "tab") === "mismatches" ? "mismatches" : "credits"

  const [summary, imports] = await Promise.all([
    attempt("summary", user.id, () => getTdsSummary(supabase, fy)),
    attempt("imports", user.id, () => listTdsImports(supabase, fy, 5)),
  ])
  const latest = imports.ok ? (imports.data[0] ?? null) : null

  const s = summary.ok ? summary.data : null
  const description = s
    ? s.expected.count + s.reflected.count + s.claimed.count
      ? `FY ${fy} · ${formatCount(s.expected.count + s.reflected.count + s.claimed.count)} credits · ${formatINR(s.expected.paise + s.reflected.paise + s.claimed.paise)} of TDS`
      : `FY ${fy} · no receipt has TDS on it yet`
    : `FY ${fy} · TDS deducted by clients on our fees`

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      {/* Opened from Invoices in the sidebar; the top bar names this page, not the list. */}
      <ShellTitle crumbs={[{ label: "Invoices", href: "/invoices" }, { label: "TDS credits" }]} />
      <PageGuide title="TDS credits">
        <p>
          Every receipt with TDS starts as Expected. It becomes Reflected when it shows in our Form 26AS or AIS (Form 168 under the Income-tax Act, 2025), and Claimed once it is claimed in our
          return.
        </p>
        <p className="mt-2">
          Import the 26AS text file or the AIS TDS table and each line is matched to our receipts by the deductor&apos;s TAN and amount; matched credits become Reflected. You can also mark
          credits by hand: select them in the list.
        </p>
        <p className="mt-2">
          Mismatches lists credits whose quarter&apos;s TDS statement was due before the latest import and still don&apos;t show, with a message asking the client to correct their statement,
          and statement lines that didn&apos;t match a receipt.
        </p>
      </PageGuide>
      <PageHeader title="TDS credits" description={description} className="pb-0 md:pb-0" actions={<TdsImportButton fy={fy} fyOptions={fyOptions(today)} />} />

      {s ? (
        <KpiStrip
          aria-label={`TDS credits in FY ${fy}`}
          items={[
            ...TDS_CREDIT_STATUSES.map((st) => ({
              label: TDS_CREDIT_STATUS_INFO[st].label,
              value: <Money value={fromPaise(s[st].paise)} compact />,
              sub: `${formatCount(s[st].count)} ${s[st].count === 1 ? "credit" : "credits"}`,
              href: `/tds-credits?status=${st}`,
            })),
            { label: "Without a TAN", value: formatCount(s.missingTan), sub: s.missingTan ? "can't be matched by the import" : "every credit has one", href: s.missingTan ? "/tds-credits?tan=missing" : undefined },
          ]}
        />
      ) : (
        <BlockError title="Totals" message="Couldn't load the TDS totals." errorRef={summary.ok ? null : summary.ref} />
      )}

      <div className="flex min-w-0 flex-col gap-4">
        <ViewTabs
          label="TDS credit views"
          active={tab}
          items={[
            { id: "credits", label: "Credits", href: "/tds-credits" },
            { id: "mismatches", label: "Mismatches", href: "/tds-credits?tab=mismatches" },
          ]}
        />
        {tab === "credits" ? (
          <CreditsView sp={sp} fy={fy} today={today} userId={user.id} supabase={supabase} quarters={s?.quarters ?? []} />
        ) : (
          <MismatchesView sp={sp} fy={fy} userId={user.id} supabase={supabase} user={user} latest={latest} importsRef={imports.ok ? null : imports.ref} />
        )}
        {imports.ok && imports.data.length ? <ImportHistory rows={imports.data} /> : null}
      </div>
    </div>
  )
}

async function CreditsView({ sp, fy, today, userId, supabase, quarters }: { sp: SearchParams; fy: string; today: string; userId: string; supabase: ServerSupabase; quarters: string[] }) {
  const t = parseTableParams(sp, { sortable: TDS_CREDIT_SORTABLE, defaultSort: { sort: "payment_date", dir: "desc" }, filters: TDS_CREDIT_FILTERS })
  const list = await attempt("list", userId, () => listTdsCredits(supabase, t, { fy }))
  return (
    <div className="flex min-w-0 flex-col">
      <FilterBar
        searchLabel="Search TDS credits"
        searchPlaceholder="Client, invoice, receipt or TAN"
        filters={[
          { id: "status", label: "Status", options: TDS_CREDIT_STATUSES.map((st) => ({ value: st, label: TDS_CREDIT_STATUS_INFO[st].label })) },
          { id: "quarter", label: "Quarter", options: (quarters.length ? quarters : [1, 2, 3, 4].map((n) => `Q${n} ${fy}`)).map((q) => ({ value: q, label: q })) },
          { id: "tan", label: "TAN", multi: false, options: [{ value: "missing", label: "No TAN yet" }] },
        ]}
      />
      {list.ok ? (
        <TdsTable rows={list.data.rows as TdsCreditRow[]} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} fy={fy} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the TDS credits." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}

async function MismatchesView({
  sp,
  fy,
  userId,
  supabase,
  user,
  latest,
  importsRef,
}: {
  sp: SearchParams
  fy: string
  userId: string
  supabase: ServerSupabase
  user: Parameters<typeof getMessagingContext>[1]
  latest: TdsImportRow | null
  importsRef: string | null
}) {
  const showIgnored = readParam(sp, "ignored") === "1"
  const latestOn = latest ? istDateOf(latest.createdAt) : null
  const [groups, issues] = await Promise.all([
    attempt("not_reflected", userId, () => loadCorrectionGroups(supabase, user, fy, latestOn)),
    attempt("issues", userId, () => listStatementIssues(supabase, fy, { includeIgnored: showIgnored })),
  ])
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      {importsRef ? (
        <BlockError title="Not showing in 26AS / AIS" message="Couldn't load the imported statements." errorRef={importsRef} />
      ) : groups.ok ? (
        <TdsCorrections groups={groups.data} latestImport={latest && latestOn ? { label: TDS_SOURCE_LABEL[latest.source as TdsSource] ?? "statement", on: latestOn } : null} />
      ) : (
        <BlockError title="Not showing in 26AS / AIS" message="Couldn't work out which credits haven't reflected." errorRef={groups.ref} />
      )}
      {issues.ok ? (
        <StatementIssues issues={issues.data} showIgnored={showIgnored} ignoredHref={showIgnored ? "/tds-credits?tab=mismatches" : "/tds-credits?tab=mismatches&ignored=1"} />
      ) : (
        <BlockError title="Statement lines that didn't match" message="Couldn't load the statement lines." errorRef={issues.ref} />
      )}
    </div>
  )
}

/** Credits that should show by now and don't, grouped by client, each with its correction draft. */
async function loadCorrectionGroups(supabase: ServerSupabase, user: Parameters<typeof getMessagingContext>[1], fy: string, latestOn: string | null): Promise<CorrectionGroup[]> {
  if (!latestOn) return []
  const rules = await getTdsReturnRules(supabase)
  const rows = await listNotReflected(supabase, fy, latestOn, rules)
  if (!rows.length) return []
  const byClient = new Map<string, TdsCreditRow[]>()
  for (const r of rows) {
    const list = byClient.get(r.client_id) ?? []
    list.push(r)
    byClient.set(r.client_id, list)
  }
  const [clients, messaging, firm] = await Promise.all([
    getTdsDraftClients(supabase, [...byClient.keys()]),
    getMessagingContext(supabase, user),
    supabase.from("firm_settings").select("pan").eq("id", 1).maybeSingle(),
  ])
  if (firm.error) throw firm.error
  const firmPan = firm.data?.pan ? String(firm.data.pan) : null

  const groups: CorrectionGroup[] = []
  for (const [clientId, items] of byClient) {
    const client = clients.get(clientId)
    const clientName = client?.name ?? items[0].client_name
    const contact = client ? pickContactForService(client.contacts) : null
    const whatsapp = client ? pickWhatsAppNumber(contact, client, { countryCode: messaging.countryCode }) : null
    const draft = tdsCorrectionDraft({
      contactName: contact?.name ?? null,
      clientName,
      firmName: messaging.firmName,
      firmPan,
      senderName: messaging.senderName,
      items: items.map((i) => ({ invoiceNumber: i.invoice_number, invoiceDate: i.invoice_date, tdsPaise: toPaise(i.tds_amount), section: i.tds_section, quarter: i.quarter })),
    })
    groups.push({
      clientId,
      clientName,
      contactId: contact?.id ?? null,
      contactName: contact?.name ?? null,
      whatsappNumber: whatsapp?.digits ?? null,
      items: items.map((i) => ({
        receiptId: i.id,
        invoiceId: i.invoice_id,
        invoiceNumber: i.invoice_number,
        receiptNumber: i.receipt_number,
        paymentDate: i.payment_date,
        quarter: i.quarter,
        section: i.tds_section,
        tan: i.deductor_tan,
        tdsPaise: toPaise(i.tds_amount),
      })),
      totalPaise: items.reduce((sum, i) => sum + toPaise(i.tds_amount), 0),
      body: draft.body,
    })
  }
  return groups.sort((a, b) => b.totalPaise - a.totalPaise || a.clientName.localeCompare(b.clientName))
}

function ImportHistory({ rows }: { rows: TdsImportRow[] }) {
  return (
    <section aria-label="Statements imported" className="text-sm text-text-muted">
      <h2 className="font-medium text-text">Imported this year</h2>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.id}>
            {TDS_SOURCE_LABEL[r.source as TdsSource] ?? r.source}
            {r.fileName ? ` (${r.fileName})` : ""} on {formatDate(istDateOf(r.createdAt))}
            {r.importedBy ? ` by ${r.importedBy}` : ""}: {formatCount(r.rows)} {r.rows === 1 ? "line" : "lines"}, {formatCount(r.matched)} matched
            {r.mismatches ? `, ${formatCount(r.mismatches)} with a different amount` : ""}
            {r.unmatched ? `, ${formatCount(r.unmatched)} not in our books` : ""}
          </li>
        ))}
      </ul>
    </section>
  )
}

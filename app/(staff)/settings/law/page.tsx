import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { todayIST } from "@/lib/domain/fy"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import {
  getLawSummary,
  listConcordance,
  listDueDateRules,
  listLawChanges,
  listOverrides,
  listParameters,
  listRuleChoices,
} from "@/lib/data/law"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { LawTabs, isLawTab, type LawTab } from "@/components/settings/law/law-tabs"
import { ReviewStamp } from "@/components/settings/law/review-stamp"
import {
  AddConcordanceButton,
  AddOverrideButton,
  AddParameterButton,
  ChangeLogTable,
  ConcordanceTable,
  OverridesTable,
  ParametersTable,
  RulesTable,
} from "@/components/settings/law/law-tables"
import { loadSection, SectionHeader, SectionLoadError } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Law & rules · Settings" }

const AWAITING_FILTER: FilterDef = {
  id: "status",
  label: "Confirmation",
  multi: false,
  options: [
    { value: "awaiting", label: "Awaiting partner confirmation", tone: "warning" },
    { value: "verified", label: "Verified", tone: "success" },
  ],
}

const RANGE_FILTER: FilterDef = {
  id: "range",
  label: "Rows",
  multi: false,
  options: [
    { value: "current", label: "In force and upcoming" },
    { value: "all", label: "Include past rows" },
  ],
}

/**
 * Settings → Law & rules (§5.12, §7.21): statutory parameters, due-date rules, government extensions
 * and the 1961 ↔ 2025 concordance, each with its legal source; [verify] items highlighted until a
 * Partner confirms them; changes from a date that never overwrite history; the change log; and the
 * "last reviewed on" stamp. Search, filters and paging run in SQL.
 */
export default async function LawSettingsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase } = await requirePartner()
  const sp = await props.searchParams
  const rawTab = readParam(sp, "tab")
  const tab: LawTab = isLawTab(rawTab) ? rawTab : "parameters"
  const t = parseTableParams(sp, { filters: { status: ["awaiting", "verified"], range: ["current", "all"] }, defaultPageSize: 50 })
  const today = todayIST()
  const status = t.filters.status?.[0]
  const verified = status === "awaiting" ? false : status === "verified" ? true : null
  const history = t.filters.range?.[0] === "all"
  const args = { q: t.q, verified, history, today, from: t.from, to: t.to }

  const [summary, list, rules] = await Promise.all([
    loadSection("law:summary", () => getLawSummary(supabase, today)),
    loadSection(`law:${tab}`, async () => {
      switch (tab) {
        case "parameters":
          return { tab, page: await listParameters(supabase, args) } as const
        case "rules":
          return { tab, page: await listDueDateRules(supabase, args) } as const
        case "extensions":
          return { tab, page: await listOverrides(supabase, args) } as const
        case "concordance":
          return { tab, page: await listConcordance(supabase, args) } as const
        case "log":
          return { tab, page: await listLawChanges(supabase, args) } as const
      }
    }),
    tab === "extensions" ? loadSection("law:rule-choices", () => listRuleChoices(supabase, today)) : Promise.resolve(null),
  ])

  const ruleChoices = rules && rules.ok ? rules.data : []
  const tableProps = { page: t.page, pageSize: t.pageSize, today }

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SectionHeader
        title="Law & rules"
        description="Rates, thresholds, due dates and section numbers the app works from, each with its legal source. A change starts from a date; history is kept."
      />

      {summary.ok ? (
        <ReviewStamp lastReviewedAt={summary.data.lastReviewedAt} lastReviewedByName={summary.data.lastReviewedByName} awaiting={summary.data.awaiting.total} />
      ) : (
        <SectionLoadError what="the review status" errorRef={summary.ref} />
      )}

      <div className="min-w-0">
        <LawTabs
          active={tab}
          awaiting={summary.ok ? { parameters: summary.data.awaiting.parameters, rules: summary.data.awaiting.rules, concordance: summary.data.awaiting.concordance } : {}}
        />
        <div className="pt-4">
          {tab === "log" ? null : (
            <FilterBar
              key={tab}
              searchLabel="Search law and rules"
              searchPlaceholder={
                tab === "parameters"
                  ? "Key, section, statute or source"
                  : tab === "rules"
                    ? "Code, title, form or source"
                    : tab === "extensions"
                      ? "Rule, period or circular"
                      : "Topic, section or form"
              }
              filters={tab === "extensions" ? [] : tab === "concordance" ? [AWAITING_FILTER] : [AWAITING_FILTER, RANGE_FILTER]}
              actions={
                tab === "parameters" ? <AddParameterButton /> : tab === "extensions" ? <AddOverrideButton rules={ruleChoices} /> : tab === "concordance" ? <AddConcordanceButton /> : null
              }
            />
          )}

          {!list.ok ? (
            <SectionLoadError what="this list" errorRef={list.ref} />
          ) : list.data.tab === "parameters" ? (
            <ParametersTable {...tableProps} rows={list.data.page.rows} total={list.data.page.total} />
          ) : list.data.tab === "rules" ? (
            <RulesTable {...tableProps} rows={list.data.page.rows} total={list.data.page.total} />
          ) : list.data.tab === "extensions" ? (
            <OverridesTable {...tableProps} rows={list.data.page.rows} total={list.data.page.total} rules={ruleChoices} />
          ) : list.data.tab === "concordance" ? (
            <ConcordanceTable {...tableProps} rows={list.data.page.rows} total={list.data.page.total} />
          ) : (
            <ChangeLogTable {...tableProps} rows={list.data.page.rows} total={list.data.page.total} />
          )}
        </div>
      </div>
    </div>
  )
}

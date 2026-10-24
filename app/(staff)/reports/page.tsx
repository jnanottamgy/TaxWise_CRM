import type { Metadata } from "next"
import Link from "next/link"
import {
  BriefcaseBusinessIcon,
  CalendarCheck2Icon,
  ChevronRightIcon,
  HandCoinsIcon,
  type LucideIcon,
  ReceiptIndianRupeeIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  UsersIcon,
  UserRoundCheckIcon,
} from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { isPartner } from "@/lib/auth/roles"
import { getSelectedFy } from "@/lib/fy-context"
import { REPORT_META, type ReportSlug } from "@/lib/schemas/reports"
import { PageHeader } from "@/components/app/page-header"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"

export const metadata: Metadata = { title: "Reports" }

const ICON: Record<ReportSlug, LucideIcon> = {
  compliance: CalendarCheck2Icon,
  work: BriefcaseBusinessIcon,
  practice: ShieldCheckIcon,
  clients: UsersIcon,
  pipeline: TrendingUpIcon,
  revenue: ReceiptIndianRupeeIcon,
  collections: HandCoinsIcon,
  people: UserRoundCheckIcon,
}

const GROUPS: ReadonlyArray<{ id: string; title: string; slugs: readonly ReportSlug[] }> = [
  { id: "delivery", title: "Delivery and compliance", slugs: ["compliance", "work", "practice"] },
  { id: "money", title: "Fees and collections", slugs: ["revenue", "collections"] },
  { id: "growth", title: "Clients and growth", slugs: ["clients", "pipeline"] },
  { id: "team", title: "Team", slugs: ["people"] },
]

function ReportCard({ slug }: { slug: ReportSlug }) {
  const meta = REPORT_META[slug]
  const Icon = ICON[slug]
  return (
    <li className="min-w-0">
      <Link
        href={`/reports/${slug}`}
        className="group flex h-full min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4 outline-none transition-colors duration-150 ease-out hover:border-text-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:p-5"
      >
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4 flex-none text-text-muted" />
          <span className="min-w-0 flex-1 text-md leading-6 font-semibold text-text">{meta.title}</span>
          <ChevronRightIcon aria-hidden="true" className="size-4 flex-none text-text-muted transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
        </div>
        <p className="text-sm font-medium text-text">{meta.question}</p>
        <p className="text-sm text-text-muted">{meta.counts}</p>
        <p className="mt-auto pt-1 text-sm text-text-muted">{meta.period === "fy" ? "Per financial year" : "Any period"} · Excel and PDF</p>
      </Link>
    </li>
  )
}

/**
 * The reports centre (§7.16): the eight reports, grouped by what they're about, each with the question
 * it answers and the one line on what it counts. Every report takes the period and its own filters and
 * exports to Excel and PDF. Partners and Managers only (§4.1).
 */
export default async function ReportsPage() {
  const { user } = await requireManagerOrPartner()
  const fy = await getSelectedFy()
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ShellTitle crumbs={[{ label: "Reports" }]} />
      <PageGuide title="Reports">
        <p>Each report opens on FY {fy}, to today while the year is running; change the period or narrow it to a client, owner, service or person from the bar above its figures. What the report counts is in the line under its title, and its Help panel explains each figure.</p>
        <p className="mt-2">Export gives the same figures with every row, as an Excel workbook or a PDF. Each export is recorded in the audit log.</p>
        {isPartner(user.role) ? (
          <p className="mt-2">
            For a copy of everything the CRM holds, use Full export in{" "}
            <Link href="/settings/data" className="font-medium text-primary hover:underline">
              Settings, Data
            </Link>
            .
          </p>
        ) : null}
      </PageGuide>
      <PageHeader title="Reports" description={`How the firm is doing on delivery, fees, clients and people. Each report opens on FY ${fy}.`} className="pb-0 md:pb-0" />

      {GROUPS.map((g) => (
        <section key={g.id} aria-labelledby={`reports-${g.id}`} className="flex min-w-0 flex-col gap-3">
          <h2 id={`reports-${g.id}`} className="text-sm font-semibold text-text-muted">
            {g.title}
          </h2>
          <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {g.slugs.map((s) => (
              <ReportCard key={s} slug={s} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { taxYearLabel, todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { getItrStatusCounts } from "@/lib/data/itr"
import { getNoticeCounts } from "@/lib/data/notices"
import { formatCount } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { ShellTitle } from "@/components/shell/page-slots"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Workpapers" }

type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/workpapers:${source}`, userId }) }
  }
}

type Figure = { label: string; value: number; href: string; danger?: boolean }

function Figures({ figures }: { figures: Figure[] }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-border border-t border-border sm:grid-cols-3">
      {figures.map((f) => (
        <div key={f.label} className="min-w-0">
          <Link href={f.href} className="block px-4 py-3 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5">
            <dt className="text-sm text-text-muted">{f.label}</dt>
            <dd className={cn("num mt-0.5 text-xl leading-8 font-semibold", f.danger && f.value > 0 ? "text-danger-text" : "text-text")}>{formatCount(f.value)}</dd>
          </Link>
        </div>
      ))}
    </dl>
  )
}

/**
 * Workpapers (§7.8): "Which workpapers are waiting on someone?" The four registers, each with the
 * counts that need action and a way in. Every count runs under the viewer's RLS (Employees: their
 * own clients, §4.1); each card catches its own failure.
 */
export default async function WorkpapersPage() {
  const { user, supabase } = await requireStaff()
  const today = todayIST()
  const fy = await getSelectedFy()

  const count = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: n, error } = await build()
    if (error) throw error
    return n ?? 0
  }

  const [recon, itr, fs, notices] = await Promise.all([
    attempt("recon", user.id, async () => {
      const [withOpen, months] = await Promise.all([
        count(() => supabase.from("gst_recon_runs_list").select("id", { count: "exact", head: true }).eq("is_latest", true).gt("open_count", 0)),
        count(() => supabase.from("gst_recon_runs_list").select("id", { count: "exact", head: true }).eq("is_latest", true)),
      ])
      return { withOpen, months }
    }),
    attempt("itr", user.id, () => getItrStatusCounts(supabase, fy)),
    attempt("fs", user.id, async () => {
      const [draft, reviewed, final] = await Promise.all(
        (["draft", "reviewed", "final"] as const).map((s) =>
          count(() => supabase.from("financial_statements_list").select("id", { count: "exact", head: true }).eq("status", s).eq("financial_year", fy)),
        ),
      )
      return { draft, reviewed, final }
    }),
    attempt("notices", user.id, () => getNoticeCounts(supabase, today)),
  ])

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={[{ label: "Workpapers" }]} />
      <PageHeader title="Workpapers" description={`GST reconciliation, ITR computations, financial statements and notices. Years follow the FY in the top bar (FY ${fy}).`} />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        <SectionCard title="GST reconciliation" description="GSTR-2B against the purchase register, client by client and month by month." viewAll={{ href: "/workpapers/gst-recon", label: "Open GST reconciliation" }} flush>
          {recon.ok ? (
            <Figures
              figures={[
                { label: "Months with open lines", value: recon.data.withOpen, href: "/workpapers/gst-recon" },
                { label: "Client-months reconciled", value: recon.data.months, href: "/workpapers/gst-recon" },
              ]}
            />
          ) : (
            <ErrorBlock message="Couldn't load the reconciliations." errorRef={recon.ref} size="compact" />
          )}
        </SectionCard>

        <SectionCard title="ITR computation" description={`Both regimes side by side, ${taxYearLabel(fy)}.`} viewAll={{ href: "/workpapers/itr", label: "Open ITR computations" }} flush>
          {itr.ok ? (
            <Figures
              figures={[
                { label: "Drafts", value: itr.data.draft, href: "/workpapers/itr?status=draft" },
                { label: "Reviewed, not final", value: itr.data.reviewed, href: "/workpapers/itr?status=reviewed" },
                { label: "Final", value: itr.data.final, href: "/workpapers/itr?status=final" },
              ]}
            />
          ) : (
            <ErrorBlock message="Couldn't load the ITR computations." errorRef={itr.ref} size="compact" />
          )}
        </SectionCard>

        <SectionCard title="Financial statements" description={`Schedule III from the trial balance, FY ${fy}.`} viewAll={{ href: "/workpapers/financial-statements", label: "Open financial statements" }} flush>
          {fs.ok ? (
            <Figures
              figures={[
                { label: "Drafts", value: fs.data.draft, href: "/workpapers/financial-statements?status=draft" },
                { label: "Reviewed, not final", value: fs.data.reviewed, href: "/workpapers/financial-statements?status=reviewed" },
                { label: "Final", value: fs.data.final, href: "/workpapers/financial-statements?status=final" },
              ]}
            />
          ) : (
            <ErrorBlock message="Couldn't load the financial statements." errorRef={fs.ref} size="compact" />
          )}
        </SectionCard>

        <SectionCard title="Notices" description="Replies, hearings and appeals, every year." viewAll={{ href: "/workpapers/notices", label: "Open the notices register" }} flush>
          {notices.ok ? (
            <Figures
              figures={[
                { label: "Replies overdue", value: notices.data.replyOverdue, href: "/workpapers/notices?attention=reply_overdue", danger: true },
                { label: "Due or heard in 7 days", value: notices.data.replyWeek + notices.data.hearingWeek, href: "/workpapers/notices?attention=reply_week,hearing_week" },
                { label: "Appeals to file", value: notices.data.appealOpen, href: "/workpapers/notices?attention=appeal_open" },
              ]}
            />
          ) : (
            <ErrorBlock message="Couldn't load the notices." errorRef={notices.ref} size="compact" />
          )}
        </SectionCard>
      </div>
    </div>
  )
}

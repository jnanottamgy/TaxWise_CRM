import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { FileDownIcon, FileTextIcon, LockIcon, MessageSquareWarningIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDate } from "@/lib/format"
import { comparativeYear, FS_STATUS_META, isFsTab, needsAttention, yearEndedLabel, type FsTab } from "@/lib/schemas/financial-statements"
import { getStatementDetail, type StatementDetail } from "@/lib/data/financial-statements"
import { readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { FsStatusChip } from "@/components/workpapers/fs/statements-table"
import { StatementEditor } from "@/components/workpapers/fs/statement-editor"

type Params = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Financial statements" }
    const s = await getSession()
    if (s.status !== "ok" || s.user.role === "client") return { title: "Financial statements" }
    const { data } = await s.supabase.from("financial_statements_list").select("client_name, financial_year").eq("id", id).maybeSingle()
    return { title: data ? `${data.client_name} · FY ${data.financial_year}` : "Financial statements" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Financial statements" }
  }
}

function people(d: StatementDetail): string {
  const r = d.row
  const parts = [`Year ended ${yearEndedLabel(r.financial_year)}`]
  if (r.prepared_by_name) parts.push(`prepared by ${r.prepared_by_name}`)
  if (r.reviewed_by_name && r.reviewed_at && r.status !== "draft") parts.push(`reviewed by ${r.reviewed_by_name} on ${formatDate(r.reviewed_at)}`)
  if (r.finalised_by_name && r.finalised_at && r.status === "final") parts.push(`final by ${r.finalised_by_name} on ${formatDate(r.finalised_at)}`)
  return parts.join(" · ")
}

/**
 * One client's financial statements for a year (§6.13, §7.8.3): "Do the accounts balance, and is
 * every ledger where it belongs?" The figures and the checks lead; the balance sheet, the profit
 * and loss, the notes, the ledger mapping and the inputs follow as tabs, with a live preview while
 * editing. Export the PDF on the letterhead or the Excel workbook. Any staff member who can see the
 * client (Employees: their own clients, §4.1); another client's statement is a 404 (RLS).
 */
export default async function FinancialStatementPage({ params, searchParams }: Params) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const sp = await searchParams

  let detail: StatementDetail | null
  try {
    detail = await getStatementDetail(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/workpapers/financial-statements/[id]", userId: user.id })
    const crumbs = [{ label: "Financial statements", href: "/workpapers/financial-statements" }, { label: "Statement" }]
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="Financial statements" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this statement." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail) notFound()

  const r = detail.row
  const fy = r.financial_year
  const crumbs = [
    { label: "Financial statements", href: "/workpapers/financial-statements" },
    { label: detail.client.name, href: `/workpapers/financial-statements?client=${detail.client.id}` },
    { label: `FY ${fy}` },
  ]
  const tabParam = readParam(sp, "tab")
  const initialTab: FsTab = isFsTab(tabParam) ? tabParam : detail.ledgers.some((l) => needsAttention(l)) && r.status !== "final" ? "ledgers" : "balance-sheet"
  const previousYear = detail.previousFigures ? comparativeYear(fy) : null
  const role = user.role === "partner" || user.role === "manager" ? user.role : "employee"
  const sourceFile = detail.sourceDocument ? { documentId: detail.sourceDocument.id, fileName: detail.sourceDocument.fileName } : null
  const editorKey = `${detail.sourceDocument?.id ?? detail.inputs.tb?.documentId ?? "none"}|${detail.ledgers.length}`

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="Financial statements">
        <p>Start on Ledger mapping: every ledger needs a Schedule III line. The app guesses from what this client chose before, keywords in the name and the TB group; check the low-confidence ones. Your choices are remembered for next year.</p>
        <p className="mt-2">The checks must all pass before the statement is final. Closing stock, drawings, the ageing schedules and the MSME dues go under Inputs and disclosures; the accounting policies under Notes.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={crumbs}
        title={`${detail.client.name} · FY ${fy}`}
        description={people(detail)}
        meta={<FsStatusChip status={r.status} variant="pill" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <a href={`/api/pdf/financial-statements/${r.id}`} target="_blank" rel="noopener">
                <FileTextIcon aria-hidden="true" />
                Export PDF
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={`/api/exports/financial-statements/${r.id}`}>
                <FileDownIcon aria-hidden="true" />
                Export Excel
              </a>
            </Button>
          </div>
        }
      />

      <p className="mb-4 text-sm text-text-muted">
        {detail.previous ? (
          <>
            Comparatives from the{" "}
            <Link href={`/workpapers/financial-statements/${detail.previous.id}`} className="text-primary hover:underline">
              FY {detail.previous.financialYear} statement
            </Link>{" "}
            ({FS_STATUS_META[detail.previous.status].label}
            {detail.previousFigures ? "" : ", no figures yet"}).
          </>
        ) : (
          <>No FY {comparativeYear(fy)} statement for this client: the previous-year column stays empty and the profit-to-reserves check is skipped.</>
        )}
      </p>

      {r.status === "draft" && detail.reviewNote ? (
        <div role="note" className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-base text-text">
          <MessageSquareWarningIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning-text" />
          <span className="min-w-0">
            <span className="font-medium">Back in Draft: </span>
            <span className="whitespace-pre-wrap">{detail.reviewNote}</span>
          </span>
        </div>
      ) : null}
      {r.status === "final" ? (
        <div role="note" className="mb-4 flex items-start gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-base text-text">
          <LockIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
          <span>Final and locked. Next year&apos;s statement takes its comparatives from it; a Manager or Partner can reopen it to make changes.</span>
        </div>
      ) : null}

      <StatementEditor
        key={editorKey}
        id={r.id}
        clientId={detail.client.id}
        financialYear={fy}
        status={r.status}
        updatedAt={detail.updatedAt}
        ledgers={detail.ledgers}
        inputs={detail.inputs}
        previousFigures={detail.previousFigures}
        previousYear={previousYear}
        viewer={{ id: user.id, role }}
        preparedBy={r.prepared_by}
        initialTab={initialTab}
        sourceFile={sourceFile}
      />
    </div>
  )
}

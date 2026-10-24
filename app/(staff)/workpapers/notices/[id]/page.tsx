import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDateTime } from "@/lib/format"
import { diffDays, todayIST } from "@/lib/domain/fy"
import { getStatus } from "@/lib/status"
import { APPEAL_DEFAULTS } from "@/lib/domain/escalation"
import { APPEAL_FORUM_LABEL, TAX_AREA_LABEL, isClosed, needsAppealDecision, nextNoticeAction, noticeYearLabel, presetFor, splitHearing, type NoticeFormInput } from "@/lib/schemas/notices"
import { getAppealPeriods, getNotice, getNoticeFormContext, type NoticeDetail } from "@/lib/data/notices"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { NoticeStatusChip, hearingText } from "@/components/workpapers/notices/notice-ui"
import { NoticeActions } from "@/components/workpapers/notices/notice-actions"
import { NoticeLog } from "@/components/workpapers/notices/notice-log"
import { NoticeDocuments } from "@/components/workpapers/notices/notice-documents"
import { AppealTaskLink } from "@/components/workpapers/notices/notice-status-dialog"

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Notice" }
    const s = await getSession()
    if (s.status !== "ok" || s.user.role === "client") return { title: "Notice" }
    const { data } = await s.supabase.from("tax_notices_list").select("notice_type, client_name").eq("id", id).maybeSingle()
    return { title: data ? `${data.notice_type} · ${data.client_name}` : "Notice" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Notice" }
  }
}

const BASE = [
  { label: "Workpapers", href: "/workpapers" },
  { label: "Notices", href: "/workpapers/notices" },
]

const NEXT_WORDS = { reply: "Reply due", hearing: "Hearing", appeal: "Last day to appeal" } as const

/**
 * One notice (§7.8.4): what it is and what it asks, the next date someone acts on, the dated log,
 * the notice / reply / order documents and, once closed against the client, the appeal: forum,
 * limitation date and the appeal task. Staff who can see the client (RLS); otherwise a 404.
 */
export default async function NoticePage({ params }: Params) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const today = todayIST()

  let detail: NoticeDetail | null = null
  try {
    detail = await getNotice(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/workpapers/notices/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={[...BASE, { label: "Notice" }]} />
        <PageHeader breadcrumbs={[...BASE, { label: "Notice" }]} title="Notice" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this notice." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail) notFound()
  const n = detail.row

  let ref: string | null = null
  let context: Awaited<ReturnType<typeof getNoticeFormContext>> = { staff: [], years: [], canAssignOthers: false }
  let periods = { periods: APPEAL_DEFAULTS, unverified: true }
  try {
    ;[context, periods] = await Promise.all([getNoticeFormContext(supabase, user, today), getAppealPeriods(supabase, n.order_date ?? today)])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/workpapers/notices/[id]:context", userId: user.id })
  }

  const role = user.role === "partner" ? "partner" : user.role === "manager" ? "manager" : "employee"
  const yearLabel = noticeYearLabel(n.financial_year)
  const crumbs = [...BASE, { label: n.notice_type }]
  const hearing = splitHearing(n.hearing_date)
  const closed = isClosed(n.status)
  const next = nextNoticeAction(
    {
      status: n.status,
      replyDueDate: n.reply_due_date,
      hearingOn: n.hearing_on,
      appealDecision: n.appeal_decision,
      limitationDate: n.limitation_date,
      appealFiled: n.appeal_task_status === "filed_done",
    },
    today,
  )
  const preset = presetFor(n.notice_type)
  const editInitial: NoticeFormInput = {
    id: n.id,
    updated_at: n.updated_at,
    client_id: n.client_id,
    type_choice: preset ? preset.value : "__other__",
    notice_type: n.notice_type,
    tax_area: n.tax_area ?? "",
    section: n.section ?? "",
    authority: n.authority ?? "",
    reference_no: n.reference_no ?? "",
    financial_year: n.financial_year ?? "",
    notice_date: n.notice_date ?? "",
    received_date: n.received_date ?? "",
    reply_due_date: n.reply_due_date ?? "",
    hearing_date: hearing.date,
    hearing_time: hearing.time,
    demand_amount: n.demand_amount === null ? "" : String(n.demand_amount),
    description: n.description ?? "",
    assigned_employee_id: n.assigned_employee_id ?? "",
    replied_on: n.replied_on ?? "",
    status: "open",
  }
  const clientLabel = `${n.client_code} · ${n.client_name}`
  const actions = ref ? null : (
    <NoticeActions
      notice={{
        id: n.id,
        updatedAt: n.updated_at,
        status: n.status,
        taxArea: n.tax_area,
        hearingDate: n.hearing_date,
        noticeDate: n.notice_date,
        orderDate: n.order_date,
        appealDecision: n.appeal_decision,
        appealForum: n.appeal_forum,
        limitationDate: n.limitation_date,
        limitationManual: n.limitation_manual,
        appealNote: n.appeal_note,
        clientId: n.client_id,
        label: `${n.notice_type} for ${n.client_name}`,
      }}
      editInitial={editInitial}
      formContext={context}
      clientLabel={clientLabel}
      role={role}
      appealPeriods={periods.periods}
      periodsUnverified={periods.unverified}
      today={today}
    />
  )

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="Notice">
        <p>The log keeps every step: notes you add, and the lines the app writes when dates move, the notice is reassigned, its status changes or a document is attached.</p>
        <p className="mt-2">Closing a notice against the client asks whether they will appeal; the appeal task is created with the last day to appeal as its due date.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={crumbs}
        title={n.notice_type}
        meta={<NoticeStatusChip status={n.status} variant="pill" />}
        description={[n.client_name, n.tax_area ? TAX_AREA_LABEL[n.tax_area] : null, yearLabel, n.assigned_name ? `Assigned to ${n.assigned_name}` : "Unassigned"].filter(Boolean).join(" · ")}
        actions={actions}
      />
      {ref ? (
        <div className="mb-4 rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the options for changing this notice." errorRef={ref} />
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          <SectionCard title="The notice">
            <DefinitionList
              columns={2}
              items={[
                { term: "Client", value: <Link href={`/clients/${n.client_id}?tab=workpapers`} className="text-text underline-offset-4 hover:underline">{clientLabel}</Link> },
                { term: "Section", value: n.section },
                { term: "Authority", value: n.authority },
                { term: "Reference / DIN", value: n.reference_no ? <MonoId value={n.reference_no} copy label="reference" /> : null },
                { term: "Year it is about", value: yearLabel ? `${yearLabel} (FY ${n.financial_year})` : null },
                { term: "Notice date", value: n.notice_date ? <DateText date={n.notice_date} /> : null },
                { term: "Received on", value: n.received_date ? <DateText date={n.received_date} /> : null },
                { term: "Reply due", value: n.reply_due_date ? <DateText date={n.reply_due_date} withRelative={n.reply_pending} today={today} /> : null },
                { term: "Replied on", value: n.replied_on ? <DateText date={n.replied_on} /> : null },
                { term: "Hearing", value: n.hearing_date ? hearingText(n.hearing_date) : null },
                { term: "Demand", value: n.demand_amount === null ? null : <Money value={n.demand_amount} /> },
                { term: "Logged by", value: n.created_by_name ? `${n.created_by_name}, ${formatDateTime(n.created_at)}` : formatDateTime(n.created_at) },
                { term: "Description", value: n.description ? <span className="whitespace-pre-line">{n.description}</span> : null, wide: true },
              ]}
            />
          </SectionCard>

          {closed ? (
            <SectionCard title="Outcome" description={getStatus("notice_status", n.status).meaning}>
              <DefinitionList
                columns={2}
                items={[
                  { term: "Outcome", value: getStatus("notice_status", n.status).label },
                  { term: "Order dated", value: n.order_date ? <DateText date={n.order_date} /> : null },
                  { term: "Closed", value: n.closed_at ? `${n.closed_by_name ?? "Someone"}, ${formatDateTime(n.closed_at)}` : null },
                  ...(needsAppealDecision(n.status)
                    ? [
                        { term: "Appeal", value: n.appeal_decision === "appeal" ? "The client will appeal" : n.appeal_decision === "no_appeal" ? "No appeal" : "Not decided" },
                        ...(n.appeal_decision === "appeal"
                          ? [
                              { term: "Forum", value: n.appeal_forum ? APPEAL_FORUM_LABEL[n.appeal_forum] : null },
                              {
                                term: "Last day to appeal",
                                value: n.limitation_date ? (
                                  <span className="inline-flex flex-col">
                                    <DateText date={n.limitation_date} withRelative={n.appeal_open} today={today} />
                                    <span className="text-xs text-text-muted">{n.limitation_manual ? "Entered by hand" : "From the order date and the Law & rules period"}</span>
                                  </span>
                                ) : null,
                              },
                              {
                                term: "Appeal task",
                                value: n.appeal_task_id ? (
                                  <span>
                                    <AppealTaskLink id={n.appeal_task_id} number={n.appeal_task_number} />
                                    {n.appeal_task_status ? <span className="text-text-muted"> · {getStatus("task_status", n.appeal_task_status).label}</span> : null}
                                  </span>
                                ) : null,
                              },
                            ]
                          : [{ term: "Reason", value: n.appeal_note, wide: true }]),
                      ]
                    : []),
                ]}
              />
            </SectionCard>
          ) : null}

          <NoticeLog noticeId={n.id} notes={detail.notes} today={today} canDelete={role !== "employee"} closed={closed} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          <SectionCard title="Next">
            {next ? (
              <div>
                <p className="text-sm text-text-muted">{NEXT_WORDS[next.kind]}</p>
                <p className={next.overdue ? "text-xl leading-8 font-semibold text-danger-text" : "text-xl leading-8 font-semibold text-text"}>
                  <DateText date={next.date} />
                </p>
                <p className={next.overdue ? "text-sm text-danger-text" : "text-sm text-text-muted"}>
                  {next.overdue
                    ? `${-next.daysLeft} ${-next.daysLeft === 1 ? "day" : "days"} overdue`
                    : next.daysLeft === 0
                      ? "Today"
                      : next.daysLeft === 1
                        ? "Tomorrow"
                        : `In ${next.daysLeft} days`}
                  {next.kind === "hearing" && hearing.time ? ` · ${hearing.time}` : ""}
                </p>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                {closed ? "Closed. Nothing more is due." : n.status === "replied" ? `Replied${n.replied_on ? ` ${diffDays(today, n.replied_on)} days ago` : ""}. Waiting for the authority.` : "No date is pending."}
              </p>
            )}
          </SectionCard>
          <NoticeDocuments noticeId={n.id} clientId={n.client_id} taxArea={n.tax_area} financialYear={n.financial_year} documents={detail.documents} canUpload />
        </div>
      </div>
    </div>
  )
}

import { cn } from "@/lib/utils"
import { EMPTY, formatDate, formatDateTime } from "@/lib/format"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import type { NoticeStatus } from "@/lib/domain/enums"
import { TAX_AREA_LABEL, noticeYearLabel, type TaxArea } from "@/lib/schemas/notices"
import type { NoticeListRow } from "@/lib/data/notices"

/** Open · Reply drafted · Replied · Hearing · Closed (…), explained on hover (§3.6). Server-safe. */
export function NoticeStatusChip({ status, variant }: { status: NoticeStatus; variant?: "dot" | "pill" }) {
  return <StatusChip kind="notice_status" value={status} variant={variant} />
}

export function areaLabel(area: TaxArea | null | undefined): string {
  return area ? TAX_AREA_LABEL[area] : EMPTY
}

/** "GST DRC-01 · s.73/74 · ref. ZD2910260012345" for a row's second line. */
export function noticeSubline(r: Pick<NoticeListRow, "section" | "reference_no" | "financial_year">): string {
  return [r.section ? `s.${r.section.replace(/^s\.?\s*/i, "")}` : null, noticeYearLabel(r.financial_year), r.reference_no ? `ref. ${r.reference_no}` : null].filter(Boolean).join(" · ")
}

type NextKind = "reply" | "hearing" | "appeal"

/** What the next date is for, from the row (the view's next_action_date). */
export function nextKindOf(r: Pick<NoticeListRow, "next_action_date" | "reply_due_date" | "reply_pending" | "hearing_on" | "limitation_date" | "appeal_open">): NextKind | null {
  if (!r.next_action_date) return null
  if (r.reply_pending && r.reply_due_date === r.next_action_date) return "reply"
  if (r.hearing_on === r.next_action_date) return "hearing"
  if (r.appeal_open && r.limitation_date === r.next_action_date) return "appeal"
  return r.reply_pending ? "reply" : null
}

const NEXT_LABEL: Record<NextKind, string> = { reply: "Reply due", hearing: "Hearing", appeal: "Appeal by" }

/**
 * The next date someone acts on (§7.8.4): the reply due date while a reply is pending, the hearing,
 * or the limitation date while an appeal is still to be filed, with its relative urgency ("2 days
 * overdue" in red). Server-safe.
 */
export function NextActionCell({ row, today, stacked = true }: { row: NoticeListRow; today: string; stacked?: boolean }) {
  const kind = nextKindOf(row)
  if (!kind || !row.next_action_date) {
    return <span className="text-text-muted">{row.is_closed ? "Closed" : row.status === "replied" ? "Awaiting the authority" : EMPTY}</span>
  }
  return (
    <span className={cn("inline-flex flex-col leading-5", stacked ? "items-end" : "items-start")}>
      <span className="text-xs text-text-muted">{NEXT_LABEL[kind]}</span>
      <DateText date={row.next_action_date} withRelative stacked={stacked} today={today} />
    </span>
  )
}

/** "30 Oct 2026, 11:30" for a stored hearing. */
export function hearingText(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso) : EMPTY
}

export function dateOrDash(d: string | null | undefined): string {
  return d ? formatDate(d) : EMPTY
}

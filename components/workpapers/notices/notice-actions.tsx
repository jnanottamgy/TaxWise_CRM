"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowRightIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { getStatus } from "@/lib/status"
import type { NoticeStatus } from "@/lib/domain/enums"
import type { AppealForum, LimitationPeriod } from "@/lib/domain/escalation"
import { isClosed, needsAppealDecision, nextNoticeStep, noticeMoves, type NoticeFormInput } from "@/lib/schemas/notices"
import { deleteNotice } from "@/server/actions/notices"
import { NoticeFormDialog, type NoticeFormContext } from "@/components/workpapers/notices/notice-form-dialog"
import { NoticeStatusDialog, type StatusDialogNotice } from "@/components/workpapers/notices/notice-status-dialog"

/**
 * The notice's actions (§7.8.4): the usual next step as the primary button (Reply drafted → Replied
 * → Closed), Change status for any other move (reopening is a Partner's or Manager's), Edit, and
 * Delete for a notice logged by mistake (Partner/Manager). The database checks each again.
 */
export function NoticeActions({
  notice,
  editInitial,
  formContext,
  clientLabel,
  role,
  appealPeriods,
  periodsUnverified,
  today,
}: {
  notice: StatusDialogNotice & { clientId: string; label: string }
  editInitial: NoticeFormInput
  formContext: NoticeFormContext
  clientLabel: string
  role: "partner" | "manager" | "employee"
  appealPeriods: Record<AppealForum, LimitationPeriod>
  periodsUnverified: boolean
  today: string
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [statusTo, setStatusTo] = React.useState<NoticeStatus | "pick" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const moves = noticeMoves(notice.status, role)
  const next = nextNoticeStep(notice.status)
  const closed = isClosed(notice.status)
  const mp = role !== "employee"

  return (
    <>
      {mp ? (
        <Button type="button" variant="ghost" className="text-danger-text" onClick={() => setConfirmDelete(true)}>
          <Trash2Icon aria-hidden="true" />
          <span className="max-sm:sr-only">Delete</span>
        </Button>
      ) : null}
      <Button type="button" variant="outline" onClick={() => setEditing(true)}>
        <PencilIcon aria-hidden="true" />
        Edit
      </Button>
      {moves.length > 0 && (!next || moves.length > 1) ? (
        <Button type="button" variant={next ? "outline" : "default"} onClick={() => setStatusTo("pick")}>
          {closed && needsAppealDecision(notice.status) && !mp ? "Update the appeal" : closed ? "Reopen or update" : "Change status"}
        </Button>
      ) : null}
      {next ? (
        <Button type="button" onClick={() => setStatusTo(next)}>
          {next === "closed_favourable" ? <PlusIcon aria-hidden="true" /> : <ArrowRightIcon aria-hidden="true" />}
          {next === "closed_favourable" ? "Record the outcome" : `Mark ${getStatus("notice_status", next).label.toLowerCase()}`}
        </Button>
      ) : null}

      {editing ? (
        <NoticeFormDialog
          open
          onOpenChange={(o) => (!o ? setEditing(false) : undefined)}
          initial={editInitial}
          fixedClient={{ id: notice.clientId, label: clientLabel }}
          context={formContext}
        />
      ) : null}
      {statusTo ? (
        <NoticeStatusDialog
          notice={notice}
          role={role}
          initialStatus={statusTo === "pick" ? undefined : statusTo}
          appealPeriods={appealPeriods}
          periodsUnverified={periodsUnverified}
          today={today}
          onClose={() => setStatusTo(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this notice?"
        description={`${notice.label} and its log are removed from the register for good. Attached files stay in the client's documents, and any appeal task stays in the work tracker.`}
        confirmLabel="Delete notice"
        destructive
        onConfirm={async () => {
          const r = await deleteNotice({ id: notice.id })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success("Notice deleted.")
          router.push("/workpapers/notices")
        }}
      />
    </>
  )
}

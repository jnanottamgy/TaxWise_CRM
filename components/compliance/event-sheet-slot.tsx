import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { isManagerOrPartner } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { fyOptions } from "@/lib/fy-context"
import { getEventDetail, type EventDetail } from "@/lib/data/compliance"
import { loadHintContext } from "@/server/compliance/engine"
import { eventHints, workflowMoves, type EventHint, type WorkflowMove } from "@/components/compliance/logic/event"
import { EventSheet } from "@/components/compliance/event-sheet"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Opens the deadline named by `?event=<id>` (§7.7) on the page that renders this: loads it under the
 * viewer's RLS, works out its hints and the moves the viewer may make, and shows the sheet. Renders
 * nothing without the param; a malformed id or one the viewer can't see shows "no longer exists".
 * Never throws: a failed load shows its Ref inside the sheet.
 */
export async function EventSheetSlot({
  eventId,
  user,
  supabase,
  closeHref,
}: {
  eventId: string | null | undefined
  user: CurrentUser
  supabase: ServerSupabase
  closeHref: string
}) {
  if (!eventId) return null
  const today = todayIST()
  const manager = isManagerOrPartner(user.role)
  let detail: EventDetail | null = null
  let errorRef: string | null = null
  let hints: EventHint[] = []
  let moves: WorkflowMove[] = []
  let reminderDays = 7
  try {
    if (UUID.test(eventId)) {
      const [d, ctx, settings] = await Promise.all([
        getEventDetail(supabase, eventId, { manager }),
        loadHintContext(supabase, today),
        supabase.from("firm_settings").select("compliance_reminder_days").eq("id", 1).maybeSingle(),
      ])
      detail = d
      reminderDays = settings.data?.compliance_reminder_days ?? 7
      if (d) {
        const e = d.event
        hints = eventHints({ ...e, override_ref: d.override?.source_ref ?? null }, ctx)
        moves = workflowMoves({ workflow_status: e.workflow_status, status: e.status, is_statutory: e.is_statutory, client_id: e.client_id, has_filing: d.filings.length > 0 }, user.role)
      }
    }
  } catch (err) {
    unstable_rethrow(err)
    errorRef = logUnexpected(err, { source: "compliance:event-sheet", userId: user.id, role: user.role, eventId })
  }
  return (
    <EventSheet
      key={eventId}
      detail={detail}
      errorRef={errorRef}
      hints={hints}
      moves={moves}
      role={user.role}
      today={today}
      closeHref={closeHref}
      fyOptions={fyOptions(today)}
      reminderDays={reminderDays}
    />
  )
}

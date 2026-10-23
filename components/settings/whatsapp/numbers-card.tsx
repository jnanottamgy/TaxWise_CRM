"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ClipboardCheckIcon, PencilIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StatusChip } from "@/components/app/status-chip"
import { CopyButton } from "@/components/app/copy-button"
import { formatDate, formatTimeAgo } from "@/lib/format"
import { formatWhatsAppNumber } from "@/lib/domain/messaging"
import { DESKTOP_ROLE_LABEL, WHATSAPP_NUMBER_KIND_LABEL, devicesReviewDue, linkedLabel, type DesktopRole, type WhatsAppNumberKind } from "@/lib/domain/whatsapp"
import type { FirmNumberRow, LinksPerNumber, PersonOption } from "@/lib/data/whatsapp"
import { recordWhatsAppDevicesReview } from "@/server/actions/whatsapp-settings"
import { NumberSheet } from "@/components/settings/whatsapp/number-sheet"

/**
 * Settings → WhatsApp → Firm WhatsApp numbers (§7.21, §5.13): the five seeded slots and any other
 * number, each with its kind, owner or custodian, whether it goes in every client group and as
 * admin, who may use it in TaxWise Desktop, two-step verification and the last linked-devices
 * review. Partners edit; the custodian (or a Partner) records the weekly review (house rule 5).
 * Everyone else reads. A list, not a table: two lines a number, so it reads the same on a phone.
 */
export function NumbersCard({
  numbers,
  canEdit,
  viewerEmployeeId,
  partners,
  staff,
  countryCode,
  links,
}: {
  numbers: FirmNumberRow[]
  canEdit: boolean
  viewerEmployeeId: string | null
  partners: PersonOption[]
  staff: PersonOption[]
  countryCode: string
  /** PCs linked per number (Partners and Managers), or null. */
  links: LinksPerNumber[] | null
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<FirmNumberRow | "new" | null>(null)
  const [reviewing, setReviewing] = React.useState<string | null>(null)
  const [now] = React.useState(() => new Date())
  const linkOf = new Map((links ?? []).map((l) => [l.number_id, l]))
  const active = numbers.filter((n) => n.is_active).length

  const review = async (n: FirmNumberRow) => {
    setReviewing(n.id)
    try {
      const r = await recordWhatsAppDevicesReview({ numberId: n.id })
      if (!r.ok) return void toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      toast.success(`Recorded: the ${n.label} phone's linked devices were checked.`)
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setReviewing(null)
    }
  }

  return (
    <section id="numbers" aria-labelledby="numbers-title" className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
        <div className="min-w-0">
          <h2 id="numbers-title" className="text-md leading-6 font-semibold text-text">
            Firm WhatsApp numbers
          </h2>
          <p className="mt-0.5 max-w-[72ch] text-sm text-text-muted">
            {active === 0
              ? "None is switched on yet. Fill in the three Partners' numbers, the Managers' office and the Staff office, then switch each on."
              : `${active} of ${numbers.length} switched on. The same firm numbers go in every client group, plus the client's people.`}
          </p>
        </div>
        {canEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            Add a number
          </Button>
        ) : null}
      </div>
      <ul>
        {numbers.map((n) => {
          const kind = WHATSAPP_NUMBER_KIND_LABEL[n.kind as WhatsAppNumberKind] ?? n.kind
          const who = n.usable_by.map((r) => DESKTOP_ROLE_LABEL[r as DesktopRole] ?? r).join(", ")
          const mayReview = n.is_active && (canEdit || (!!viewerEmployeeId && n.custodian_employee_id === viewerEmployeeId))
          const due = n.is_active && devicesReviewDue(n.devices_reviewed_at, now)
          const link = linkOf.get(n.id)
          const facts = [
            kind,
            n.kind === "partner" ? (n.owner_name ? `${n.owner_name}'s own number` : "No Partner chosen") : null,
            n.in_every_client_group ? "In every client group" : "Not added to client groups",
            n.group_admin ? "Group admin" : null,
            n.shared ? "Shared: staff sign their messages" : null,
            `TaxWise Desktop: ${who}`,
            link ? linkedLabel("Linked PCs", link.active_links, link.device_limit) : null,
          ].filter(Boolean)
          return (
            <li key={n.id} className="flex flex-col gap-1.5 border-t border-border/70 px-4 py-3 first:border-t-0 md:px-5">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-text">{n.label}</span>
                  {n.number ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="num text-text">{formatWhatsAppNumber(n.number)}</span>
                      <CopyButton value={formatWhatsAppNumber(n.number)} label={`${n.label} number`} />
                    </span>
                  ) : (
                    <span className="text-sm text-text-muted">No number yet</span>
                  )}
                  {n.is_active ? (
                    <StatusChip label="On" tone="success" meaning="On: staff can use this number in TaxWise Desktop, and the setup checklist adds it to new client groups." variant="pill" />
                  ) : (
                    <StatusChip label="Off" tone="muted" meaning="Off: not used yet. A Partner fills in the number and switches it on." variant="pill" />
                  )}
                </div>
                {canEdit ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(n)} aria-label={`Edit ${n.label}`}>
                    <PencilIcon aria-hidden="true" />
                    Edit
                  </Button>
                ) : null}
              </div>
              <p className="text-sm text-text-muted">{facts.join(" · ")}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                <span className={n.shared && !n.custodian_name && n.is_active ? "text-warning-text" : "text-text-muted"}>
                  Custodian: {n.custodian_name ?? "nobody named"}
                </span>
                <span className={n.is_active && !n.two_step_verification_on ? "text-warning-text" : "text-text-muted"}>
                  Two-step verification {n.two_step_verification_on ? "on" : "off"}
                </span>
                <span className={due ? "text-warning-text" : "text-text-muted"}>
                  Linked devices checked{" "}
                  {n.devices_reviewed_at ? (
                    <span className="num" title={formatDate(n.devices_reviewed_at)} suppressHydrationWarning>
                      {formatTimeAgo(n.devices_reviewed_at, now)}
                    </span>
                  ) : (
                    "never"
                  )}
                </span>
                {mayReview ? (
                  <Button type="button" variant="outline" size="xs" onClick={() => review(n)} disabled={reviewing === n.id}>
                    {reviewing === n.id ? <Spinner /> : <ClipboardCheckIcon aria-hidden="true" />}
                    Record review
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {editing ? (
        <NumberSheet open onOpenChange={(o) => !o && setEditing(null)} number={editing === "new" ? null : editing} partners={partners} staff={staff} countryCode={countryCode} />
      ) : null}
    </section>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { LaptopIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { formatDate, formatDateTime, formatTimeAgo } from "@/lib/format"
import { daysSince, isDeviceStale, STALE_DEVICE_DAYS } from "@/lib/domain/whatsapp"
import type { DeviceRow } from "@/lib/data/whatsapp"
import { removeDesktopPc, renameDesktopPc } from "@/server/actions/desktop-devices"
import { MemberChip } from "@/components/whatsapp/member-chips"

/**
 * Settings → WhatsApp → Linked PCs (§7.25.7): each PC running TaxWise Desktop, the firm numbers
 * linked on it, its last user and when it was last seen; a PC not seen for 30 days is flagged for
 * unlinking. Partners and Managers see it; a Partner renames a PC or removes it. Removing revokes the
 * PC (the desktop API refuses it and the app wipes its WhatsApp data at its next start), then this
 * reminds the Partner to remove it from each phone's Linked devices list too.
 */
export function LinkedPcsCard({ devices, canRemove }: { devices: DeviceRow[]; canRemove: boolean }) {
  const router = useRouter()
  const [now] = React.useState(() => new Date())
  const [removing, setRemoving] = React.useState<DeviceRow | null>(null)
  const [renaming, setRenaming] = React.useState<DeviceRow | null>(null)
  const [name, setName] = React.useState("")
  const [reminder, setReminder] = React.useState<{ deviceName: string; numbers: string[] } | null>(null)
  const live = devices.filter((d) => !d.revoked_at)
  const removed = devices.filter((d) => d.revoked_at)
  const stale = live.filter((d) => isDeviceStale(d, now)).length

  const remove = async () => {
    if (!removing) return false
    const r = await removeDesktopPc({ deviceId: removing.id })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    setReminder({ deviceName: r.data.deviceName, numbers: r.data.numbers })
    setRemoving(null)
    router.refresh()
  }

  const rename = async () => {
    if (!renaming) return false
    const r = await renameDesktopPc({ deviceId: renaming.id, name })
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    toast.success(`Renamed to ${r.data.name}`)
    setRenaming(null)
    router.refresh()
  }

  return (
    <section id="linked-pcs" aria-labelledby="linked-pcs-title" className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3.5 md:px-5">
        <h2 id="linked-pcs-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
          Linked PCs
        </h2>
        <p className="mt-0.5 max-w-[72ch] text-sm text-text-muted">
          {live.length === 0
            ? "No PC runs TaxWise Desktop yet."
            : `${live.length} ${live.length === 1 ? "PC" : "PCs"}${stale ? `, ${stale} not seen for ${STALE_DEVICE_DAYS} days or more` : ""}. Each phone's custodian checks its Linked devices list against this every week.`}
        </p>
      </div>
      {devices.length === 0 ? (
        <EmptyState icon={<LaptopIcon />} message="PCs appear here when someone signs in to TaxWise Desktop on them." />
      ) : (
        <ul>
          {[...live, ...removed].map((d) => {
            const isStale = !d.revoked_at && isDeviceStale(d, now)
            const days = daysSince(d.last_seen_at ?? d.created_at, now)
            return (
              <li key={d.id} className="flex flex-col gap-1.5 border-t border-border/70 px-4 py-3 first:border-t-0 md:px-5">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={d.revoked_at ? "font-medium text-text-muted" : "font-medium text-text"}>{d.device_name}</span>
                    {d.revoked_at ? (
                      <StatusChip label="Removed" tone="muted" meaning="Removed: the desktop API refuses this PC, and the app cleared its WhatsApp data at its next start." variant="pill" />
                    ) : isStale ? (
                      <StatusChip label={`Not seen for ${days} days`} tone="warning" meaning={`Flagged for unlinking: not seen for ${STALE_DEVICE_DAYS} days or more. Remove it here and from the phone's Linked devices list.`} variant="pill" />
                    ) : null}
                    {d.failing_checks?.length && !d.revoked_at ? (
                      <StatusChip label="Client mode unavailable" tone="danger" meaning={`WhatsApp changed its page, so client mode fails closed on this PC (${d.failing_checks.join(", ")}). Update TaxWise Desktop.`} variant="pill" />
                    ) : null}
                  </div>
                  {canRemove && !d.revoked_at ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${d.device_name}`}>
                          <MoreHorizontalIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            setName(d.device_name)
                            setRenaming(d)
                          }}
                        >
                          <PencilIcon aria-hidden="true" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(d)}>
                          <Trash2Icon aria-hidden="true" />
                          Remove PC
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {d.links.length && !d.revoked_at ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Numbers linked">
                    {d.links.map((l) => (
                      <li key={l.link_id}>
                        <MemberChip member={{ id: l.link_id, kind: "firm_number", firm_kind: l.kind, display_name: l.label, is_admin: false }} />
                      </li>
                    ))}
                  </ul>
                ) : !d.revoked_at ? (
                  <p className="text-sm text-text-muted">No firm number linked on this PC.</p>
                ) : null}
                <p className="text-sm text-text-muted" suppressHydrationWarning>
                  {[
                    d.os,
                    d.app_version ? `TaxWise Desktop ${d.app_version}` : null,
                    d.last_user_name ? `Last used by ${d.last_user_name}` : null,
                    d.revoked_at ? `Removed ${formatDate(d.revoked_at)}${d.revoked_by_name ? ` by ${d.revoked_by_name}` : ""}` : d.last_seen_at ? `Last seen ${formatTimeAgo(d.last_seen_at, now)}` : "Not seen yet",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {d.last_seen_at && !d.revoked_at ? <span className="sr-only">Last seen {formatDateTime(d.last_seen_at)}</span> : null}
              </li>
            )
          })}
        </ul>
      )}

      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove ${removing.device_name} from TaxWise Desktop?`}
          description={`The desktop API refuses this PC from now on, and at its next start TaxWise Desktop clears every WhatsApp login on it${removing.links.length ? ` (${removing.links.map((l) => l.label).join(", ")})` : ""}. Remove it from the phones' Linked devices lists too.`}
          confirmLabel="Remove PC"
          destructive
          onConfirm={remove}
        />
      ) : null}

      {renaming ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRenaming(null)}
          title="Rename the PC"
          description="The name shown here and in notices, such as FRONTDESK-2. TaxWise Desktop keeps it from now on."
          details={<Input aria-label="PC name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}
          confirmLabel="Rename"
          onConfirm={rename}
        />
      ) : null}

      {reminder ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setReminder(null)}
          title={`Now remove ${reminder.deviceName} from the phones`}
          description="WhatsApp still counts the PC as a linked device until it is logged out on the phone."
          details={
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-text">
              {(reminder.numbers.length ? reminder.numbers : ["each firm number it used"]).map((label) => (
                <li key={label}>
                  On the <span className="font-medium">{label}</span> phone, open WhatsApp → Settings → Linked devices, tap {reminder.deviceName} and choose Log out.
                </li>
              ))}
            </ol>
          }
          confirmLabel="Done"
          onConfirm={() => setReminder(null)}
        />
      ) : null}
    </section>
  )
}

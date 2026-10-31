"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckIcon, DownloadIcon, PencilIcon, UsersIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { CopyButton } from "@/components/app/copy-button"
import { MemberChip } from "@/components/whatsapp/member-chips"
import { formatDateTime } from "@/lib/format"
import {
  CHECKLIST_STEPS,
  checklistProgress,
  contactWhatsAppDigits,
  copyAllNumbersText,
  defaultSelectedContactIds,
  numbersToAdd,
  type ChecklistState,
  type ChecklistStepId,
  type ContactLike,
  type FirmNumberLike,
} from "@/lib/domain/whatsapp"
import { formatWhatsAppNumber } from "@/lib/domain/messaging"
import { saveWhatsAppContacts, tickWhatsAppStep } from "@/server/actions/whatsapp-groups"

/**
 * The seven-step setup checklist (§7.25.2), exactly in the spec's order. Each step is ticked and
 * stamped with who and when; step 7 (Mark created) is a form of its own. Partners and Managers tick
 * and choose contacts; everyone else sees the steps and the stamps, and can still copy and download.
 *
 * Ticks are optimistic: the box changes at once, and goes back with the reason if the save is
 * refused (someone else changed the group: "Reload to see their changes", §13).
 */

export interface ChecklistNumber extends FirmNumberLike {
  owner_name: string | null
}

export function SetupChecklist({
  clientId,
  groupId,
  groupName,
  status,
  updatedAt,
  onSaved,
  checklist,
  names,
  viewerId,
  canManage,
  firmNumbers,
  contacts,
  shortName,
  countryCode,
  welcomeText,
  onMarkCreated,
  onEditName,
}: {
  clientId: string
  groupId: string
  groupName: string
  status: "to_create" | "active" | "closed"
  /** The group's updated_at as this page last saw it. */
  updatedAt: string
  onSaved: (updatedAt: string) => void
  checklist: ChecklistState
  names: Record<string, string>
  viewerId: string
  canManage: boolean
  firmNumbers: ChecklistNumber[]
  contacts: ContactLike[]
  shortName: string
  countryCode: string
  welcomeText: string
  onMarkCreated: () => void
  onEditName: () => void
}) {
  const router = useRouter()
  const [state, setState] = React.useState<ChecklistState>(checklist)
  const [busy, setBusy] = React.useState<string | null>(null)
  const editable = canManage && status === "to_create"

  // A fresh server render (after router.refresh) replaces the local copy.
  const [seen, setSeen] = React.useState(checklist)
  if (seen !== checklist) {
    setSeen(checklist)
    setState(checklist)
  }

  const ownerNames = React.useMemo(() => new Map(firmNumbers.filter((n) => n.employee_id && n.owner_name).map((n) => [n.employee_id!, n.owner_name!])), [firmNumbers])
  const selected = state.contactIds ?? defaultSelectedContactIds(contacts, countryCode)
  const list = numbersToAdd({ firmNumbers, contacts, selectedContactIds: selected, shortName, countryCode, ownerNames })
  const firmList = list.filter((n) => n.kind === "firm_number")
  const progress = checklistProgress(state)
  const managers = firmNumbers.filter((n) => n.kind === "managers_office" && n.is_active && n.number)

  const fail = (r: { error: string; ref?: string }) => toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)

  const tick = async (step: Exclude<ChecklistStepId, "mark_created">, done: boolean) => {
    if (!editable || busy) return
    const before = state
    setState({ ...state, steps: { ...state.steps, [step]: done ? { done: true, by: viewerId, at: new Date().toISOString() } : { done: false, by: null, at: null } } })
    setBusy(step)
    try {
      const r = await tickWhatsAppStep({ groupId, updatedAt, step, done })
      if (!r.ok) {
        setState(before)
        return fail(r)
      }
      onSaved(r.data.updatedAt)
      router.refresh()
    } catch {
      setState(before)
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setBusy(null)
    }
  }

  const toggleContact = async (contactId: string, on: boolean) => {
    if (!editable || busy) return
    const before = state
    const next = on ? [...new Set([...selected, contactId])] : selected.filter((id) => id !== contactId)
    setState({ ...state, contactIds: next })
    setBusy(`contact:${contactId}`)
    try {
      const r = await saveWhatsAppContacts({ groupId, updatedAt, contactIds: next })
      if (!r.ok) {
        setState(before)
        return fail(r)
      }
      onSaved(r.data.updatedAt)
      router.refresh()
    } catch {
      setState(before)
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setBusy(null)
    }
  }

  const stamp = (id: ChecklistStepId) => {
    const s = state.steps[id]
    if (!s.done) return null
    const who = s.by === viewerId ? "you" : s.by ? (names[s.by] ?? "a colleague") : null
    return (
      <p className="mt-2 text-xs text-text-muted">
        Done{who ? ` by ${who}` : ""}
        {s.at ? (
          <>
            {" "}
            · <span className="num">{formatDateTime(s.at)}</span>
          </>
        ) : null}
      </p>
    )
  }

  const vcf = (set?: "client" | "firm") => `/api/whatsapp/vcf/${clientId}?group=${groupId}${set ? `&set=${set}` : ""}`

  const content: Record<ChecklistStepId, React.ReactNode> = {
    group_name: (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-border bg-surface-2 px-2.5 py-1 font-mono text-[13px] text-text [overflow-wrap:anywhere]">{groupName}</span>
        <CopyButton value={groupName} label="group name" showText />
        {canManage && status !== "closed" ? (
          <Button type="button" variant="ghost" size="xs" onClick={onEditName}>
            <PencilIcon aria-hidden="true" />
            Edit name
          </Button>
        ) : null}
      </div>
    ),
    save_contacts: (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={vcf()} download>
            <DownloadIcon aria-hidden="true" />
            Download contact cards
          </a>
        </Button>
        <a href={vcf("client")} download className="text-sm font-medium text-primary hover:underline">
          Client contacts only
        </a>
        <a href={vcf("firm")} download className="text-sm font-medium text-primary hover:underline">
          Firm numbers only
        </a>
        <p className="basis-full text-sm text-text-muted">
          One .vcf file with <span className="num">{list.length}</span> {list.length === 1 ? "card" : "cards"}, named like {list.find((n) => n.kind === "client_contact")?.cardName ?? `${shortName} – Ramesh (Director)`} and {firmList[0]?.cardName ?? "TW Staff office"}. Opening it on the phone saves them in one tap.
        </p>
      </div>
    ),
    add_numbers: (
      <div className="mt-2 flex flex-col gap-3">
        {firmList.length ? (
          // One number per row, like the client's people below: the chip says whose it is, the number
          // stays whole beside it (on a phone it wraps under the chip instead of running off screen).
          <ul className="flex flex-col gap-1.5" aria-label="Firm numbers to add">
            {firmList.map((n) => (
              <li key={n.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <MemberChip member={{ id: n.key, kind: n.kind, firm_kind: n.firmKind, display_name: n.displayName, is_admin: false }} />
                <span className="inline-flex flex-none items-center gap-1">
                  <span className="num text-sm text-text">{n.display}</span>
                  <CopyButton value={n.display} label={`${n.displayName} number`} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
            No firm number is switched on for every client group yet. A Partner adds them in Settings → WhatsApp.
          </p>
        )}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium text-text">The client&apos;s people</legend>
          {contacts.length === 0 ? (
            <p className="text-sm text-text-muted">This client has no contacts yet. Add them on the Profile &amp; contacts tab.</p>
          ) : (
            contacts.map((c) => {
              const digits = contactWhatsAppDigits(c, countryCode)
              const id = `wa-${groupId}-${c.id}`
              const checked = selected.includes(c.id)
              return (
                // The number follows the name, as for the firm's numbers above; on a phone it drops under
                // the name rather than squeezing it to a word a line.
                <div key={c.id} className="flex min-h-9 items-center gap-2.5 pointer-coarse:min-h-11">
                  <Checkbox id={id} checked={checked && !!digits} disabled={!editable || !digits || !!busy} onCheckedChange={(v) => toggleContact(c.id, v === true)} />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5">
                    <label htmlFor={id} className={cn("min-w-0 text-base text-text", (!editable || !digits) && "cursor-default")}>
                      {c.name}
                      {c.role ? <span className="text-text-muted"> ({c.role})</span> : null}
                      {c.is_primary ? <span className="ml-1.5 text-xs text-text-muted">Primary contact</span> : null}
                    </label>
                    {digits ? (
                      <span className="inline-flex flex-none items-center gap-1">
                        <span className="num text-sm text-text">{formatWhatsAppNumber(digits)}</span>
                        <CopyButton value={formatWhatsAppNumber(digits)} label={`${c.name}'s number`} />
                      </span>
                    ) : (
                      <span className="flex-none text-sm text-text-muted">No WhatsApp number</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={copyAllNumbersText(list)} label="all numbers" showText />
          <span className="text-sm text-text-muted">
            <span className="num">{list.length}</span> {list.length === 1 ? "number" : "numbers"} to add
          </span>
        </div>
      </div>
    ),
    group_settings: (
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-text">
        <li>
          Edit group settings → <span className="font-medium">Only admins</span>. Nobody else can rename the group, so it keeps the name the CRM has for it.
        </li>
        <li>
          Approve new participants → <span className="font-medium">On</span>.
        </li>
        <li>
          Disappearing messages → <span className="font-medium">Off</span>.
        </li>
      </ul>
    ),
    managers_admin: managers.length ? (
      <ul className="mt-2 flex flex-col gap-1.5">
        {managers.map((n) => (
          <li key={n.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <MemberChip member={{ id: n.id, kind: "firm_number", firm_kind: n.kind, display_name: n.label, is_admin: true }} />
            <span className="num text-sm text-text">{formatWhatsAppNumber(n.number!)}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-2 text-sm text-text-muted">The Managers&apos; office number isn&apos;t switched on in Settings → WhatsApp yet.</p>
    ),
    welcome_message: (
      <div className="mt-2 flex flex-col gap-2">
        <p className="max-w-[72ch] rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm leading-6 whitespace-pre-line text-text">{welcomeText}</p>
        <div>
          <CopyButton value={welcomeText} label="welcome message" showText />
        </div>
      </div>
    ),
    mark_created: state.steps.mark_created.done ? null : canManage && status === "to_create" ? (
      <div className="mt-2">
        <Button type="button" size="sm" onClick={onMarkCreated}>
          <CheckIcon aria-hidden="true" />
          Mark the group created
        </Button>
      </div>
    ) : null,
  }

  return (
    <section aria-labelledby={`checklist-${groupId}`} className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-2 md:px-5">
        <h4 id={`checklist-${groupId}`} className="text-base font-semibold text-text">
          Setup checklist
        </h4>
        <div className="flex min-w-48 items-center gap-3">
          <Progress value={(progress.done / progress.total) * 100} className="h-1.5 w-28" aria-label={`${progress.done} of ${progress.total} steps done`} />
          <span className="num text-sm text-text-muted">
            {progress.done}/{progress.total}
          </span>
        </div>
      </div>
      <ol className="px-4 md:px-5">
        {CHECKLIST_STEPS.map((s, i) => {
          const id = `step-${groupId}-${s.id}`
          const done = state.steps[s.id].done
          const tickable = s.id !== "mark_created"
          return (
            <li key={s.id} className="grid grid-cols-[1.5rem_1fr] gap-x-3 border-t border-border/70 py-3 first:border-t-0">
              <div className="pt-0.5">
                {tickable ? (
                  <Checkbox
                    id={id}
                    checked={done}
                    disabled={!editable || !!busy}
                    onCheckedChange={(v) => tick(s.id as Exclude<ChecklistStepId, "mark_created">, v === true)}
                    aria-describedby={`${id}-desc`}
                  />
                ) : done ? (
                  <span className="flex size-4 items-center justify-center rounded-[4px] bg-primary text-primary-foreground" aria-label="Done">
                    <CheckIcon className="size-3" aria-hidden="true" />
                  </span>
                ) : (
                  <UsersIcon aria-hidden="true" className="size-4 text-text-muted" />
                )}
              </div>
              <div className="min-w-0">
                <label htmlFor={tickable ? id : undefined} className={cn("block text-base font-medium text-text", tickable && editable && "cursor-pointer")}>
                  <span className="num text-text-muted">{i + 1}.</span> {s.title}
                </label>
                <p id={`${id}-desc`} className="mt-0.5 max-w-[72ch] text-sm text-text-muted">
                  {s.description}
                </p>
                {content[s.id]}
                {stamp(s.id)}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

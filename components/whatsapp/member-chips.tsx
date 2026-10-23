import { cn } from "@/lib/utils"
import { MEMBER_TONE_LABEL, memberTone, type MemberTone } from "@/lib/domain/whatsapp"

/**
 * A group's members as chips (§7.25.1), coloured by who they are: Partners `--accent-gold`, the
 * Managers' office `--brand-navy`, the Staff office `--text-muted`, the client's people `--info`.
 * The colour is the dot and a pale tint; the label stays in ink (AA contrast), the kind is in the
 * accessible name, and admins say "Admin". Chips never squeeze (nowrap, flex-none) and the list wraps.
 * Server-safe.
 */

const TONE: Record<MemberTone, { dot: string; chip: string }> = {
  partner: { dot: "bg-gold", chip: "border-gold/45 bg-gold/10" },
  managers: { dot: "bg-brand-navy ring-1 ring-text-muted/50", chip: "border-brand-navy/30 bg-brand-navy/[0.06] dark:border-text-muted/40 dark:bg-surface-2" },
  staff: { dot: "bg-transparent ring-[1.5px] ring-inset ring-text-muted", chip: "border-border bg-surface-2" },
  client: { dot: "bg-info", chip: "border-info/25 bg-info-soft" },
  other: { dot: "bg-text-muted", chip: "border-border bg-surface" },
}

export interface ChipMember {
  id: string
  kind: string
  firm_kind?: string | null
  display_name: string
  display?: string | null
  is_admin: boolean
}

export function MemberChip({ member, className }: { member: ChipMember; className?: string }) {
  const tone = memberTone({ kind: member.kind, firmKind: member.firm_kind })
  const t = TONE[tone]
  return (
    <span
      className={cn("inline-flex h-7 max-w-full flex-none items-center gap-1.5 rounded-full border px-2.5 text-sm whitespace-nowrap text-text", t.chip, className)}
      title={member.display ? `${member.display_name} · ${member.display}` : member.display_name}
    >
      <span aria-hidden="true" className={cn("size-2 flex-none rounded-full", t.dot)} />
      <span className="truncate">{member.display_name}</span>
      {member.is_admin ? <span className="flex-none text-xs font-medium text-text-muted">· Admin</span> : null}
      <span className="sr-only">
        , {MEMBER_TONE_LABEL[tone]}
        {member.is_admin ? ", group admin" : ""}
      </span>
    </span>
  )
}

export function MemberChips({ members, className }: { members: ChipMember[]; className?: string }) {
  return (
    <ul className={cn("flex min-w-0 flex-wrap gap-1.5", className)} aria-label="Members">
      {members.map((m) => (
        <li key={m.id} className="min-w-0">
          <MemberChip member={m} />
        </li>
      ))}
    </ul>
  )
}

/** The key under the chips: what each colour means. */
export function MemberLegend({ className }: { className?: string }) {
  const order: MemberTone[] = ["partner", "managers", "staff", "client"]
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted", className)} aria-label="Member colours">
      {order.map((tone) => (
        <li key={tone} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2 rounded-full", TONE[tone].dot)} />
          {tone === "client" ? "Client's people" : tone === "partner" ? "Partners" : MEMBER_TONE_LABEL[tone]}
        </li>
      ))}
    </ul>
  )
}

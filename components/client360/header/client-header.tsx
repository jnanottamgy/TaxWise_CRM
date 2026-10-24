import Link from "next/link"
import { UserRoundIcon, UsersIcon } from "lucide-react"
import { PageHeader, type Crumb } from "@/components/app/page-header"
import { StatusChip } from "@/components/app/status-chip"
import { PriorityChip } from "@/components/app/priority-chip"
import { MonoId } from "@/components/app/mono-id"
import { ENTITY_TYPE_LABELS } from "@/lib/domain/enums"
import { stateName } from "@/lib/domain/india-validators"
import { applySignature, firstNameOf, pickContactForService, pickWhatsAppNumber } from "@/lib/domain/messaging"
import { renderTemplate, type TemplateValues } from "@/lib/domain/templates"
import { coverBadge, formatCoverUntil } from "@/lib/domain/cover"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { MessagingContext } from "@/lib/data/clients"
import type { Client360, CoverBadge } from "@/lib/data/client360"
import { ContactButtons, type ContactTarget } from "@/components/client360/header/contact-buttons"
import { HeaderActions } from "@/components/client360/header/header-actions"

/**
 * The Client 360 header (§7.3.3): name, code, entity, status chip, priority, owner and group;
 * PAN / GSTIN / TAN with copy buttons; Call · WhatsApp · Email · Gmail; a "Covering for Ravi · until
 * Sat 25 Oct, 11:59 pm" chip for every cover in force (shown to everyone who can see the client,
 * §4.7), the handover note for the cover person; and the quick actions. Server Component; the
 * buttons are client islands.
 */
export function ClientHeader({
  data,
  user,
  messaging,
  portalLink,
  unpaid,
}: {
  data: Client360
  user: CurrentUser
  messaging: MessagingContext
  portalLink: string
  unpaid: { count: number; outstanding: string } | null
}) {
  const { client, contacts, covers } = data
  const crumbs: Crumb[] = [{ label: user.role === "employee" ? "My clients" : "Clients", href: "/clients" }, { label: client.display_name }]
  const entity = client.entity_type ? (client.entity_type === "other" && client.entity_type_other ? client.entity_type_other : ENTITY_TYPE_LABELS[client.entity_type]) : null

  // The general contact: the primary (or first) contact, falling back to the client's own details (§7.13.2).
  const contact = pickContactForService(
    contacts.map((c) => ({ ...c, isPrimary: c.is_primary })),
    null,
  )
  const whatsapp = pickWhatsAppNumber(contact, client, { countryCode: messaging.countryCode })
  const phone = contact?.phone ?? client.phone ?? null
  const email = (contact && !contact.email_bounced ? contact.email : null) ?? client.email ?? null
  const contactName = contact?.name ?? client.display_name
  const target: ContactTarget = {
    clientId: client.id,
    contactId: contact?.id ?? null,
    recipientName: contact ? `${contact.name} · ${client.display_name}` : client.display_name,
    phone,
    whatsapp: whatsapp?.digits ?? null,
    email,
  }

  const values: TemplateValues = {
    client_name: client.display_name,
    client_code: client.client_code,
    contact_name: firstNameOf(contactName) || contactName,
    portal_link: portalLink,
    firm_name: messaging.firmName,
    firm_phone: messaging.firmPhone,
    sender_name: messaging.senderName,
  }
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const draft = sign(`Hi ${values.contact_name},\n\n`)
  const templates = messaging.templates
    .filter((t) => t.channel === "whatsapp" || t.channel === "any")
    .map((t) => ({ id: t.id, name: t.name, body: sign(renderTemplate(t.body, values, { missing: "mark" })) }))
  const emailSubject = `${messaging.firmName} | ${client.display_name}`
  const emailBody = `Dear ${values.contact_name},\n\n\n\nRegards,\n${messaging.senderName}\n${messaging.firmName}${messaging.firmPhone ? `\n${messaging.firmPhone}` : ""}`

  const myCover = covers.find((c) => c.cover_employee_id === user.employeeId && c.handover_note)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumbs={crumbs}
        className="pb-0 md:pb-0"
        title={client.display_name}
        meta={
          <>
            <StatusChip kind="client_status" value={client.status} variant="pill" />
            <PriorityChip kind="client_priority" value={client.priority} />
            {coverChips(covers, client.owner_name, user.employeeId).map((chip) => (
              <StatusChip key={chip.key} label={chip.label} tone="info" variant="pill" meaning={chip.meaning} />
            ))}
          </>
        }
        description={[client.legal_name && client.legal_name !== client.display_name ? client.legal_name : null, client.city].filter(Boolean).join(" · ") || undefined}
        actions={
          <HeaderActions
            clientId={client.id}
            clientName={client.display_name}
            clientCode={client.client_code}
            status={client.status}
            updatedAt={client.updated_at}
            role={user.role}
            contacts={contacts.map((c) => ({ id: c.id, name: c.name, role: c.role, is_primary: c.is_primary }))}
            unpaid={unpaid}
          />
        }
      />

      {myCover ? (
        <aside aria-label="Handover note" className="rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-base text-text md:px-5">
          <p className="text-sm font-medium text-info-text">Handover note for your cover</p>
          <p className="mt-1 whitespace-pre-line">{myCover.handover_note}</p>
        </aside>
      ) : null}

      <section aria-label="Key facts" className="rounded-lg border border-border bg-surface px-4 py-3 md:px-5">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Fact term="Code">
            <MonoId value={client.client_code} copy label="client code" />
          </Fact>
          <Fact term="Entity">{entity}</Fact>
          <Fact term="Owner">
            {client.owner_name ? (
              <span className="inline-flex items-center gap-1.5">
                <UserRoundIcon aria-hidden="true" className="size-3.5 text-text-muted" />
                {client.owner_name}
              </span>
            ) : null}
          </Fact>
          <Fact term="Group">
            {client.group_name && client.group_id ? (
              <Link href={`/clients/groups/${client.group_id}`} className="inline-flex items-center gap-1.5 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <UsersIcon aria-hidden="true" className="size-3.5 text-text-muted" />
                {client.group_name}
              </Link>
            ) : null}
          </Fact>
          <Fact term="PAN">
            <MonoId value={client.pan} copy label="PAN" />
          </Fact>
          <Fact term="GSTIN">
            <MonoId value={client.gstin} copy label="GSTIN" />
          </Fact>
          <Fact term="TAN">
            <MonoId value={client.tan} copy label="TAN" />
          </Fact>
          {client.state_code ? <Fact term="Place of supply">{`${stateName(client.state_code) ?? client.state_code} (${client.state_code})`}</Fact> : null}
        </dl>
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm text-text-muted">
            {contact ? (
              <>
                Contact: <span className="text-text">{contact.name}</span>
                {contact.role ? `, ${contact.role}` : ""}
              </>
            ) : (
              "No contacts yet: buttons use the client's own phone and email."
            )}
          </p>
          <ContactButtons target={target} draft={draft} templates={templates} emailSubject={emailSubject} emailBody={emailBody} />
        </div>
      </section>
    </div>
  )
}

/**
 * One chip per distinct badge (§4.7: "Covering for Ravi · until Sat 25 Oct, 11:59 pm", the same chip
 * for everyone). Two covers for the same absent person ending at the same time (a client cover by
 * Meghana and a person cover by Kiran, say) read identically, so they share one chip, and its
 * explanation names every cover person and what each cover reaches.
 */
function coverChips(covers: CoverBadge[], ownerName: string | null, viewerEmployeeId: string | null): Array<{ key: string; label: string; meaning: string }> {
  const byLabel = new Map<string, { key: string; label: string; absent: string; until: string; who: string[] }>()
  for (const c of covers) {
    const absent = c.absent_name ?? ownerName ?? "the team"
    const short = firstNameOf(absent) || absent
    const label = coverBadge(short, c.ends_at)
    const person = c.cover_employee_id === viewerEmployeeId ? "you" : c.cover_name
    const who = `${person} (${c.kind === "person" ? `all of ${short}'s clients` : "this client"})`
    const chip = byLabel.get(label)
    if (chip) chip.who.push(who)
    else byLabel.set(label, { key: c.cover_id, label, absent, until: formatCoverUntil(c.ends_at), who: [who] })
  }
  return Array.from(byLabel.values()).map((chip) => {
    const names = chip.who.length === 1 ? chip.who[0] : `${chip.who.slice(0, -1).join(", ")} and ${chip.who[chip.who.length - 1]}`
    const verb = chip.who.length === 1 && !chip.who[0].startsWith("you ") ? "is" : "are"
    const subject = names[0].toUpperCase() + names.slice(1)
    return {
      key: chip.key,
      label: chip.label,
      meaning: `${subject} ${verb} covering for ${chip.absent} until ${chip.until}, working on it exactly as if on its team but never seeing fees. Access ends by itself at that time.`,
    }
  })
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  const missing = children === null || children === undefined || children === ""
  return (
    <div className="min-w-0">
      <dt className="text-xs leading-4 text-text-muted">{term}</dt>
      <dd className="mt-0.5 min-h-5 text-base leading-5 text-text">{missing ? <span className="text-text-muted">—</span> : children}</dd>
    </div>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { EllipsisIcon, PencilIcon, PlusIcon, StarIcon, Trash2Icon, UsersRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { SERVICE_TYPE_LABELS, type ServiceType } from "@/lib/domain/enums"
import { applySignature, firstNameOf, formatWhatsAppNumber, pickWhatsAppNumber } from "@/lib/domain/messaging"
import { renderTemplate } from "@/lib/domain/templates"
import { deleteContact, setPrimaryContact } from "@/server/actions/contacts"
import type { ContactRow } from "@/lib/data/client360"
import { ContactButtons } from "@/components/client360/header/contact-buttons"
import { ContactDialog } from "@/components/client360/profile/contact-dialog"

export interface MessagingBits {
  firmName: string
  firmPhone: string | null
  senderName: string
  countryCode: string
  signatureFormat: string
  addSignature: boolean
  portalLink: string
  clientCode: string
  templates: Array<{ id: string; name: string; body: string; channel: string }>
}

type Dialog = { kind: "add" } | { kind: "edit"; contact: ContactRow } | { kind: "delete"; contact: ContactRow } | null

/**
 * Contacts (§7.3.3 Profile & contacts): each person with their role, the services they handle and
 * their own Call · WhatsApp buttons (per-contact buttons use that contact's own
 * number, §7.13.2); exactly one primary. Partners and Managers add, edit, delete and make primary;
 * everyone else reads.
 */
export function ContactsSection({ clientId, clientName, contacts, canManage, messaging }: { clientId: string; clientName: string; contacts: ContactRow[]; canManage: boolean; messaging: MessagingBits }) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const makePrimary = async (c: ContactRow) => {
    setBusy(c.id)
    try {
      const r = await setPrimaryContact({ id: c.id, clientId, updatedAt: c.updated_at })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`${c.name} is now the primary contact.`)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)

  return (
    <SectionCard
      id="contacts"
      title="Contacts"
      description={contacts.length ? `${contacts.length} ${contacts.length === 1 ? "person" : "people"} at ${clientName}` : undefined}
      flush
      action={
        canManage ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setDialog({ kind: "add" })}>
            <PlusIcon aria-hidden="true" />
            Add contact
          </Button>
        ) : undefined
      }
    >
      {contacts.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState
            size="compact"
            icon={<UsersRoundIcon />}
            message={canManage ? "No contacts yet. Add the person you'll speak to." : "No contacts yet. A Manager or Partner adds them."}
            action={
              canManage ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: "add" })}>
                  Add contact
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {contacts.map((c) => {
            const first = firstNameOf(c.name) || c.name
            const values = { client_name: clientName, client_code: messaging.clientCode, contact_name: first, portal_link: messaging.portalLink, firm_name: messaging.firmName, firm_phone: messaging.firmPhone, sender_name: messaging.senderName }
            const templates = messaging.templates
              .filter((t) => t.channel === "whatsapp" || t.channel === "any")
              .map((t) => ({ id: t.id, name: t.name, body: sign(renderTemplate(t.body, values, { missing: "mark" })) }))
            const wa = pickWhatsAppNumber(c, null, { contactOnly: true, countryCode: messaging.countryCode })
            const handles = c.handles.map((h) => SERVICE_TYPE_LABELS[h as ServiceType] ?? h)
            return (
              <li key={c.id} className="flex flex-col gap-2 px-4 py-3 md:px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-base font-medium text-text">{c.name}</span>
                      {c.is_primary ? <StatusChip label="Primary" tone="info" variant="pill" meaning="Primary contact: reminders and the client's buttons go to this person unless a service has its own contact." /> : null}
                      {c.role ? <span className="text-sm text-text-muted">{c.role}</span> : null}
                    </p>
                    <p className="mt-0.5 text-sm text-text-muted">{handles.length ? `Handles ${handles.join(", ")}` : "General contact"}</p>
                    <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-text">
                      {c.email ? (
                        <span className={c.email_bounced ? "text-danger-text" : undefined}>
                          {c.email}
                          {c.email_bounced ? " (bounced)" : ""}
                        </span>
                      ) : null}
                      {c.phone ? <span className="num tabular-nums">{c.phone}</span> : null}
                      {wa && c.whatsapp ? <span className="num tabular-nums">WhatsApp {formatWhatsAppNumber(wa.digits)}</span> : null}
                      {!c.email && !c.phone && !c.whatsapp ? <span className="text-text-muted">No email or phone</span> : null}
                    </p>
                    {c.notes ? <p className="mt-1 text-sm whitespace-pre-line text-text-muted">{c.notes}</p> : null}
                  </div>
                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`} disabled={busy === c.id}>
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", contact: c })}>
                          <PencilIcon aria-hidden="true" />
                          Edit contact
                        </DropdownMenuItem>
                        {!c.is_primary ? (
                          <DropdownMenuItem onSelect={() => void makePrimary(c)}>
                            <StarIcon aria-hidden="true" />
                            Make primary
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "delete", contact: c })} className="text-danger-text focus:text-danger-text">
                          <Trash2Icon aria-hidden="true" />
                          Delete contact
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <ContactButtons
                  compact
                  scope="contact"
                  target={{ clientId, contactId: c.id, recipientName: `${c.name} · ${clientName}`, phone: c.phone, whatsapp: wa?.digits ?? null }}
                  draft={sign(`Hi ${first},\n\n`)}
                  templates={templates}
                />
              </li>
            )
          })}
        </ul>
      )}

      {canManage ? (
        <>
          <ContactDialog
            open={dialog?.kind === "add" || dialog?.kind === "edit"}
            onOpenChange={(o) => !o && setDialog(null)}
            clientId={clientId}
            clientName={clientName}
            contact={dialog?.kind === "edit" ? dialog.contact : null}
            isFirst={contacts.length === 0}
          />
          <ConfirmDialog
            open={dialog?.kind === "delete"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={dialog?.kind === "delete" ? `Delete ${dialog.contact.name}?` : "Delete contact?"}
            description={
              dialog?.kind === "delete"
                ? dialog.contact.is_primary && contacts.length > 1
                  ? `${dialog.contact.name} is the primary contact. The longest-standing other contact becomes primary. Messages already logged with them stay in the history.`
                  : `${dialog.contact.name} is removed from ${clientName}'s contacts. Messages already logged with them stay in the history.`
                : ""
            }
            confirmLabel="Delete contact"
            destructive
            onConfirm={async () => {
              if (dialog?.kind !== "delete") return
              const r = await deleteContact({ id: dialog.contact.id, clientId, updatedAt: dialog.contact.updated_at })
              if (!r.ok) {
                toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                return false
              }
              for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
              toast.success(r.data.newPrimaryName ? `Contact deleted. ${r.data.newPrimaryName} is now the primary contact.` : "Contact deleted.")
              router.refresh()
            }}
          />
        </>
      ) : null}
    </SectionCard>
  )
}

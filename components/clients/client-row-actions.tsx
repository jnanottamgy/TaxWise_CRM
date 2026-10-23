"use client"

import * as React from "react"
import Link from "next/link"
import { EllipsisIcon, ExternalLinkIcon, ListPlusIcon, ReceiptTextIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { applySignature, firstNameOf, gmailComposeUrl, pickWhatsAppNumber, waMeUrl } from "@/lib/domain/messaging"
import { extractVariables, renderTemplate, type TemplateValues } from "@/lib/domain/templates"
import { logHandoff } from "@/server/actions/messages"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { WhatsAppButton, type MessageTemplateOption } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"

export type RowContact = { id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null } | null

export type MessagingProps = {
  firmName: string
  firmPhone: string | null
  countryCode: string
  signatureFormat: string
  addSignature: boolean
  senderName: string
  templates: Array<{ id: string; name: string; channel: string; subject: string | null; body: string }>
  portalUrl: string
}

/** Variables a client-list hand-off can fill (no task, deadline or invoice is in view). */
const CLIENT_LEVEL = new Set(["client_name", "client_code", "contact_name", "portal_link", "firm_name", "firm_phone", "sender_name"])

const whatsAppUrl = (digits: string, text: string) => waMeUrl(digits, text)
const gmailUrl = (f: { to: string; cc?: string; subject: string; body: string }) => gmailComposeUrl(f)

async function logged(r: Promise<{ ok: boolean }>) {
  const res = await r
  if (!res.ok) throw new Error("not logged")
}

/**
 * The row actions of the client list (§7.3.1): WhatsApp (§7.13.2, the general draft or a template,
 * logged as handed off), email through Gmail (§7.13.3), and a menu with Open, New task and New
 * invoice (Partner/Manager), Change status and Delete (Partner). Clicks never open the row.
 */
export function ClientRowActions({
  client,
  contact,
  messaging,
  canManage,
  canDelete,
  onChangeStatus,
  onDelete,
}: {
  client: { id: string; display_name: string; client_code: string; email: string | null; phone: string | null; whatsapp: string | null }
  contact: RowContact
  messaging: MessagingProps
  canManage: boolean
  canDelete: boolean
  onChangeStatus: () => void
  onDelete: () => void
}) {
  const contactName = contact?.name ?? client.display_name
  const first = firstNameOf(contactName) || contactName
  const values: TemplateValues = {
    client_name: client.display_name,
    client_code: client.client_code,
    contact_name: first,
    portal_link: messaging.portalUrl,
    firm_name: messaging.firmName,
    firm_phone: messaging.firmPhone,
    sender_name: messaging.senderName,
  }
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const picked = pickWhatsAppNumber(contact, client, { countryCode: messaging.countryCode })
  const templates: MessageTemplateOption[] = messaging.templates
    .filter((t) => (t.channel === "whatsapp" || t.channel === "any") && extractVariables(t.body).every((v) => CLIENT_LEVEL.has(v)))
    .map((t) => ({ id: t.id, name: t.name, body: sign(renderTemplate(t.body, values)) }))
  const email = contact?.email ?? client.email

  return (
    <div className="flex items-center justify-end gap-1" data-row-click-ignore>
      <WhatsAppButton
        iconOnly
        variant="outline"
        recipientName={`${contactName} · ${client.display_name}`}
        number={picked?.digits ?? null}
        draft={sign(`Hi ${first},\n\n`)}
        templates={templates}
        buildUrl={whatsAppUrl}
        onHandedOff={({ number, text, templateId }) =>
          logged(logHandoff({ clientId: client.id, contactId: contact?.id ?? null, channel: "whatsapp_handoff", recipient: number, body: text, templateId }))
        }
      />
      <GmailButton
        iconOnly
        label="Email"
        to={email}
        subject={`${messaging.firmName} | ${client.display_name}`}
        body={`Dear ${first},\n\n\n\nRegards,\n${messaging.senderName}\n${messaging.firmName}`}
        buildUrl={gmailUrl}
        onHandedOff={(f) =>
          logged(
            logHandoff({
              clientId: client.id,
              contactId: contact?.id ?? null,
              channel: "gmail_handoff",
              recipient: f.to,
              subject: f.subject,
              body: f.body || f.subject,
            }),
          )
        }
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${client.display_name}`}>
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem asChild>
            <Link href={`/clients/${client.id}`}>
              <ExternalLinkIcon aria-hidden="true" />
              Open
            </Link>
          </DropdownMenuItem>
          {canManage ? (
            <>
              <DropdownMenuItem asChild>
                <Link href={`/work?new=1&client=${client.id}`}>
                  <ListPlusIcon aria-hidden="true" />
                  New task
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/invoices/new?client=${client.id}`}>
                  <ReceiptTextIcon aria-hidden="true" />
                  New invoice
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onChangeStatus}>
                <RefreshCwIcon aria-hidden="true" />
                Change status
              </DropdownMenuItem>
            </>
          ) : null}
          {canDelete ? (
            <DropdownMenuItem onSelect={onDelete} className="text-danger-text focus:text-danger-text">
              <Trash2Icon aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

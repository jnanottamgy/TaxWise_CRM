import "server-only";

import { unstable_rethrow } from "next/navigation";
import type { ServerSupabase } from "@/lib/supabase/server";
import { logUnexpected } from "@/lib/log";
import type { AppRole } from "@/lib/auth/roles";
import type { ServiceType } from "@/lib/domain/enums";
import { applySignature, firstNameOf, pickContactForService, pickWhatsAppNumber } from "@/lib/domain/messaging";
import type { TemplateValues } from "@/lib/domain/templates";
import { whatsAppTemplateOptions } from "@/lib/schemas/message-templates";
import { getMessagingContext, type MessagingContext } from "@/lib/data/clients";

/**
 * Sending a document to a client on WhatsApp (§7.13.2): the page loads the client, its contacts
 * and the firm's messaging settings once (getShareContext), then builds one DocumentShare per
 * document (documentShare) for the SendDocumentButton (components/comms/send-document.tsx):
 *
 *   const share = await getShareContext(supabase, user, clientId)
 *   const itr = share && documentShare(share, {
 *     serviceType: "income_tax",
 *     draft: (first) => `Hi ${first}, please find your income tax computation for AY 2027-28 attached.`,
 *     values: { compliance_type: "ITR" },
 *     attachment: { href: `/api/pdf/itr/${id}?download=1`, filename: "ITR computation TW-C-0042-AY-2027-28.pdf" },
 *     related: { type: "itr_computation", id },
 *   })
 *
 * The message goes to the contact who handles the document's service (else the primary contact),
 * on their WhatsApp number, else their phone, else the client's (pickWhatsAppNumber). The draft
 * ends with the sender's signature when they add one; the firm's WhatsApp and Any templates of
 * `templateTypes` (all when omitted) come filled in. Runs under the caller's RLS.
 */

export type DocumentShare = {
  clientId: string;
  contactId: string | null;
  /** "Rakesh Sharma · Sharma Traders". */
  recipientName: string;
  /** Normalised WhatsApp digits, or null when there is no usable number (the button explains). */
  number: string | null;
  draft: string;
  templates: Array<{ id: string; name: string; body: string }>;
  attachment: { href: string; filename: string };
  /** The record the hand-off is logged against ("receipt", "credit_note", "itr_computation" …). */
  related: { type: string; id: string };
};

export type ShareContact = { id: string; name: string; phone: string | null; whatsapp: string | null; isPrimary: boolean; handles: readonly string[] };

export type ShareContext = {
  client: { id: string; name: string; code: string | null; phone: string | null; whatsapp: string | null };
  contacts: ShareContact[];
  messaging: MessagingContext;
  portalLink: string | null;
};

/** The client, its contacts and the messaging settings for one page's document sends. Null when the client isn't visible. Throws on a database error. */
export async function getShareContext(
  supabase: ServerSupabase,
  user: { role: AppRole; fullName: string; preferences: Record<string, unknown> },
  clientId: string,
  opts: { portalLink?: string | null } = {},
): Promise<ShareContext | null> {
  const [client, contacts, messaging] = await Promise.all([
    supabase.from("clients").select("id, display_name, client_code, phone, whatsapp").eq("id", clientId).maybeSingle(),
    supabase.from("client_contacts").select("id, name, phone, whatsapp, is_primary, handles").eq("client_id", clientId).order("is_primary", { ascending: false }).order("created_at", { ascending: true }).limit(50),
    getMessagingContext(supabase, user),
  ]);
  if (client.error) throw client.error;
  if (contacts.error) throw contacts.error;
  if (!client.data) return null;
  return {
    client: { id: client.data.id, name: client.data.display_name, code: client.data.client_code ?? null, phone: client.data.phone, whatsapp: client.data.whatsapp },
    contacts: (contacts.data ?? []).map((c) => ({ id: c.id, name: c.name, phone: c.phone, whatsapp: c.whatsapp, isPrimary: c.is_primary, handles: (c.handles ?? []) as string[] })),
    messaging,
    portalLink: opts.portalLink ?? null,
  };
}

/**
 * getShareContext for a page that renders without it: a failure is logged under `source` and the
 * page leaves its Send on WhatsApp buttons out instead of failing.
 */
export async function getShareContextOrNull(
  supabase: ServerSupabase,
  user: { id: string; role: AppRole; fullName: string; preferences: Record<string, unknown> },
  clientId: string,
  opts: { portalLink?: string | null; source: string },
): Promise<ShareContext | null> {
  try {
    return await getShareContext(supabase, user, clientId, opts);
  } catch (err) {
    unstable_rethrow(err);
    logUnexpected(err, { source: opts.source, userId: user.id });
    return null;
  }
}

/** One document's WhatsApp send. `draft` gets the contact's first name ("" without one). Pure. */
export function documentShare(
  ctx: ShareContext,
  d: {
    serviceType?: ServiceType | null;
    draft: (firstName: string) => string;
    values?: TemplateValues;
    templateTypes?: readonly string[];
    attachment: { href: string; filename: string };
    related: { type: string; id: string };
  },
): DocumentShare {
  const m = ctx.messaging;
  const contact = pickContactForService(ctx.contacts, d.serviceType ?? null);
  const first = contact ? firstNameOf(contact.name) || contact.name : "";
  const sign = (text: string) => (m.addSignature ? applySignature(text, m.signatureFormat, firstNameOf(m.senderName)) : text);
  const values: TemplateValues = {
    client_name: ctx.client.name,
    client_code: ctx.client.code ?? "",
    contact_name: first,
    firm_name: m.firmName,
    firm_phone: m.firmPhone ?? "",
    sender_name: m.senderName,
    portal_link: ctx.portalLink ?? "",
    ...d.values,
  };
  return {
    clientId: ctx.client.id,
    contactId: contact?.id ?? null,
    recipientName: contact ? `${contact.name} · ${ctx.client.name}` : ctx.client.name,
    number: pickWhatsAppNumber(contact, ctx.client, { countryCode: m.countryCode })?.digits ?? null,
    draft: sign(d.draft(first)),
    templates: whatsAppTemplateOptions(m.templates, values, { types: d.templateTypes, sign }),
    attachment: d.attachment,
    related: d.related,
  };
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AtSignIcon, ExternalLinkIcon, GlobeIcon, MessageCircleIcon, PhoneIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { LogCallDialog } from "@/components/client360/header/log-call-dialog"
import { NO_WHATSAPP_NUMBER_MESSAGE, applySignature, buildGmailCompose, firstNameOf, formatWhatsAppNumber, mailtoUrl, normalizeWhatsAppNumber, waMeUrl } from "@/lib/domain/messaging"
import { missingVariables, renderTemplate, type TemplateValues } from "@/lib/domain/templates"
import { channelFits, type TemplateUse } from "@/lib/schemas/message-templates"
import { REPLY_BODY_MAX } from "@/lib/schemas/inbox"
import { logHandoff } from "@/server/actions/messages"
import { sendPortalReply } from "@/server/actions/threads"
import { runAction } from "@/components/comms/comms-ui"

/**
 * Writing to a client from their thread (§7.13.1–§7.13.4): a portal reply (in the app; the client
 * is told in their portal), a WhatsApp or Gmail hand-off (the app opens WhatsApp or Gmail with the
 * draft and logs it as "Handed off"; the person presses Send there), or "Log a call". Each can
 * start from a template, filled in for this client and contact; variables the app can't fill here
 * (a period, a due date) are left as [period] for you to complete. WhatsApp drafts end with your
 * signature when you add one on the shared numbers (§7.13.2).
 */

export type ComposerContact = { id: string; name: string; role: string | null; email: string | null; email_bounced: boolean; phone: string | null; whatsapp: string | null; is_primary: boolean }

export type ComposerMessaging = {
  firmName: string
  firmPhone: string | null
  countryCode: string
  signatureFormat: string
  addSignature: boolean
  senderName: string
  templates: Array<{ id: string; name: string; type: string; channel: string; subject: string | null; body: string }>
}

type Mode = "portal" | "whatsapp" | "gmail"

const CLIENT_KEY = "client"

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {hint ? <div className="text-sm text-text-muted">{hint}</div> : null}
    </div>
  )
}

export function Composer({
  client,
  contacts,
  messaging,
  portalLink,
}: {
  client: { id: string; name: string; code: string; onPortal: boolean; email: string | null; phone: string | null; whatsapp: string | null }
  contacts: ComposerContact[]
  messaging: ComposerMessaging
  portalLink: string
}) {
  const router = useRouter()
  const ids = React.useId()
  const [mode, setMode] = React.useState<Mode>(client.onPortal ? "portal" : "whatsapp")
  const [callOpen, setCallOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  // Who it goes to.
  const waOptions = React.useMemo(() => {
    const out: Array<{ key: string; label: string; contactId: string | null; number: string; name: string }> = []
    for (const c of contacts) {
      const n = normalizeWhatsAppNumber(c.whatsapp, { countryCode: messaging.countryCode }) ?? normalizeWhatsAppNumber(c.phone, { countryCode: messaging.countryCode })
      if (n) out.push({ key: c.id, label: `${c.name}${c.role ? ` (${c.role})` : ""} · ${formatWhatsAppNumber(n)}`, contactId: c.id, number: n, name: c.name })
    }
    const own = normalizeWhatsAppNumber(client.whatsapp, { countryCode: messaging.countryCode }) ?? normalizeWhatsAppNumber(client.phone, { countryCode: messaging.countryCode })
    if (own && !out.some((o) => o.number === own)) out.push({ key: CLIENT_KEY, label: `${client.name} · ${formatWhatsAppNumber(own)}`, contactId: null, number: own, name: client.name })
    return out
  }, [contacts, client, messaging.countryCode])
  const mailOptions = React.useMemo(() => {
    const out: Array<{ key: string; label: string; contactId: string | null; email: string; name: string; bounced: boolean }> = []
    for (const c of contacts) if (c.email) out.push({ key: c.id, label: `${c.name}${c.role ? ` (${c.role})` : ""} · ${c.email}${c.email_bounced ? " (bounced before)" : ""}`, contactId: c.id, email: c.email, name: c.name, bounced: c.email_bounced })
    if (client.email && !out.some((o) => o.email.toLowerCase() === client.email!.toLowerCase())) out.push({ key: CLIENT_KEY, label: `${client.name} · ${client.email}`, contactId: null, email: client.email, name: client.name, bounced: false })
    return out
  }, [contacts, client])

  const primaryKey = (opts: Array<{ key: string; contactId: string | null }>) => opts.find((o) => contacts.find((c) => c.id === o.contactId)?.is_primary)?.key ?? opts[0]?.key ?? ""
  const [waTo, setWaTo] = React.useState(() => primaryKey(waOptions))
  const [mailTo, setMailTo] = React.useState(() => primaryKey(mailOptions))
  const wa = waOptions.find((o) => o.key === waTo) ?? null
  const mail = mailOptions.find((o) => o.key === mailTo) ?? null
  const recipientName = mode === "whatsapp" ? wa?.name : mode === "gmail" ? mail?.name : (contacts.find((c) => c.is_primary)?.name ?? null)

  const values: TemplateValues = {
    client_name: client.name,
    client_code: client.code,
    contact_name: recipientName && recipientName !== client.name ? firstNameOf(recipientName) || recipientName : "",
    firm_name: messaging.firmName,
    firm_phone: messaging.firmPhone ?? "",
    sender_name: messaging.senderName,
    portal_link: portalLink,
  }
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const hello = values.contact_name ? `Hi ${values.contact_name},` : "Hello,"

  const [templateId, setTemplateId] = React.useState<Record<Mode, string>>({ portal: "", whatsapp: "", gmail: "" })
  const [text, setText] = React.useState<Record<Mode, string>>(() => ({
    portal: "",
    whatsapp: sign(`${hello}\n\n`),
    gmail: `Dear ${values.contact_name || "Sir/Madam"},\n\n\n\nWarm regards,\n${messaging.senderName}\n${messaging.firmName}`,
  }))
  const [subject, setSubject] = React.useState(`${messaging.firmName} | `)

  const use: TemplateUse = mode === "gmail" ? "email" : mode === "whatsapp" ? "whatsapp" : "portal"
  const templates = messaging.templates.filter((t) => channelFits(t.channel, use))
  const chosen = messaging.templates.find((t) => t.id === templateId[mode]) ?? null
  const missing = chosen ? missingVariables(`${mode === "gmail" ? (chosen.subject ?? "") : ""}\n${chosen.body}`, values) : []

  const pickTemplate = (id: string) => {
    setTemplateId((s) => ({ ...s, [mode]: id }))
    const t = messaging.templates.find((x) => x.id === id)
    if (!t) return
    const body = renderTemplate(t.body, values, { missing: "mark" })
    setText((s) => ({ ...s, [mode]: mode === "whatsapp" ? sign(body) : body }))
    if (mode === "gmail" && t.subject) setSubject(renderTemplate(t.subject, values, { missing: "mark" }))
  }

  const body = text[mode]
  const setBody = (v: string) => setText((s) => ({ ...s, [mode]: v }))
  const gmail = mail ? buildGmailCompose({ to: mail.email, subject, body }) : null

  const sendPortal = async () => {
    setPending(true)
    const done = await runAction(() => sendPortalReply({ clientId: client.id, body, templateId: templateId.portal || null }), `Sent to ${client.name}'s portal.`)
    setPending(false)
    if (done) {
      setText((s) => ({ ...s, portal: "" }))
      setTemplateId((s) => ({ ...s, portal: "" }))
      router.refresh()
    }
  }

  const openWhatsApp = async () => {
    if (!wa) return
    window.open(waMeUrl(wa.number, body), "_blank", "noopener,noreferrer")
    setPending(true)
    const done = await runAction(
      () => logHandoff({ clientId: client.id, contactId: wa.contactId, channel: "whatsapp_handoff", recipient: wa.number, body, templateId: templateId.whatsapp || null }),
      "Handed off to WhatsApp. Press Send there.",
    )
    setPending(false)
    if (done) router.refresh()
    else toast.warning("WhatsApp opened, but the hand-off wasn't logged. Log it with “Log a call” so the history is complete.")
  }

  const openGmail = async () => {
    if (!mail || !gmail) return
    window.open(gmail.url, "_blank", "noopener,noreferrer")
    setPending(true)
    const done = await runAction(
      () => logHandoff({ clientId: client.id, contactId: mail.contactId, channel: "gmail_handoff", recipient: mail.email, subject: subject.trim() || null, body: body.trim() || subject, templateId: templateId.gmail || null }),
      "Handed off to Gmail. Press Send there.",
    )
    setPending(false)
    if (done) router.refresh()
  }

  const tabs: Array<{ id: Mode; label: string; icon: React.ReactNode }> = [
    { id: "portal", label: "Portal", icon: <GlobeIcon aria-hidden="true" className="size-4" /> },
    { id: "whatsapp", label: "WhatsApp", icon: <MessageCircleIcon aria-hidden="true" className="size-4" /> },
    { id: "gmail", label: "Gmail", icon: <AtSignIcon aria-hidden="true" className="size-4" /> },
  ]

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface px-3 py-3 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="How to write" className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={mode === t.id}
              onClick={() => setMode(t.id)}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                mode === t.id ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setCallOpen(true)}>
          <PhoneIcon aria-hidden="true" />
          Log a call or note
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {mode === "portal" && !client.onPortal ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
            {client.name} isn&apos;t on the portal yet. Invite them from the Overview tab, or write on WhatsApp or Gmail.
          </p>
        ) : null}
        {mode === "whatsapp" && waOptions.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">{NO_WHATSAPP_NUMBER_MESSAGE}</p> : null}
        {mode === "gmail" && mailOptions.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">No email address for this client. Add one in Contacts.</p> : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {mode === "whatsapp" && waOptions.length > 0 ? (
            <Field label="To" htmlFor={`${ids}-wa`}>
              <NativeSelect id={`${ids}-wa`} value={waTo} onChange={(e) => setWaTo(e.target.value)} className="w-full">
                {waOptions.map((o) => (
                  <NativeSelectOption key={o.key} value={o.key}>
                    {o.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          {mode === "gmail" && mailOptions.length > 0 ? (
            <Field label="To" htmlFor={`${ids}-mail`} hint={mail?.bounced ? "Mail to this address bounced before. Check it with the client." : null}>
              <NativeSelect id={`${ids}-mail`} value={mailTo} onChange={(e) => setMailTo(e.target.value)} className="w-full">
                {mailOptions.map((o) => (
                  <NativeSelectOption key={o.key} value={o.key}>
                    {o.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="Template" htmlFor={`${ids}-tpl`} hint={missing.length ? <span className="text-warning-text">Fill in before sending: {missing.map((m) => `[${m}]`).join(", ")}</span> : null}>
            <NativeSelect id={`${ids}-tpl`} value={templateId[mode]} onChange={(e) => pickTemplate(e.target.value)} className="w-full" disabled={templates.length === 0}>
              <NativeSelectOption value="">{templates.length ? "Write my own" : "No templates for this channel"}</NativeSelectOption>
              {templates.map((t) => (
                <NativeSelectOption key={t.id} value={t.id}>
                  {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>

        {mode === "gmail" ? (
          <Field label="Subject" htmlFor={`${ids}-subject`}>
            <Input id={`${ids}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          </Field>
        ) : null}
        <Field
          label="Message"
          htmlFor={`${ids}-body`}
          hint={
            mode === "gmail" && gmail?.bodyTrimmed
              ? "Gmail can't take a message this long in one go: the end will be cut. Shorten it, or paste the rest in Gmail."
              : mode === "whatsapp"
                ? "WhatsApp opens with this message. You press Send there; the app records it as handed off."
                : mode === "gmail"
                  ? "Gmail opens with this filled in. Attach files there; the app records it as handed off."
                  : "The client sees it in their portal and gets an alert there."
          }
        >
          <Textarea id={`${ids}-body`} value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={REPLY_BODY_MAX} className="min-h-24" />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="num text-xs text-text-muted tabular-nums">{body.length.toLocaleString("en-IN")} characters</p>
          <div className="flex flex-wrap items-center gap-2">
            {mode === "gmail" && mail ? (
              <Button asChild variant="ghost" size="sm">
                <a href={mailtoUrl({ to: mail.email, subject, body })}>Use my mail app instead</a>
              </Button>
            ) : null}
            {mode === "portal" ? (
              <Button type="button" onClick={() => void sendPortal()} disabled={pending || !client.onPortal || !body.trim()}>
                {pending ? <Spinner /> : <SendIcon aria-hidden="true" />}
                Send to portal
              </Button>
            ) : mode === "whatsapp" ? (
              <Button type="button" variant="whatsapp" onClick={() => void openWhatsApp()} disabled={pending || !wa || !body.trim()}>
                {pending ? <Spinner /> : <ExternalLinkIcon aria-hidden="true" />}
                Open WhatsApp
              </Button>
            ) : (
              <Button type="button" onClick={() => void openGmail()} disabled={pending || !mail || (!body.trim() && !subject.trim())}>
                {pending ? <Spinner /> : <ExternalLinkIcon aria-hidden="true" />}
                Open Gmail
              </Button>
            )}
          </div>
        </div>
      </div>

      {callOpen ? (
        <LogCallDialog
          open={callOpen}
          onOpenChange={setCallOpen}
          clientId={client.id}
          clientName={client.name}
          contacts={contacts.map((c) => ({ id: c.id, name: c.name, role: c.role, is_primary: c.is_primary }))}
        />
      ) : null}
    </div>
  )
}

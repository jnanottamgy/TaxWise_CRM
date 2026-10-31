import { unstable_rethrow } from "next/navigation"
import { MessageCircleIcon } from "lucide-react"
import type { ClientTabProps } from "@/components/client360/types"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { isManagerOrPartner } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { applySignature, firstNameOf } from "@/lib/domain/messaging"
import { renderGroupName, renderWelcomeMessage } from "@/lib/domain/whatsapp"
import { readWhatsAppSignaturePreference } from "@/lib/schemas/profile"
import { getClientWhatsApp, type ClientWhatsApp } from "@/lib/data/whatsapp"
import { GroupCard } from "@/components/whatsapp/group-card"
import { AddGroupButton, StartGroupButton } from "@/components/whatsapp/start-group"
import { HouseRulesDisclosure } from "@/components/whatsapp/house-rules"

/**
 * Client 360 → WhatsApp group (§7.3.3 tab 12, §7.25.1–§7.25.2): the client's group(s) with status,
 * purpose, members, checklist progress, the invite link (Partner/Manager, revealed on demand) and
 * when it was last opened; Open chat, the setup checklist and Close group. Staff only, never in
 * the portal. Employees read groups through client_whatsapp_groups_public (no invite link) and only
 * for clients they can open (can_open_whatsapp: own, team, or a cover in force); Partners and
 * Managers set groups up. An Employee whose Open chat is off (§7.25.8) is told why. Never throws: a
 * failed load is an ErrorBlock with its Ref.
 */
export default async function ClientWhatsAppTab({ clientId, user, supabase }: ClientTabProps) {
  if (user.role === "client") return null

  let data: ClientWhatsApp | null = null
  let ref: string | null = null
  try {
    data = await getClientWhatsApp(supabase, user, clientId)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "tab:client-whatsapp", userId: user.id, role: user.role, clientId })
  }

  if (ref) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load this client's WhatsApp group." errorRef={ref} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <EmptyState icon={<MessageCircleIcon />} message="This client isn't in your client list, so its WhatsApp group can't be shown." />
      </div>
    )
  }

  const canManage = isManagerOrPartner(user.role)
  const browserAllowed = canManage || data.settings.browserForEmployees
  const { client, settings } = data
  const baseName = renderGroupName(settings.nameFormat, { clientCode: client.client_code, displayName: client.display_name })
  const welcomeBody = renderWelcomeMessage(data.welcome.body, {
    firmName: settings.firmName,
    clientName: client.short_name,
    clientCode: client.client_code,
    firmPhone: settings.firmPhone,
    senderName: firstNameOf(user.fullName) || user.fullName,
  })
  const welcomeText = readWhatsAppSignaturePreference(user.preferences, user.role) ? applySignature(welcomeBody, settings.signature, firstNameOf(user.fullName)) : welcomeBody
  const live = data.groups.filter((g) => g.status !== "closed")
  const closed = data.groups.filter((g) => g.status === "closed")

  const card = (g: ClientWhatsApp["groups"][number]) => (
    <GroupCard
      key={g.id}
      clientId={client.id}
      clientCode={client.client_code}
      group={g}
      canManage={canManage}
      browserAllowed={browserAllowed}
      viewerId={user.id}
      names={data.names}
      firmNumbers={data.firmNumbers}
      contacts={data.contacts}
      shortName={client.short_name}
      countryCode={settings.countryCode}
      welcomeText={welcomeText}
    />
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!browserAllowed && live.some((g) => g.status === "active") ? (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm text-text md:px-5">
          <MessageCircleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
          <span>Open chat is off for Employees until a Partner allows WhatsApp in a browser window.</span>
        </p>
      ) : null}

      {live.length === 0 ? (
        <section aria-label="WhatsApp group" className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={<MessageCircleIcon />}
            message={`${
              closed.length
                ? `${client.display_name} has no open WhatsApp group. Its earlier ${closed.length === 1 ? "group is" : "groups are"} listed below.`
                : `${client.display_name} has no WhatsApp group yet. Every client gets one, with the Partners' numbers, the Managers' office, the Staff office and the client's people.`
            }${canManage ? "" : " A Partner or Manager sets it up."}`}
            action={canManage ? <StartGroupButton clientId={client.id} groupName={baseName} /> : undefined}
          />
        </section>
      ) : (
        live.map(card)
      )}

      {canManage && live.length > 0 ? (
        <div className="flex justify-end">
          <AddGroupButton clientId={client.id} baseName={baseName} clientCode={client.client_code} />
        </div>
      ) : null}

      {closed.length ? (
        <details className="group flex flex-col gap-3" open={live.length === 0}>
          <summary className="min-h-10 cursor-pointer list-none rounded-md py-2 text-sm font-medium text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            Closed {closed.length === 1 ? "group" : "groups"} <span className="num">({closed.length})</span>
          </summary>
          <div className="flex flex-col gap-3">{closed.map(card)}</div>
        </details>
      ) : null}

      <HouseRulesDisclosure text={settings.houseRules} />
    </div>
  )
}

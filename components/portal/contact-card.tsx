import Link from "next/link"
import { MailIcon, MapPinIcon, MessageSquareIcon, PhoneIcon, GlobeIcon } from "lucide-react"
import { SectionCard } from "@/components/app/section-card"
import { displayWebsite, formatFirmAddress, type FirmProfile } from "@/server/firm"
import type { PortalOwner } from "@/lib/data/portal"

/**
 * The firm's contact card (§7.22 Home "the firm's contact card with the owner's name", Help "the
 * firm's contact details"): the person who looks after the client, then the office. Phone numbers
 * and email open the phone's dialler and mail app. No WhatsApp here (§7.25: the portal never
 * offers WhatsApp chats). Server-safe.
 */

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`
}

function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex min-h-9 items-start gap-2.5 py-1 text-base text-text">
      <span aria-hidden="true" className="mt-0.5 text-text-muted [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  )
}

export function OwnerContact({ owner }: { owner: PortalOwner | null }) {
  if (!owner) {
    return <p className="text-base text-text-muted">Your accountant will be assigned shortly. Until then, the office below can help.</p>
  }
  return (
    <div>
      <p className="text-sm text-text-muted">Your accountant</p>
      <p className="text-md font-semibold text-text">{owner.name}</p>
      {owner.designation ? <p className="text-sm text-text-muted">{owner.designation}</p> : null}
      <ul className="mt-2">
        {owner.phone ? (
          <Line icon={<PhoneIcon />}>
            <a href={telHref(owner.phone)} className="num font-medium text-primary tabular-nums hover:underline">
              {owner.phone}
            </a>
          </Line>
        ) : null}
        {owner.email ? (
          <Line icon={<MailIcon />}>
            <a href={`mailto:${owner.email}`} className="font-medium break-all text-primary hover:underline">
              {owner.email}
            </a>
          </Line>
        ) : null}
      </ul>
    </div>
  )
}

export function FirmContact({ firm }: { firm: FirmProfile }) {
  const address = formatFirmAddress(firm)
  const website = displayWebsite(firm.website)
  return (
    <div>
      <p className="text-sm text-text-muted">The office</p>
      <p className="text-md font-semibold text-text">{firm.legalName ?? firm.firmName}</p>
      <ul className="mt-2">
        {address ? <Line icon={<MapPinIcon />}>{address}</Line> : null}
        {firm.phone ? (
          <Line icon={<PhoneIcon />}>
            <a href={telHref(firm.phone)} className="num font-medium text-primary tabular-nums hover:underline">
              {firm.phone}
            </a>
          </Line>
        ) : null}
        {firm.email ? (
          <Line icon={<MailIcon />}>
            <a href={`mailto:${firm.email}`} className="font-medium break-all text-primary hover:underline">
              {firm.email}
            </a>
          </Line>
        ) : null}
        {website && firm.website ? (
          <Line icon={<GlobeIcon />}>
            <a href={/^https?:\/\//i.test(firm.website) ? firm.website : `https://${firm.website}`} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
              {website}
            </a>
          </Line>
        ) : null}
      </ul>
    </div>
  )
}

/** Home's card: the owner first, then the office, and the way to write to them. */
export function ContactCard({ owner, firm }: { owner: PortalOwner | null; firm: FirmProfile }) {
  return (
    <SectionCard
      title="Your contact at the firm"
      footer={
        <Link href="/portal/messages" className="inline-flex min-h-9 items-center gap-2 text-sm font-medium text-primary hover:underline">
          <MessageSquareIcon aria-hidden="true" className="size-4" />
          Send a message
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <OwnerContact owner={owner} />
        <div className="border-t border-border pt-4">
          <FirmContact firm={firm} />
        </div>
      </div>
    </SectionCard>
  )
}

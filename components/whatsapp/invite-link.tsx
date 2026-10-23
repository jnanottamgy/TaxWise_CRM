"use client"

import * as React from "react"
import { toast } from "sonner"
import { EyeIcon, EyeOffIcon, LinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CopyButton } from "@/components/app/copy-button"
import { revealWhatsAppInviteLink } from "@/server/actions/whatsapp-groups"
import { InviteLinkDialog } from "@/components/whatsapp/group-dialogs"

/** How long a revealed link stays on screen. */
const SHOW_MS = 60_000

/**
 * The group's invite link (§7.25.1): Partners and Managers only, hidden until Reveal, then copy.
 * The link is never in the page: Reveal fetches it through an audited server action
 * (record_viewed), and it hides itself again after a minute.
 */
export function InviteLink({ groupId, updatedAt, hasLink, editable }: { groupId: string; updatedAt: string; hasLink: boolean; editable: boolean }) {
  const [link, setLink] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setLink(null)
  }

  const reveal = async () => {
    setPending(true)
    try {
      const r = await revealWhatsAppInviteLink({ groupId })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      setLink(r.data.link)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setLink(null), SHOW_MS)
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {link ? (
        <>
          <span className="max-w-full font-mono text-[13px] [overflow-wrap:anywhere] text-text">{link}</span>
          <CopyButton value={link} label="invite link" showText />
          <Button type="button" variant="ghost" size="xs" onClick={hide}>
            <EyeOffIcon aria-hidden="true" />
            Hide
          </Button>
        </>
      ) : hasLink ? (
        <>
          <span className="text-text-muted" aria-label="Hidden">
            ••••••••••
          </span>
          <Button type="button" variant="outline" size="xs" onClick={reveal} disabled={pending}>
            {pending ? <Spinner /> : <EyeIcon aria-hidden="true" />}
            Reveal
          </Button>
        </>
      ) : (
        <span className="text-sm text-text-muted">No invite link saved</span>
      )}
      {editable ? (
        <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)}>
          <LinkIcon aria-hidden="true" />
          {hasLink ? "Replace" : "Add link"}
        </Button>
      ) : null}
      {editing ? <InviteLinkDialog open={editing} onOpenChange={setEditing} groupId={groupId} updatedAt={updatedAt} hasLink={hasLink} /> : null}
    </div>
  )
}

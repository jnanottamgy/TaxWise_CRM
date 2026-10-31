"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BanIcon, FileDownIcon, FileUpIcon, MoreHorizontalIcon, PencilIcon, SendIcon, SignatureIcon, StampIcon, Trash2Icon, Undo2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import type { EngagementStatus } from "@/lib/domain/enums"
import { deleteLetterDraft, withdrawLetter } from "@/server/actions/engagement-letters"
import { RenewButton } from "@/components/engagement-letters/renew-button"
import { AttachCopyDialog, DeclineLetterDialog, IssueLetterDialog, SignLetterDialog, type DialogLetter } from "@/components/engagement-letters/letter-dialogs"
import { SendLetterDialog, type LetterMessaging, type LetterRecipient } from "@/components/engagement-letters/send-letter-dialog"
import { toastResult } from "@/components/registers/shared"

type DialogName = "issue" | "send" | "sign" | "copy" | "decline" | "withdraw" | "delete"

export type ActionLetter = DialogLetter & {
  status: EngagementStatus
  displayStatus: EngagementStatus
  hasSignedCopy: boolean
  renewed: boolean
  signatoryName: string | null
  clientCode: string
}

/**
 * The letter's next step (§7.15.3), one primary button by its state: a Draft is issued and sent for
 * signature; an Issued letter is marked signed with the signed copy; a Signed one without its copy
 * gets it uploaded; an expiring or expired one is renewed for the next FY. The PDF is always there;
 * the rest is under More. The database refuses any move the lifecycle doesn't allow.
 */
export function LetterActions({
  letter,
  recipients,
  messaging,
  today,
  expiring,
}: {
  letter: ActionLetter
  recipients: LetterRecipient[]
  messaging: LetterMessaging | null
  today: string
  expiring: boolean
}) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<DialogName | null>(null)
  const close = () => setDialog(null)
  const s = letter.status
  const canRenew = !letter.renewed && (s === "issued" || s === "signed" || s === "expired")

  const more: Array<{ key: string; label: string; icon: React.ReactNode; onSelect: () => void; danger?: boolean }> = []
  if (s === "draft") {
    more.push({ key: "issue", label: "Issue without sending", icon: <StampIcon aria-hidden="true" />, onSelect: () => setDialog("issue") })
    more.push({ key: "edit", label: "Edit draft", icon: <PencilIcon aria-hidden="true" />, onSelect: () => router.push(`/engagement-letters/${letter.id}/edit`) })
    more.push({ key: "delete", label: "Delete draft", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog("delete"), danger: true })
  }
  if (s === "issued") {
    more.push({ key: "send", label: "Send for signature again", icon: <SendIcon aria-hidden="true" />, onSelect: () => setDialog("send") })
    if (!letter.hasSignedCopy) more.push({ key: "copy", label: "Upload the signed copy", icon: <FileUpIcon aria-hidden="true" />, onSelect: () => setDialog("copy") })
    more.push({ key: "withdraw", label: "Withdraw to a draft", icon: <Undo2Icon aria-hidden="true" />, onSelect: () => setDialog("withdraw") })
    more.push({ key: "decline", label: "Client declined", icon: <BanIcon aria-hidden="true" />, onSelect: () => setDialog("decline"), danger: true })
  }
  if (s === "signed" && letter.hasSignedCopy) more.push({ key: "copy", label: "Replace the signed copy", icon: <FileUpIcon aria-hidden="true" />, onSelect: () => setDialog("copy") })
  if (s === "declined") more.push({ key: "withdraw", label: "Back to a draft", icon: <Undo2Icon aria-hidden="true" />, onSelect: () => setDialog("withdraw") })

  const primary =
    s === "draft" ? (
      <Button onClick={() => setDialog("send")}>
        <SendIcon aria-hidden="true" />
        Issue and send
      </Button>
    ) : s === "issued" && letter.displayStatus !== "expired" ? (
      <Button onClick={() => setDialog("sign")}>
        <SignatureIcon aria-hidden="true" />
        Mark signed
      </Button>
    ) : s === "signed" && !letter.hasSignedCopy && letter.displayStatus !== "expired" ? (
      <Button onClick={() => setDialog("copy")}>
        <FileUpIcon aria-hidden="true" />
        Upload signed copy
      </Button>
    ) : canRenew && (expiring || letter.displayStatus === "expired") ? (
      <RenewButton letterId={letter.id} financialYear={letter.financialYear} size="default" variant="default" />
    ) : null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline">
          <a href={`/api/pdf/engagement-letter/${letter.id}`} target="_blank" rel="noopener">
            <FileDownIcon aria-hidden="true" />
            {s === "draft" ? "Preview PDF" : "PDF"}
          </a>
        </Button>
        {canRenew && !(expiring || letter.displayStatus === "expired") ? <RenewButton letterId={letter.id} financialYear={letter.financialYear} size="default" /> : null}
        {more.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label="More actions">
                <MoreHorizontalIcon aria-hidden="true" />
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {more.map((m, i) => (
                <React.Fragment key={m.key}>
                  {m.danger && i > 0 && !more[i - 1]?.danger ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem onSelect={m.onSelect} className={m.danger ? "text-danger-text focus:text-danger-text" : undefined}>
                    {m.icon}
                    {m.label}
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {s === "draft" ? (
          <Button asChild variant="outline" className="hidden sm:inline-flex">
            <Link href={`/engagement-letters/${letter.id}/edit`}>
              <PencilIcon aria-hidden="true" />
              Edit
            </Link>
          </Button>
        ) : null}
        {primary}
      </div>

      {dialog === "issue" ? <IssueLetterDialog open onOpenChange={(o) => !o && close()} letter={letter} /> : null}
      {dialog === "send" ? (
        <SendLetterDialog
          open
          onOpenChange={(o) => !o && close()}
          letter={{ id: letter.id, updatedAt: letter.updatedAt, status: letter.status, clientName: letter.clientName, clientCode: letter.clientCode, financialYear: letter.financialYear, signatoryName: letter.signatoryName }}
          recipients={recipients}
          messaging={messaging}
          today={today}
        />
      ) : null}
      {dialog === "sign" ? <SignLetterDialog open onOpenChange={(o) => !o && close()} letter={letter} /> : null}
      {dialog === "copy" ? <AttachCopyDialog open onOpenChange={(o) => !o && close()} letter={letter} /> : null}
      {dialog === "decline" ? <DeclineLetterDialog open onOpenChange={(o) => !o && close()} letter={letter} /> : null}
      <ConfirmDialog
        open={dialog === "withdraw"}
        onOpenChange={(o) => !o && close()}
        title={s === "declined" ? "Take the letter back to a draft?" : "Withdraw the letter to a draft?"}
        description={s === "declined" ? "You can then change it and issue a revised letter." : "Its issue date is cleared so it can be changed and issued again. The client may still have the issued copy: tell them a revised one is coming."}
        confirmLabel={s === "declined" ? "Back to draft" : "Withdraw to draft"}
        onConfirm={async () => {
          const r = await withdrawLetter({ id: letter.id, updatedAt: letter.updatedAt })
          if (!toastResult(r, "Back to a draft")) return false
          close()
          router.refresh()
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && close()}
        title="Delete this draft letter?"
        description={`The draft for ${letter.clientName}, FY ${letter.financialYear}, is removed. Issued letters are never deleted.`}
        confirmLabel="Delete draft"
        destructive
        onConfirm={async () => {
          const r = await deleteLetterDraft({ id: letter.id, updatedAt: letter.updatedAt })
          if (!toastResult(r, "Draft deleted")) return false
          router.push("/engagement-letters")
          router.refresh()
        }}
      />
    </>
  )
}

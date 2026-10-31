"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { KeyRoundIcon, UserPlusIcon, ShieldOffIcon, UndoIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Explain } from "@/components/app/explain"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { formatDate, formatTimeAgo } from "@/lib/format"
import { RevokePortalSchema } from "@/components/client360/logic/profile-schemas"
import { invitePortal, resendPortalInvite, revokePortalAccess, type PortalHandout } from "@/server/actions/portal-access"
import { PortalHandoutDialog } from "@/components/client360/overview/portal-handout-dialog"

type Dialog = "invite" | "resend" | "revoke" | null

/**
 * Portal access (§7.22 "Access"; §7.3.3 Overview "portal access card (invite / resend / revoke /
 * last seen)"). Partners and Managers invite (a login with role client, linked only through
 * clients.portal_user_id), send a new temporary password, revoke (unlink and ban) or restore a
 * revoked login; everyone else sees the state. After an invite or resend the login details are
 * shown once with Share on WhatsApp (like a staff login, §4.5); nothing is emailed. Resend is also
 * how a client who forgot their password gets back in.
 */
export function PortalCard({
  clientId,
  clientName,
  updatedAt,
  canManage,
  linked,
  invitedAt,
  lastSeenAt,
  revokedAt,
  revokedBy,
  canRestore,
  inviteEmail,
}: {
  clientId: string
  clientName: string
  updatedAt: string
  canManage: boolean
  linked: boolean
  invitedAt: string | null
  lastSeenAt: string | null
  revokedAt: string | null
  revokedBy: string | null
  canRestore: boolean
  inviteEmail: { email: string; label: string } | null
}) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const [handout, setHandout] = React.useState<PortalHandout | null>(null)
  const close = (o: boolean) => !o && setDialog(null)

  const state: { label: string; tone: "success" | "warning" | "muted"; meaning: string; line: string } = linked
    ? lastSeenAt
      ? { label: "Active", tone: "success", meaning: "Active: the client has signed in to the portal.", line: `Last seen ${formatTimeAgo(lastSeenAt)}${invitedAt ? ` · invited ${formatDate(invitedAt)}` : ""}` }
      : {
          label: "Invite pending",
          tone: "warning",
          meaning: "Invite pending: a login exists but the client hasn't signed in yet. Resend it if they lost the WhatsApp message.",
          line: invitedAt ? `Invited ${formatDate(invitedAt)}; not signed in yet` : "Not signed in yet",
        }
    : revokedAt
      ? { label: "Revoked", tone: "muted", meaning: "Revoked: the login is blocked and unlinked from this client.", line: `Revoked ${formatDate(revokedAt)}${revokedBy ? ` by ${revokedBy}` : ""}` }
      : { label: "Not invited", tone: "muted", meaning: "Not invited: the client has no portal login yet.", line: inviteEmail ? `They sign in with ${inviteEmail.email} (${inviteEmail.label.toLowerCase()}).` : "Add an email address for the client or a contact to invite them: it is what they sign in with." }

  const run = async (fn: () => Promise<{ ok: true; data: PortalHandout; warnings?: string[] } | { ok: false; error: string; ref?: string }>) => {
    const r = await fn()
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
    setHandout(r.data)
    router.refresh()
  }

  const inviteDisabled = !inviteEmail && !canRestore
  return (
    <SectionCard id="portal-access" title="Portal access" description="The client's own sign-in to see deadlines, upload documents and view invoices">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusChip label={state.label} tone={state.tone} meaning={state.meaning} variant="pill" />
          <p className="text-sm text-text-muted">{state.line}</p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {linked ? (
              <>
                <Button type="button" variant="outline" size="sm" onClick={() => setDialog("resend")}>
                  <KeyRoundIcon aria-hidden="true" />
                  {lastSeenAt ? "Reset password" : "Resend invite"}
                </Button>
                <Button type="button" variant="destructive-outline" size="sm" onClick={() => setDialog("revoke")}>
                  <ShieldOffIcon aria-hidden="true" />
                  Revoke access
                </Button>
              </>
            ) : inviteDisabled ? (
              <Explain content={<p>Add an email address for {clientName} or one of its contacts first: it is what they sign in with.</p>}>
                <Button type="button" variant="outline" size="sm" aria-disabled="true" className="cursor-not-allowed text-text-muted hover:bg-surface hover:text-text-muted">
                  <UserPlusIcon aria-hidden="true" />
                  Invite to portal
                </Button>
              </Explain>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setDialog("invite")}>
                {canRestore ? <UndoIcon aria-hidden="true" /> : <UserPlusIcon aria-hidden="true" />}
                {canRestore ? "Restore access" : "Invite to portal"}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {canManage ? (
        <>
          <ConfirmDialog
            open={dialog === "invite"}
            onOpenChange={close}
            title={canRestore ? `Restore ${clientName}'s portal access?` : `Invite ${clientName} to the portal?`}
            description={
              canRestore
                ? "Their earlier login is unblocked and linked to this client again, with a new temporary password they must change at first sign-in. The details are shown to you once, to share on WhatsApp."
                : `A portal login is created for ${inviteEmail?.email ?? "the client's email"} with a temporary password they must change at first sign-in. The details are shown to you once, to share on WhatsApp.`
            }
            confirmLabel={canRestore ? "Restore access" : "Create login and invite"}
            onConfirm={() => run(() => invitePortal({ clientId, updatedAt }))}
          />
          <ConfirmDialog
            open={dialog === "resend"}
            onOpenChange={close}
            title={lastSeenAt ? "Reset the portal password?" : "Send the invite again?"}
            description="A new temporary password replaces the old one, which stops working at once, and the client is signed out everywhere. It is shown to you once, to share on WhatsApp."
            confirmLabel={lastSeenAt ? "Reset password" : "Resend invite"}
            onConfirm={() => run(() => resendPortalInvite({ clientId, updatedAt }))}
          />
          <RevokeDialog open={dialog === "revoke"} onOpenChange={close} clientId={clientId} clientName={clientName} updatedAt={updatedAt} />
          <PortalHandoutDialog handout={handout} onClose={() => setHandout(null)} />
        </>
      ) : null}
    </SectionCard>
  )
}

function RevokeDialog({ open, onOpenChange, clientId, clientName, updatedAt }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; clientName: string; updatedAt: string }) {
  const router = useRouter()
  const f = useActionForm(RevokePortalSchema, revokePortalAccess, {
    defaultValues: { clientId, updatedAt, reason: "" },
    successMessage: "Portal access revoked.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset({ clientId, updatedAt, reason: "" })
    // Reset when the dialog opens with the latest updated_at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Revoke ${clientName}'s portal access?`}
      description="The login is unlinked from this client at once, blocked from signing in and signed out everywhere. You can restore it later."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Revoke access"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <TextareaField control={f.control} name="reason" label="Reason" required rows={3} maxLength={500} placeholder="Client moved to another firm" />
      </div>
    </FormDialog>
  )
}

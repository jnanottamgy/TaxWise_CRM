"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowRightLeftIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  MailIcon,
  PencilIcon,
  ShieldOffIcon,
  Trash2Icon,
  UserCheckIcon,
  UserCogIcon,
  UserXIcon,
  UsersRoundIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import type { AppRole } from "@/lib/auth/roles"
import { canManagePerson } from "@/lib/schemas/people"
import type { PersonOption } from "@/lib/data/people"
import { issueLogin, resetPassword, resetTwoStepSignIn, setPersonActive, type LoginHandout } from "@/server/actions/people"
import { ChangeEmailDialog, ChangeRoleDialog, EditPersonDialog, type EditablePerson } from "@/components/people/person-dialogs"
import { ReassignDialog, RetireDialog } from "@/components/people/lifecycle-dialogs"
import { LoginCreatedDialog } from "@/components/people/login-created-dialog"
import { CoverDialog } from "@/components/covers/cover-dialog"

type Dialog = "edit" | "email" | "role" | "reassign" | "disable" | "delete" | "enable" | "reset" | "issue" | "two-step" | "cover" | null

/**
 * The person page's actions (§4.5, §7.11.1 "Add · Import CSV · Issue logins · Reset password ·
 * Change email · Change role · Disable/Enable · Reassign work · Delete (Partner)"), plus Cover their
 * clients (§4.7). Only what the viewer may do is offered (§4.1: Managers manage Employees only);
 * the server refuses the rest anyway.
 */
export function PersonActions({
  person,
  actor,
  staff,
  autoOpenCover = false,
}: {
  person: EditablePerson
  actor: { role: AppRole; userId: string }
  staff: PersonOption[]
  /** Opens Cover their clients at once (the Absent today without cover link). */
  autoOpenCover?: boolean
}) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<Dialog>(autoOpenCover ? "cover" : null)
  const [login, setLogin] = React.useState<LoginHandout | null>(null)
  const close = (o: boolean) => !o && setDialog(null)

  const manage = canManagePerson(actor.role, person.role)
  const self = person.profile_id === actor.userId
  const partner = actor.role === "partner"
  const disabled = person.login_status === "disabled"
  const hasLogin = !!person.profile_id
  const canCover = (actor.role === "partner" || actor.role === "manager") && !disabled

  if (!manage && !canCover) return null

  const run = async (fn: () => Promise<{ ok: true; data: LoginHandout; warnings?: string[] } | { ok: false; error: string; ref?: string }>) => {
    const r = await fn()
    if (!r.ok) {
      toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
      return false
    }
    for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
    setLogin(r.data)
    router.refresh()
  }

  return (
    <>
      {canCover ? (
        <Button type="button" variant="outline" onClick={() => setDialog("cover")}>
          <UsersRoundIcon aria-hidden="true" />
          Cover their clients
        </Button>
      ) : null}
      {manage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline">
              Manage
              <ChevronDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs font-medium text-text-muted">{person.full_name}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setDialog("edit")}>
              <PencilIcon aria-hidden="true" />
              Edit details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog("email")}>
              <MailIcon aria-hidden="true" />
              Change email
            </DropdownMenuItem>
            {partner && !self ? (
              <DropdownMenuItem onSelect={() => setDialog("role")}>
                <UserCogIcon aria-hidden="true" />
                Change role
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {!hasLogin && !disabled ? (
              <DropdownMenuItem onSelect={() => setDialog("issue")}>
                <KeyRoundIcon aria-hidden="true" />
                Issue login
              </DropdownMenuItem>
            ) : null}
            {hasLogin && !disabled && !self ? (
              <DropdownMenuItem onSelect={() => setDialog("reset")}>
                <KeyRoundIcon aria-hidden="true" />
                Reset password
              </DropdownMenuItem>
            ) : null}
            {partner && hasLogin && !self ? (
              <DropdownMenuItem onSelect={() => setDialog("two-step")}>
                <ShieldOffIcon aria-hidden="true" />
                Reset two-step sign-in
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => setDialog("reassign")}>
              <ArrowRightLeftIcon aria-hidden="true" />
              Reassign all work…
            </DropdownMenuItem>
            {!self ? <DropdownMenuSeparator /> : null}
            {!self && !disabled ? (
              <DropdownMenuItem onSelect={() => setDialog("disable")} className="text-danger-text focus:text-danger-text">
                <UserXIcon aria-hidden="true" />
                Disable…
              </DropdownMenuItem>
            ) : null}
            {!self && disabled ? (
              <DropdownMenuItem onSelect={() => setDialog("enable")}>
                <UserCheckIcon aria-hidden="true" />
                Enable
              </DropdownMenuItem>
            ) : null}
            {partner && !self ? (
              <DropdownMenuItem onSelect={() => setDialog("delete")} className="text-danger-text focus:text-danger-text">
                <Trash2Icon aria-hidden="true" />
                Delete…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {dialog === "edit" ? <EditPersonDialog person={person} actorRole={actor.role} open onOpenChange={close} /> : null}
      {dialog === "email" ? <ChangeEmailDialog person={person} open onOpenChange={close} /> : null}
      {dialog === "role" ? <ChangeRoleDialog person={person} open onOpenChange={close} /> : null}
      {dialog === "reassign" ? <ReassignDialog person={person} staff={staff} open onOpenChange={close} /> : null}
      {dialog === "disable" || dialog === "delete" ? <RetireDialog person={person} mode={dialog} staff={staff} open onOpenChange={close} /> : null}
      {dialog === "cover" ? (
        <CoverDialog target={{ kind: "person", employeeId: person.id, name: person.full_name }} actorRole={actor.role} open onOpenChange={close} />
      ) : null}

      <ConfirmDialog
        open={dialog === "enable"}
        onOpenChange={close}
        title={`Enable ${person.full_name}?`}
        description={hasLogin ? "They can sign in again with their existing password, and see their clients and tasks as before." : "Their record is active again. Issue a login so they can sign in."}
        confirmLabel="Enable"
        onConfirm={async () => {
          const r = await setPersonActive({ id: person.id, active: true, updated_at: person.updated_at })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success(`${person.full_name} is enabled.`)
          router.refresh()
        }}
      />
      <ConfirmDialog
        open={dialog === "issue"}
        onOpenChange={close}
        title={`Create a login for ${person.full_name}?`}
        description={`A temporary password is created for ${person.email}. You'll see it once, to share on WhatsApp; nothing is emailed.`}
        confirmLabel="Create login"
        onConfirm={() => run(() => issueLogin({ id: person.id }))}
      />
      <ConfirmDialog
        open={dialog === "reset"}
        onOpenChange={close}
        title={`Reset ${person.full_name}'s password?`}
        description="Their current password stops working at once and they are signed out everywhere. You'll see a new temporary password once, to share on WhatsApp; they set their own at the next sign-in."
        confirmLabel="Reset password"
        destructive
        onConfirm={() => run(() => resetPassword({ id: person.id }))}
      />
      <ConfirmDialog
        open={dialog === "two-step"}
        onOpenChange={close}
        title={`Reset ${person.full_name}'s two-step sign-in?`}
        description="Their authenticator app stops working for TaxWise and they are signed out. At the next sign-in they set it up again. Use this when they lost or replaced their phone."
        confirmLabel="Reset two-step sign-in"
        destructive
        onConfirm={async () => {
          const r = await resetTwoStepSignIn({ id: person.id })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success(r.data.removed ? "Two-step sign-in reset. They set it up again at their next sign-in." : "They had no authenticator set up; nothing to reset.")
          router.refresh()
        }}
      />
      {login ? <LoginCreatedDialog logins={[login]} open={!!login} onOpenChange={(o) => !o && setLogin(null)} /> : null}
    </>
  )
}

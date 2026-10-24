"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useWatch } from "react-hook-form"
import { LogOutIcon, MonitorSmartphoneIcon, ShieldCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { FormAlert } from "@/components/app/form/form-alert"
import { PasswordField } from "@/components/app/form/fields"
import { PasswordChecklist } from "@/components/app/form/password-input"
import { useActionForm } from "@/hooks/use-action-form"
import { checkPassword } from "@/lib/auth/password-policy"
import { ChangePasswordSchema } from "@/lib/schemas/auth"
import { formatDateTime, formatMinutes, formatTimeAgo } from "@/lib/format"
import { changePassword } from "@/server/actions/auth"
import { signOutOtherSessions } from "@/server/actions/profile"
import { ProfileCard } from "@/components/people/profile-card"

// -------------------------------------------------------------------------------------------------
// Change password (§7.1: current, new, confirm, with the policy checklist)
// -------------------------------------------------------------------------------------------------

export function ChangePasswordCard({ email }: { email: string }) {
  const f = useActionForm(ChangePasswordSchema, changePassword, {
    defaultValues: { current: "", password: "", confirm: "" },
    resetOnSuccess: false,
    onSuccess: () => {
      f.form.reset({ current: "", password: "", confirm: "" })
      toast.success("Password changed. Your other devices are signed out.")
    },
  })
  const password = (useWatch({ control: f.control, name: "password" }) as string | undefined) ?? ""
  return (
    <ProfileCard id="password" title="Password" description="You stay signed in here. Other devices sign in again with the new password.">
      <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
        <FormAlert state={f} />
        {/* Lets password managers file the new password under the right login. */}
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <PasswordField control={f.control} name="current" label="Current password" required autoComplete="current-password" className="md:col-span-2 md:max-w-[calc(50%-0.75rem)]" />
          <PasswordField
            control={f.control}
            name="password"
            label="New password"
            required
            autoComplete="new-password"
            checklist={() => <PasswordChecklist items={checkPassword(password).map((c) => ({ label: c.label, met: c.ok }))} />}
          />
          <PasswordField control={f.control} name="confirm" label="Type it again" required autoComplete="new-password" />
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={f.pending}>
            {f.pending ? <Spinner /> : null}
            Change password
          </Button>
        </div>
      </form>
    </ProfileCard>
  )
}

// -------------------------------------------------------------------------------------------------
// Two-step sign-in (§4.4)
// -------------------------------------------------------------------------------------------------

export function TwoStepCard({ enrolled, required, since }: { enrolled: boolean; required: boolean; since: string | null }) {
  return (
    <ProfileCard
      id="two-step"
      title="Two-step sign-in"
      description="A code from an authenticator app on your phone, as well as your password."
      action={
        enrolled ? (
          <StatusChip label="On" tone="success" meaning="On: signing in asks for a code from your authenticator app." />
        ) : (
          <StatusChip label="Off" tone={required ? "warning" : "muted"} meaning={required ? "Off: Partners and Managers must turn it on." : "Off: signing in asks only for your password."} />
        )
      }
    >
      {enrolled ? (
        <p className="text-base text-text">
          Your authenticator app is set up{since ? ` (since ${formatDateTime(since)})` : ""}. Lost your phone? A Partner resets two-step sign-in from People, and you set it up again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[60ch] text-base text-text">
            {required ? "Partners and Managers must use it. Set it up now: it takes a minute." : "Optional for you, and a good idea: a stolen password alone won't get anyone in."}
          </p>
          <Button asChild size="sm" variant={required ? "default" : "outline"}>
            <Link href="/mfa?enrol=1&next=/profile">
              <ShieldCheckIcon aria-hidden="true" />
              Set up two-step sign-in
            </Link>
          </Button>
        </div>
      )}
    </ProfileCard>
  )
}

// -------------------------------------------------------------------------------------------------
// Sessions (§7.1: device, last seen, "sign out other sessions")
// -------------------------------------------------------------------------------------------------

export interface ProfileSession {
  id: string
  device: string
  ip: string | null
  loginAt: string
  lastActiveAt: string
  logoutAt: string | null
  activeMinutes: number
  isActive: boolean
  closedReason: string | null
}

const CLOSED: Record<string, string> = {
  logout: "Signed out",
  stale: "Timed out",
  day_end: "Closed at day end",
}

export function SessionsCard({ sessions, now: serverNow }: { sessions: ProfileSession[]; /** The server's render time (ISO), so "last seen 2 minutes ago" hydrates to the same text. */ now?: string }) {
  const [now] = React.useState(() => (serverNow ? new Date(serverNow) : new Date()))
  const router = useRouter()
  const [confirm, setConfirm] = React.useState(false)
  return (
    <ProfileCard
      id="sessions"
      title="Sessions"
      description="Where you've signed in recently, and how long you were active."
      action={
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirm(true)}>
          <LogOutIcon aria-hidden="true" />
          Sign out other sessions
        </Button>
      }
    >
      {sessions.length === 0 ? (
        <p className="text-sm text-text-muted">No sessions recorded yet. They appear after you next sign in.</p>
      ) : (
        <ul className="-my-2 divide-y divide-border/70">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
              <div className="flex min-w-0 items-start gap-2.5">
                <MonitorSmartphoneIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
                <div className="min-w-0">
                  <p className="text-base font-medium text-text">
                    {s.device}
                    {s.ip ? <span className="num ml-2 text-sm font-normal text-text-muted">{s.ip}</span> : null}
                  </p>
                  <p className="num text-sm text-text-muted">
                    Signed in {formatDateTime(s.loginAt)} · {s.isActive ? `last seen ${formatTimeAgo(s.lastActiveAt, now)}` : `${CLOSED[s.closedReason ?? ""] ?? "Ended"} ${formatDateTime(s.logoutAt ?? s.lastActiveAt)}`} · active{" "}
                    {formatMinutes(s.activeMinutes)}
                  </p>
                </div>
              </div>
              {s.isActive ? <StatusChip label="Active" tone="success" meaning="Active: this session is open now." /> : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out your other sessions?"
        description="Every other browser, phone and TaxWise Desktop signed in as you is signed out at once. You stay signed in here."
        confirmLabel="Sign out others"
        onConfirm={async () => {
          const r = await signOutOtherSessions({})
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          toast.success("Your other sessions are signed out.")
          router.refresh()
        }}
      />
    </ProfileCard>
  )
}

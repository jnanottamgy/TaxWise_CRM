import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { mfaRequiredFor } from "@/lib/auth/mfa"
import { logUnexpected } from "@/lib/log"
import { parsePreferences } from "@/lib/preferences"
import { applySignature, firstNameOf, MESSAGING_DEFAULTS } from "@/lib/domain/messaging"
import { readDigestPreference, readEmailPreferences, readWhatsAppSignaturePreference } from "@/lib/schemas/profile"
import { deviceLabel } from "@/lib/schemas/people"
import { getRecentSessions } from "@/lib/data/attendance"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { PartnerDetailsCard, ProfileDetailsCard, type StoredImage } from "@/components/people/profile-details"
import { AppearanceCard, MessagingCard, NotificationsCard } from "@/components/people/profile-preferences"
import { ChangePasswordCard, SessionsCard, TwoStepCard, type ProfileSession } from "@/components/people/profile-security"

export const metadata: Metadata = { title: "Profile" }

type Supabase = Awaited<ReturnType<typeof requireStaff>>["supabase"]

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/profile:${source}`, userId }) }
  }
}

async function signedImage(supabase: Supabase, path: string | null): Promise<StoredImage> {
  if (!path) return { path: null, url: null }
  const { data } = await supabase.storage.from("profile-images").createSignedUrl(path, 300)
  return { path, url: data?.signedUrl ?? null }
}

/**
 * Profile (§7.1), for every staff member: your details and photo; Partners their ICAI membership
 * number and signature image; theme and density; notification choices per event and channel; the
 * WhatsApp signature; password; two-step sign-in; sessions. Everything is read and written under
 * your own session.
 */
export default async function ProfilePage() {
  const { user, supabase } = await requireStaff()

  const loaded = await attempt("profile", user.id, async () => {
    const [profile, employee, firm] = await Promise.all([
      supabase.from("profiles").select("full_name, phone, email, role, avatar_path, signature_path, icai_membership_no, preferences").eq("id", user.id).single(),
      supabase.from("employees").select("designation, department, date_of_joining").eq("profile_id", user.id).is("deleted_at", null).maybeSingle(),
      supabase.from("firm_settings").select("whatsapp_signature").eq("id", 1).maybeSingle(),
    ])
    if (profile.error) throw profile.error
    if (employee.error) throw employee.error
    if (firm.error) throw firm.error
    const [avatar, signature] = await Promise.all([
      signedImage(supabase, profile.data.avatar_path),
      user.role === "partner" ? signedImage(supabase, profile.data.signature_path) : Promise.resolve({ path: null, url: null }),
    ])
    return { profile: profile.data, employee: employee.data, signatureFormat: firm.data?.whatsapp_signature ?? MESSAGING_DEFAULTS.whatsappSignature, avatar, signature }
  })

  const security = await attempt("security", user.id, async () => {
    const [factors, sessions] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      user.employeeId ? getRecentSessions(supabase, user.employeeId, 8) : Promise.resolve([]),
    ])
    if (factors.error) throw factors.error
    const verified = (factors.data?.totp ?? []).filter((f) => f.status === "verified")
    return {
      enrolled: verified.length > 0,
      since: verified.length ? verified.map((f) => f.created_at).sort()[0] : null,
      sessions: sessions.map(
        (s): ProfileSession => ({
          id: s.id,
          device: deviceLabel(s.user_agent),
          ip: s.ip,
          loginAt: s.login_at,
          lastActiveAt: s.last_active_at,
          logoutAt: s.logout_at,
          activeMinutes: s.active_minutes,
          isActive: s.is_active,
          closedReason: s.closed_reason,
        }),
      ),
    }
  })

  const prefs = parsePreferences(user.preferences)

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Profile">
        <p>Your name and phone show to the team. Your sign-in email, role and job are changed by a Partner or Manager from People.</p>
        <p className="mt-2">Everything reaches your Inbox; choose here what also comes by email. Changing your password signs out your other devices.</p>
      </PageGuide>
      <PageHeader title="Profile" description="Your details, how TaxWise looks for you, what we email you, and how you sign in." />
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
        {loaded.ok ? (
          <>
            <ProfileDetailsCard
              fullName={loaded.data.profile.full_name}
              phone={loaded.data.profile.phone}
              email={loaded.data.profile.email ?? user.email}
              role={user.role}
              designation={loaded.data.employee?.designation ?? null}
              department={loaded.data.employee?.department ?? null}
              dateOfJoining={loaded.data.employee?.date_of_joining ?? null}
              avatar={loaded.data.avatar}
            />
            {user.role === "partner" ? (
              <PartnerDetailsCard icaiMembershipNo={loaded.data.profile.icai_membership_no} signature={loaded.data.signature} name={loaded.data.profile.full_name} />
            ) : null}
          </>
        ) : (
          <div className="rounded-lg border border-border bg-surface">
            <ErrorBlock message="Couldn't load your details." errorRef={loaded.ref} />
          </div>
        )}
        <AppearanceCard initialDensity={prefs.density} />
        <NotificationsCard
          role={user.role}
          email={readEmailPreferences(loaded.ok ? loaded.data.profile.preferences : user.preferences, user.role)}
          digest={readDigestPreference(loaded.ok ? loaded.data.profile.preferences : user.preferences, user.role)}
        />
        <MessagingCard
          whatsappSignature={readWhatsAppSignaturePreference(loaded.ok ? loaded.data.profile.preferences : user.preferences, user.role)}
          example={applySignature("", loaded.ok ? loaded.data.signatureFormat : MESSAGING_DEFAULTS.whatsappSignature, firstNameOf(user.fullName)) || "your first name"}
        />
        <ChangePasswordCard email={user.email} />
        {security.ok ? (
          <>
            <TwoStepCard enrolled={security.data.enrolled} required={mfaRequiredFor(user.role)} since={security.data.since} />
            <SessionsCard sessions={security.data.sessions} />
          </>
        ) : (
          <div className="rounded-lg border border-border bg-surface">
            <ErrorBlock message="Couldn't load your sign-in details." errorRef={security.ref} />
          </div>
        )}
      </div>
    </div>
  )
}

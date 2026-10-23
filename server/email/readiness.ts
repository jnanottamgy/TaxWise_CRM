import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { resendConfigured } from "@/server/email/resend";
import { emailSendingReady } from "@/server/email/policy";

/**
 * Can the app send automatic email right now? (§7.13.5 "Until verified: automatic client emails are
 * not attempted silently. Every place that would send shows the hand-off buttons instead, with a
 * banner".) For pages that decide, before anything is sent, whether to offer "Send by email" or
 * the WhatsApp / Gmail hand-offs with the banner (components/settings/email/email-setup-banner.tsx).
 *
 *   const email = await getEmailReadiness(supabase);   // a staff session, or the service role
 *   {email.ready ? <SendByEmailButton … /> : <EmailSetupBanner canSetUp={user.role === "partner"} />}
 *
 * The same rule sendEmail applies (server/email/policy.ts emailSendingReady). Never throws: a
 * failed read counts as not ready, so the page falls back to the hand-offs.
 */
export async function getEmailReadiness(supabase: SupabaseClient<Database>): Promise<{ ready: boolean; reason: string | null }> {
  try {
    const { data, error } = await supabase.from("firm_settings").select("domain_status, sending_domain, email_from_address").eq("id", 1).maybeSingle();
    if (error || !data) return { ready: false, reason: "The email settings couldn't be read." };
    const r = emailSendingReady({
      apiKeyPresent: resendConfigured(),
      domainStatus: data.domain_status,
      sendingDomain: data.sending_domain,
      fromAddress: data.email_from_address,
    });
    return r.ready ? { ready: true, reason: null } : { ready: false, reason: r.reason };
  } catch {
    return { ready: false, reason: "The email settings couldn't be read." };
  }
}

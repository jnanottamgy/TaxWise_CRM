import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { env } from "@/lib/env";

/**
 * THE ONLY place the Supabase service-role key is used (§0.1 rule 8, §12).
 *
 * It bypasses RLS. Use it only for the jobs listed in §2.2: creating/banning users, changing an
 * auth email, writing app_metadata.role, scheduled jobs, the credential vault, and the public
 * quotation page's narrow reads/writes. Every caller must do its own role check first.
 *
 * Never import this file (directly or indirectly) from a client component. `server-only` makes the
 * build fail if that happens, and scripts/check-service-role.mjs checks the client bundle.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type AdminSupabase = ReturnType<typeof createAdminClient>;

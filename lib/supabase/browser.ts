"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

/**
 * Browser Supabase client (anon key + the user's session cookie). Use it only for things that
 * must run in the browser: auth flows (reset/update password, MFA enrolment) and signed-URL uploads.
 * Data reads belong in Server Components; writes belong in Server Actions.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

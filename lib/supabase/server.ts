import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { env } from "@/lib/env";
import { authCookieOptions } from "@/lib/supabase/proxy";

/**
 * Supabase client bound to the signed-in user's session. Every read and write through it
 * runs under that user's RLS (§2.3). Create one per request; never store it in a module variable.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(env.supabaseUrl(), env.supabaseAnonKey(), {
    // Same cookie options as the proxy (§12: HttpOnly, SameSite=Lax, Secure over https), so a cookie
    // written by a Server Action (sign-in, MFA, password change) is identical to a proxy refresh.
    cookieOptions: authCookieOptions(env.appUrl().startsWith("https://")),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: cookies are read-only there. The proxy refreshes the session.
        }
      },
    },
  });
}

export type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

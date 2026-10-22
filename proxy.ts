import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16 proxy (formerly middleware). Refreshes the Supabase session cookie and redirects by
 * the `app_metadata.role` hint (§0.1 rule 9, §4.4, §12). It never decides permissions: pages and
 * actions re-check against `profiles.role`, and RLS is the real control. See lib/supabase/proxy.ts.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next's build output and static files served from public/.
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf|css|js|map|txt|xml|webmanifest)$).*)",
  ],
};

import { publicPdfResponse } from "@/server/quotations-public";

/**
 * GET /api/q/<token>/pdf[?download=1]: the quotation PDF behind a client's link (§7.23 "offers the
 * PDF"), no login. Everything goes through server/quotations-public.ts (the only public-token access
 * path): token-scoped, rate-limited, drafts and deleted quotations refused.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return publicPdfResponse(request, token);
}

import { publicPdfResponse } from "@/server/quotations-public";

/**
 * GET /q/<token>/pdf[?download=1]: the public page's "Download PDF" (§7.23), on the page's own
 * public path. Same handler as /api/q/<token>/pdf (server/quotations-public.ts).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return publicPdfResponse(request, token);
}

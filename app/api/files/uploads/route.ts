import type { NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { ActionError, unexpectedMessage } from "@/lib/result";
import { RequestUploadSlotsSchema } from "@/lib/schemas/documents";
import { reserveUploads } from "@/server/files";
import { respond, routeActor } from "@/app/api/files/_lib/session";

/**
 * Signed upload URLs for the document vault, for callers that aren't React forms (§2.3, §7.14, §12).
 * The same step as server/actions/documents.ts requestUploadSlots: each file's path is reserved in
 * document_uploads under the caller's RLS, then an upload URL is signed as the caller.
 *
 *   POST /api/files/uploads   body: RequestUploadSlotsInput (lib/schemas/documents.ts)
 *   → { ok: true, data: { slots: [{ key, uploadId, path, signedUrl, token, fileName, mimeType, expiresAt }] } }
 *
 * Then PUT each file to its signedUrl and POST /api/files/uploads/<uploadId> to confirm it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let userId: string | null = null;
  let role: string | null = null;
  try {
    const guard = await routeActor(request);
    if ("response" in guard) return guard.response;
    const { actor } = guard;
    userId = actor.user.id;
    role = actor.user.role;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond({ ok: false, error: "The request wasn't valid JSON.", code: "validation" }, 400);
    }
    const parsed = RequestUploadSlotsSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) (fieldErrors[issue.path.join(".") || "_form"] ??= []).push(issue.message);
      return respond({ ok: false, error: "Please check the files and their details.", code: "validation", fieldErrors }, 400);
    }
    const slots = await reserveUploads(actor, parsed.data);
    return respond({ ok: true, data: { slots } }, 200);
  } catch (err) {
    if (err instanceof ActionError) {
      const status = err.code === "forbidden" ? 403 : err.code === "rate_limited" ? 429 : err.code === "not_found" ? 404 : 400;
      return respond({ ok: false, error: err.message, code: err.code, fieldErrors: err.fieldErrors }, status);
    }
    const ref = logUnexpected(err, { source: "route:/api/files/uploads", userId, role });
    return respond({ ok: false, error: unexpectedMessage(ref), code: "unexpected", ref }, 500);
  }
}

import type { NextRequest } from "next/server";
import { isUuid } from "@/lib/domain/files";
import { logUnexpected, log } from "@/lib/log";
import { ActionError, unexpectedMessage } from "@/lib/result";
import { finishUpload, removeStoredObjects, uploadAfterJobs } from "@/server/files";
import { respond, routeActor } from "@/app/api/files/_lib/session";

/**
 * Confirm or abandon one upload (§7.14, §12): the route twin of server/actions/documents.ts
 * confirmUpload and discardUpload.
 *
 *   POST   /api/files/uploads/<uploadId>   the file is uploaded: check it over its whole length and
 *          create the document / version / request upload → { ok, data: FinishedUpload, warnings? }
 *   DELETE /api/files/uploads/<uploadId>   the upload failed or was cancelled: retire the slot and
 *          remove whatever arrived → { ok, data: { discarded } }
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string | null = null;
  let role: string | null = null;
  try {
    const guard = await routeActor(request);
    if ("response" in guard) return guard.response;
    const { actor } = guard;
    userId = actor.user.id;
    role = actor.user.role;
    const { id } = await params;
    if (!isUuid(id)) return respond({ ok: false, error: "That upload isn't valid.", code: "not_found" }, 404);

    const done = await finishUpload(actor, id);
    // After-effects never fail the save (§0.1 rule 5): failures become warnings.
    const warnings: string[] = [];
    for (const job of uploadAfterJobs(actor, done)) {
      try {
        await job.fn();
      } catch (err) {
        const ref = logUnexpected(err, { source: `route:/api/files/uploads:after:${job.label}`, userId, role });
        warnings.push(`${job.warning ?? `${job.label} didn't go through.`} (Ref ${ref})`);
      }
    }
    return respond(warnings.length ? { ok: true, data: done, warnings } : { ok: true, data: done }, 200);
  } catch (err) {
    if (err instanceof ActionError) {
      const status = err.code === "forbidden" ? 403 : err.code === "not_found" ? 404 : 400;
      return respond({ ok: false, error: err.message, code: err.code }, status);
    }
    const ref = logUnexpected(err, { source: "route:/api/files/uploads/[id]", userId, role });
    return respond({ ok: false, error: unexpectedMessage(ref), code: "unexpected", ref }, 500);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string | null = null;
  let role: string | null = null;
  try {
    const guard = await routeActor(request);
    if ("response" in guard) return guard.response;
    const { actor } = guard;
    userId = actor.user.id;
    role = actor.user.role;
    const { id } = await params;
    if (!isUuid(id)) return respond({ ok: false, error: "That upload isn't valid.", code: "not_found" }, 404);
    const { data, error } = await actor.supabase.rpc("discard_document_upload", { p_upload_id: id, p_reason: "The upload was cancelled." });
    if (error) {
      log("warn", "upload discard refused", { source: "route:/api/files/uploads/[id]", userId, role, err: error });
      return respond({ ok: false, error: "That upload can't be cancelled now.", code: "blocked" }, 400);
    }
    const path = typeof data === "string" ? data : null;
    if (path) await removeStoredObjects([path]);
    return respond({ ok: true, data: { discarded: Boolean(path) } }, 200);
  } catch (err) {
    const ref = logUnexpected(err, { source: "route:/api/files/uploads/[id]", userId, role });
    return respond({ ok: false, error: unexpectedMessage(ref), code: "unexpected", ref }, 500);
  }
}

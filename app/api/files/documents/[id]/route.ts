import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isManagerOrPartner } from "@/lib/auth/roles";
import { fileTypeOfExtension, extensionOf, isUuid, previewKind } from "@/lib/domain/files";
import { logUnexpected, log } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { createSignedDownload, DOWNLOAD_URL_SECONDS, FileStorageError } from "@/server/files";
import { logEmployeeActivity } from "@/server/activity";
import { respond, routeActor } from "@/app/api/files/_lib/session";

/**
 * A document's file: preview or download (§7.14 "Preview for PDF and images; download through a
 * signed URL (60 s). Every view and download is logged", §12).
 *
 *   GET /api/files/documents/<id>                      → 302 to a 60-second signed URL (download)
 *   GET /api/files/documents/<id>?mode=preview          → inline, for PDFs and JPG/PNG images
 *   GET /api/files/documents/<id>?version=2             → an earlier version (staff only)
 *   GET /api/files/documents/<id>?as=json               → { ok, data: { url, fileName, mimeType, preview, expiresInSeconds } }
 *
 * The document (and the version) are looked up under the caller's RLS first, so a portal user only
 * reaches what the portal shows them and an Employee only their clients' files; the URL is then
 * signed with the caller's own session, so Storage's policy applies as well. Recycle-bin documents
 * open for Partners and Managers only. Each request writes a document_activities row (viewed /
 * downloaded) and an audit row (file_download). Never cached.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string | null = null;
  let role: string | null = null;
  try {
    const guard = await routeActor(request);
    if ("response" in guard) return guard.response;
    const { actor } = guard;
    const { user, supabase } = actor;
    userId = user.id;
    role = user.role;

    const { id } = await params;
    if (!isUuid(id)) return respond({ ok: false, error: "That isn't a document link the app knows.", code: "not_found" }, 404);
    const sp = request.nextUrl.searchParams;
    const wantPreview = sp.get("mode") === "preview";
    const asJson = sp.get("as") === "json";
    const versionParam = sp.get("version");
    const version = versionParam && /^\d{1,6}$/.test(versionParam) ? Number(versionParam) : null;

    const { data: doc, error } = await supabase
      .from("documents")
      .select("id, client_id, title, file_name, mime_type, storage_path, version, deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!doc || (doc.deleted_at && !isManagerOrPartner(user.role))) {
      return respond({ ok: false, error: "This document isn't available to you, or it no longer exists.", code: "not_found" }, 404);
    }

    let path = doc.storage_path;
    let fileName = doc.file_name;
    let mimeType = doc.mime_type;
    let servedVersion = doc.version;
    if (version !== null && version !== doc.version) {
      if (user.role === "client") return respond({ ok: false, error: "Earlier versions are kept by the firm.", code: "forbidden" }, 403);
      const { data: v, error: vError } = await supabase
        .from("document_versions")
        .select("version, file_name, storage_path, mime_type")
        .eq("document_id", doc.id)
        .eq("version", version)
        .maybeSingle();
      if (vError) throw vError;
      if (!v) return respond({ ok: false, error: `Version ${version} of this document isn't available.`, code: "not_found" }, 404);
      path = v.storage_path;
      fileName = v.file_name;
      mimeType = v.mime_type ?? fileTypeOfExtension(extensionOf(v.file_name))?.mime ?? "application/octet-stream";
      servedVersion = v.version;
    }

    const preview = wantPreview && previewKind(mimeType) !== null;
    let url: string;
    try {
      url = await createSignedDownload({ path, downloadName: preview ? null : fileName, inline: preview }, supabase);
    } catch (err) {
      if (err instanceof FileStorageError) return respond({ ok: false, error: err.userMessage, code: "not_found" }, 404);
      throw err;
    }

    // Every view and download is logged (§7.14). A failed log line never blocks the file.
    const activity = preview ? "viewed" : "downloaded";
    const { error: actError } = await supabase
      .from("document_activities")
      .insert({ document_id: doc.id, user_id: user.id, activity, metadata: { version: servedVersion, mode: preview ? "preview" : "download" } });
    if (actError) log("warn", "document activity not written", { source: "route:/api/files/documents", userId, role, documentId: doc.id, err: actError });
    await actor.audit({
      event: "file_download",
      resourceType: "document",
      resourceId: doc.id,
      action: preview ? "documents.preview" : "documents.download",
      details: { client_id: doc.client_id, version: servedVersion, file_name: fileName },
    });
    if (!preview && user.employeeId) {
      await logEmployeeActivity({
        activityType: "document_downloaded",
        description: `Downloaded ${doc.title}${servedVersion !== doc.version ? ` (version ${servedVersion})` : ""}`,
        entityType: "document",
        entityId: doc.id,
        entityName: doc.title.slice(0, 200),
      });
    }

    if (asJson) {
      return respond({ ok: true, data: { url, fileName, mimeType, preview, version: servedVersion, expiresInSeconds: DOWNLOAD_URL_SECONDS } }, 200);
    }
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    const ref = logUnexpected(err, { source: "route:/api/files/documents", userId, role });
    return respond({ ok: false, error: unexpectedMessage(ref), code: "unexpected", ref }, 500);
  }
}

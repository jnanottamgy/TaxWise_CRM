import "server-only";

import type { z } from "zod";
import { getSession, type CurrentUser } from "@/lib/auth/current-user";
import type { ServerSupabase } from "@/lib/supabase/server";
import { throwIfDbError, type AuditEntry } from "@/lib/action";
import { ActionError } from "@/lib/result";
import { checkRateLimit } from "@/lib/rate-limit";
import type { DocumentCategory } from "@/lib/domain/enums";
import { todayIST } from "@/lib/domain/fy";
import { resolveRetentionParams } from "@/lib/domain/retention";
import type { FinishedUpload, IssuedSlot, RequestUploadSlotsSchema, UploadPurpose } from "@/lib/schemas/documents";
import { createAdminClient } from "@/server/admin";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";
import { log } from "@/lib/log";
import {
  ALLOWED_MIME,
  CLIENT_DOCUMENTS_BUCKET,
  MAX_BYTES,
  MAX_FILE_BYTES,
  checkFile,
  documentStoragePath,
  extensionOf,
  fileTypeOfMime,
  objectNameOf,
  sanitizeFileName,
  sha256Hex,
  sniffMime,
  uploadRetention,
  withExtension,
  type FileKind,
} from "@/lib/domain/files";

type RequestUploadSlotsOutput = z.output<typeof RequestUploadSlotsSchema>;

/**
 * File storage for the document vault (§2.3, §5.8, §7.14, §12). Private buckets only; every file
 * moves through a short-lived signed URL issued after an RLS check.
 *
 *   createSignedUpload({ clientId, fileName, mimeType, size })   → { path, token, signedUrl, … }
 *        A new object '<client_id>/<uuid>.<ext>' in client-documents. Signed with the CALLER'S session,
 *        so Storage's own policy (0041: the caller can see the client) applies too. Valid 2 hours.
 *        The vault's uploads go through server/actions/documents.ts requestUploadSlots, which first
 *        reserves the path in document_uploads under RLS; use this directly only for files that never
 *        become documents.
 *   createSignedDownload({ bucket, path, downloadName?, inline? }) → a 60-second URL (§12)
 *        Signed with the caller's session: Storage's select policy decides (staff: the client is
 *        theirs; portal: a document the portal shows them). Call it after your own RLS-checked
 *        lookup of the row the file belongs to (app/api/files does, and logs the view/download).
 *   inspectStoredFile(path, { declaredMime })  → reads the object back (service role, only after
 *        the caller's slot was found under RLS), checks size and magic bytes over the whole file,
 *        and computes the SHA-256 that is stored.
 *   removeStoredObjects(paths)                → service role; for files refused by the check.
 *   purgeAbandonedUploads()                   → for the cleanup job (cron agent): removes the objects of
 *        slots never confirmed, a day after they expired, and marks the slots refused.
 *   sniffMime(bytes), ALLOWED_MIME, MAX_BYTES → re-exported from lib/domain/files.ts.
 *
 * Nothing here throws a raw storage error at a user: callers turn failures into plain sentences.
 */

export { ALLOWED_MIME, MAX_BYTES, sniffMime, CLIENT_DOCUMENTS_BUCKET };

/** Signed download URLs live 60 seconds (§7.14, §12). */
export const DOWNLOAD_URL_SECONDS = 60;

export class FileStorageError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "FileStorageError";
  }
}

async function sessionClient(): Promise<ServerSupabase> {
  const s = await getSession();
  if (s.status !== "ok") throw new FileStorageError("no session", "Your session has ended. Please sign in again.");
  return s.supabase;
}

export interface SignedUpload {
  /** The object's name in the bucket ('<client_id>/<uuid>.<ext>'), also documents.storage_path. */
  path: string;
  bucket: typeof CLIENT_DOCUMENTS_BUCKET;
  /** Absolute URL for the browser's PUT. */
  signedUrl: string;
  token: string;
  /** The cleaned file name to store. */
  fileName: string;
  mimeType: string;
}

/** A new object path for a vault file of this MIME type. */
export function newDocumentPath(clientId: string, mimeType: string): { path: string; kind: FileKind } {
  const type = fileTypeOfMime(mimeType);
  if (!type) throw new FileStorageError(`mime ${mimeType} not allowed`, "This type of file can't be uploaded.");
  return { path: documentStoragePath(clientId, globalThis.crypto.randomUUID(), type.kind), kind: type.kind };
}

/** Signs an upload URL for an already-chosen path in client-documents, as the caller. */
export async function signUploadPath(path: string, supabase?: ServerSupabase): Promise<{ signedUrl: string; token: string }> {
  const client = supabase ?? (await sessionClient());
  const { data, error } = await client.storage.from(CLIENT_DOCUMENTS_BUCKET).createSignedUploadUrl(objectNameOf(path));
  if (error || !data) {
    log("error", "signed upload url refused", { source: "server:files", path, err: error });
    throw new FileStorageError(error?.message ?? "no signed upload url", "Couldn't prepare the upload. Try again in a moment.");
  }
  return { signedUrl: data.signedUrl, token: data.token };
}

/** The platform contract: a signed upload URL for a new file in the client's folder. */
export async function createSignedUpload(
  input: { clientId: string; fileName: string; mimeType: string; size: number },
  supabase?: ServerSupabase,
): Promise<SignedUpload> {
  if (!(ALLOWED_MIME as readonly string[]).includes(input.mimeType)) {
    throw new FileStorageError(`mime ${input.mimeType} not allowed`, "This type of file can't be uploaded.");
  }
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_FILE_BYTES) {
    throw new FileStorageError(`size ${input.size}`, "Files can be at most 25 MB.");
  }
  const { path } = newDocumentPath(input.clientId, input.mimeType);
  const signed = await signUploadPath(path, supabase);
  const fileName = sanitizeFileName(input.fileName);
  return { path, bucket: CLIENT_DOCUMENTS_BUCKET, signedUrl: signed.signedUrl, token: signed.token, fileName, mimeType: input.mimeType };
}

/**
 * A 60-second signed URL for a stored file, signed as the caller (Storage RLS applies).
 * `downloadName` makes the browser save it under that name; `inline` leaves it to display (preview).
 */
export async function createSignedDownload(
  input: { bucket?: string; path: string; downloadName?: string | null; inline?: boolean; expiresIn?: number },
  supabase?: ServerSupabase,
): Promise<string> {
  const client = supabase ?? (await sessionClient());
  const bucket = input.bucket ?? CLIENT_DOCUMENTS_BUCKET;
  const name = bucket === CLIENT_DOCUMENTS_BUCKET ? objectNameOf(input.path) : input.path;
  const options = input.inline ? undefined : { download: input.downloadName ? sanitizeFileName(input.downloadName) : true };
  const { data, error } = await client.storage.from(bucket).createSignedUrl(name, Math.min(input.expiresIn ?? DOWNLOAD_URL_SECONDS, DOWNLOAD_URL_SECONDS), options);
  if (error || !data?.signedUrl) {
    log("warn", "signed download url refused", { source: "server:files", bucket, path: name, err: error });
    throw new FileStorageError(error?.message ?? "no signed url", "This file isn't available. It may have been moved or removed.");
  }
  return data.signedUrl;
}

export type InspectedFile =
  | { ok: true; size: number; mimeType: string; sha256: string; contentType: string | null }
  | { ok: false; reason: string; missing?: boolean };

/**
 * Reads a just-uploaded object back and checks it over its whole length (§12): present, within
 * 25 MB, really the declared type by its magic bytes, stored with that content type. Uses the
 * service role: call it only after the caller's upload slot for this path was found under RLS.
 */
export async function inspectStoredFile(path: string, opts: { declaredMime: string; fileName: string }): Promise<InspectedFile> {
  const admin = createAdminClient();
  const name = objectNameOf(path);
  const { data, error } = await admin.storage.from(CLIENT_DOCUMENTS_BUCKET).download(name);
  if (error || !data) {
    return { ok: false, missing: true, reason: "The file didn't arrive. Check your connection and upload it again." };
  }
  if (data.size > MAX_FILE_BYTES) return { ok: false, reason: "Files can be at most 25 MB." };
  const bytes = new Uint8Array(await data.arrayBuffer());
  const check = checkFile({ name: opts.fileName, size: bytes.byteLength, bytes, complete: true });
  if (!check.ok) return { ok: false, reason: check.reason };
  if (check.mime !== opts.declaredMime) {
    return { ok: false, reason: "The file's contents don't match its type. Upload it again from the original." };
  }
  const contentType = data.type ? data.type.split(";")[0].trim().toLowerCase() : null;
  // The stored content type is what a preview is served with: it must be the checked type.
  if (contentType && contentType !== "application/octet-stream" && contentType !== check.mime && !(check.kind === "heic" && contentType === "image/heif")) {
    return { ok: false, reason: "The file was uploaded with the wrong type. Upload it again." };
  }
  return { ok: true, size: bytes.byteLength, mimeType: check.mime, sha256: await sha256Hex(bytes), contentType };
}

/** Removes objects from client-documents (service role). Never throws; failures are logged. */
export async function removeStoredObjects(paths: ReadonlyArray<string | null | undefined>): Promise<void> {
  const names = paths.filter((p): p is string => !!p).map(objectNameOf);
  if (names.length === 0) return;
  try {
    const { error } = await createAdminClient().storage.from(CLIENT_DOCUMENTS_BUCKET).remove(names);
    if (error) throw error;
  } catch (err) {
    log("warn", "stored objects not removed", { source: "server:files", count: names.length, err });
  }
}

/**
 * For the cleanup job: upload slots never confirmed, expired more than a day ago, get their objects
 * removed and are marked refused ("abandoned"). Documents themselves are never touched (§6.8:
 * documents are never deleted automatically). Returns counts for job_runs.
 */
export async function purgeAbandonedUploads(opts: { limit?: number } = {}): Promise<{ checked: number; removed: number }> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("document_uploads")
    .select("id, storage_path")
    .is("confirmed_at", null)
    .is("failed_at", null)
    .lt("expires_at", cutoff)
    .order("expires_at", { ascending: true })
    .limit(Math.min(opts.limit ?? 500, 1000));
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return { checked: 0, removed: 0 };
  await removeStoredObjects(rows.map((r) => r.storage_path));
  const { error: markError } = await admin
    .from("document_uploads")
    .update({ failed_at: new Date().toISOString(), failure: "Abandoned: the upload was never finished." })
    .in(
      "id",
      rows.map((r) => r.id),
    );
  if (markError) throw markError;
  return { checked: rows.length, removed: rows.length };
}

// =================================================================================================
// The vault's upload flow, shared by server/actions/documents.ts (requestUploadSlots, confirmUpload)
// and app/api/files/uploads (the same steps for callers that aren't React forms).
// =================================================================================================

export interface UploadActor {
  user: CurrentUser;
  supabase: ServerSupabase;
  audit(entry: AuditEntry): Promise<void>;
}

export type { IssuedSlot, FinishedUpload } from "@/lib/schemas/documents";

/** Portal uploads: 60 per hour per person (§13). */
const PORTAL_UPLOADS = { limit: 60, windowSeconds: 60 * 60 } as const;

function nameForType(fileName: string, mimeType: string): string {
  const clean = sanitizeFileName(fileName);
  const type = fileTypeOfMime(mimeType);
  if (!type) return clean;
  return type.extensions.includes(extensionOf(clean)) ? clean : withExtension(clean, type.ext);
}

/**
 * Step 1 on the server: reserve a path per file in document_uploads under the caller's RLS (only
 * someone who may add files for the client gets one), then sign an upload URL for each, as the
 * caller. Throws ActionError with a plain sentence for anything the person can fix.
 */
export async function reserveUploads(actor: UploadActor, input: RequestUploadSlotsOutput): Promise<IssuedSlot[]> {
  const { user, supabase } = actor;
  const portal = user.role === "client";
  if (portal && input.purpose === "new_version") throw new ActionError("Only the firm adds versions of a document.", { code: "forbidden" });
  if (portal && input.acceptItem) throw new ActionError("The firm accepts or rejects uploads.", { code: "forbidden" });

  if (portal) {
    for (let i = 0; i < input.files.length; i++) {
      const r = await checkRateLimit({
        scope: "portal_upload",
        identity: [user.id],
        ...PORTAL_UPLOADS,
        audit: { userId: user.id, email: user.email },
      });
      if (!r.allowed) throw new ActionError("You've uploaded a lot of files in the last hour. Please try again a little later.", { code: "rate_limited" });
    }
  }

  const rows = input.files.map((f) => {
    const { path } = newDocumentPath(input.clientId, f.mimeType);
    return {
      key: f.key,
      row: {
        client_id: input.clientId,
        storage_path: path,
        file_name: nameForType(f.fileName, f.mimeType),
        file_size: f.size,
        mime_type: f.mimeType,
        purpose: input.purpose,
        document_id: input.purpose === "new_version" ? input.documentId : null,
        request_item_id: input.purpose === "request_item" ? input.requestItemId : null,
        title: f.title,
        category: f.category,
        financial_year: f.financialYear,
        period: f.period,
        description: f.description,
        tags: portal ? [] : f.tags,
        is_confidential: portal ? false : f.isConfidential,
        expiry_date: f.expiryDate,
        renewal_date: f.renewalDate,
        source: portal ? "client_portal" : input.source,
        change_note: input.purpose === "new_version" ? f.changeNote : null,
        accept_item: portal ? false : input.purpose === "request_item" && input.acceptItem,
        claimed_sha256: f.sha256,
        created_by: user.id,
      },
    };
  });

  const { data, error } = await supabase
    .from("document_uploads")
    .insert(rows.map((r) => r.row))
    .select("id, storage_path, file_name, mime_type, expires_at");
  if (error?.code === "42501") {
    throw new ActionError(portal ? "You can't upload files for this client." : "You can't add files for this client. It isn't one of yours.", { code: "forbidden" });
  }
  throwIfDbError(error);
  const inserted = (data ?? []) as Array<{ id: string; storage_path: string; file_name: string; mime_type: string; expires_at: string }>;
  const byPath = new Map(inserted.map((r) => [r.storage_path, r] as const));

  const out: IssuedSlot[] = [];
  try {
    for (const r of rows) {
      const slot = byPath.get(r.row.storage_path);
      if (!slot) throw new FileStorageError("slot missing after insert", "Couldn't prepare the upload. Try again in a moment.");
      const signed = await signUploadPath(slot.storage_path, supabase);
      out.push({
        key: r.key,
        uploadId: slot.id,
        bucket: CLIENT_DOCUMENTS_BUCKET,
        path: slot.storage_path,
        signedUrl: signed.signedUrl,
        token: signed.token,
        fileName: slot.file_name,
        mimeType: slot.mime_type,
        expiresAt: slot.expires_at,
      });
    }
  } catch (err) {
    // Nothing was uploaded yet: retire the reserved slots so they never linger as pending.
    await Promise.all(inserted.map((s) => supabase.rpc("discard_document_upload", { p_upload_id: s.id, p_reason: "The upload couldn't be prepared." })));
    if (err instanceof FileStorageError) throw new ActionError(err.userMessage);
    throw err;
  }

  await actor.audit({
    event: "data_create",
    resourceType: "document_upload",
    resourceId: out.length === 1 ? out[0].uploadId : null,
    action: "documents.upload_slots",
    details: { client_id: input.clientId, purpose: input.purpose, files: out.length, upload_ids: out.map((s) => s.uploadId) },
  });
  return out;
}

interface SlotRow {
  id: string;
  client_id: string;
  storage_path: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  purpose: UploadPurpose;
  category: DocumentCategory;
  financial_year: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
  failure: string | null;
}

/** retention_until for a staff upload (§5.8, §6.8), from the law tables; null lets the database default apply. */
async function retentionFor(supabase: ServerSupabase, clientId: string, slot: SlotRow): Promise<string | null> {
  try {
    const [client, params] = await Promise.all([
      supabase.from("clients").select("entity_type").eq("id", clientId).maybeSingle(),
      supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").like("key", "retention.%"),
    ]);
    if (client.error) throw client.error;
    if (params.error) throw params.error;
    const today = todayIST();
    const rows = (params.data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
    const { params: resolved } = resolveRetentionParams(rows, today);
    return uploadRetention({ uploadedOn: today, category: slot.category, financialYear: slot.financial_year, entityType: client.data?.entity_type ?? null }, resolved).until;
  } catch (err) {
    log("warn", "retention date fell back to the default", { source: "server:files", clientId, err });
    return null;
  }
}

/**
 * Step 4 on the server: the browser says the file is uploaded. Finds the caller's slot under RLS,
 * reads the object back and checks it over its whole length (inspectStoredFile), then creates the
 * document / version / request upload in one transaction (confirm_document_upload). A refused file
 * is removed from storage and the slot marked refused; the reason comes back as an ActionError.
 */
export async function finishUpload(actor: UploadActor, uploadId: string): Promise<FinishedUpload> {
  const { user, supabase } = actor;
  const { data, error } = await supabase
    .from("document_uploads")
    .select("id, client_id, storage_path, file_name, file_size, mime_type, purpose, category, financial_year, confirmed_at, failed_at, failure")
    .eq("id", uploadId)
    .eq("created_by", user.id)
    .maybeSingle();
  throwIfDbError(error);
  const slot = data as SlotRow | null;
  if (!slot) throw new ActionError("This upload isn't one of yours, or it no longer exists. Upload the file again.", { code: "not_found" });
  if (slot.failed_at) throw new ActionError(`This upload was refused: ${slot.failure ?? "the file didn't pass the checks."}`);

  let size = slot.file_size;
  let mime = slot.mime_type;
  let sha: string | null = null;
  if (!slot.confirmed_at) {
    const inspected = await inspectStoredFile(slot.storage_path, { declaredMime: slot.mime_type, fileName: slot.file_name });
    if (!inspected.ok) {
      await supabase.rpc("discard_document_upload", { p_upload_id: slot.id, p_reason: inspected.reason });
      if (!inspected.missing) await removeStoredObjects([slot.storage_path]);
      throw new ActionError(inspected.reason, { code: "validation" });
    }
    size = inspected.size;
    mime = inspected.mimeType;
    sha = inspected.sha256;
  }

  const retention = user.role === "client" || slot.purpose === "new_version" ? null : await retentionFor(supabase, slot.client_id, slot);
  const { data: result, error: rpcError } = await supabase.rpc("confirm_document_upload", {
    p_upload_id: slot.id,
    p_file_size: size,
    p_mime_type: mime,
    p_sha256: sha ?? "0".repeat(64),
    p_retention_until: retention,
  });
  throwIfDbError(rpcError);
  const r = (result ?? {}) as Record<string, unknown>;
  const finished: FinishedUpload = {
    documentId: String(r.document_id),
    version: Number(r.version ?? 1),
    title: String(r.title ?? slot.file_name),
    purpose: slot.purpose,
    clientId: slot.client_id,
    requestId: (r.request_id as string | null) ?? null,
    requestItemId: (r.request_item_id as string | null) ?? null,
    itemStatus: (r.item_status as FinishedUpload["itemStatus"]) ?? null,
    fileName: slot.file_name,
    fileSize: size,
    already: Boolean(r.already),
  };

  if (!finished.already) {
    await actor.audit({
      event: "file_upload",
      resourceType: "document",
      resourceId: finished.documentId,
      action: slot.purpose === "new_version" ? "documents.new_version" : "documents.upload",
      details: {
        client_id: slot.client_id,
        purpose: slot.purpose,
        version: finished.version,
        file_name: slot.file_name,
        file_size: size,
        mime_type: mime,
        request_item_id: finished.requestItemId,
        source: user.role === "client" ? "client_portal" : undefined,
      },
    });
  }
  return finished;
}

export interface AfterJob {
  label: string;
  fn: () => Promise<unknown>;
  warning?: string;
}

/**
 * What follows a confirmed upload (§0.1 rule 5: never fails the save): the client's timeline, the
 * uploader's activity feed, and, for a portal upload, the owner and team (§9 "Client uploaded a
 * document → Owner + team").
 */
export function uploadAfterJobs(actor: UploadActor, done: FinishedUpload): AfterJob[] {
  if (done.already) return [];
  const { user } = actor;
  const portal = user.role === "client";
  const jobs: AfterJob[] = [];
  const versioned = done.purpose === "new_version";
  jobs.push({
    label: "Add the upload to the client's timeline",
    fn: () =>
      addTimelineEvent({
        clientId: done.clientId,
        eventType: versioned ? "document_version_added" : "document_uploaded",
        title: versioned ? `New version (v${done.version}) of ${done.title}` : portal ? `Client uploaded ${done.title}` : `Document uploaded: ${done.title}`,
        metadata: { document_id: done.documentId, version: done.version, request_item_id: done.requestItemId },
      }),
  });
  if (!portal) {
    jobs.push({
      label: "Add to your activity",
      fn: () =>
        logEmployeeActivity({
          activityType: "document_uploaded",
          description: versioned ? `Uploaded version ${done.version} of ${done.title}` : `Uploaded ${done.title}`,
          entityType: "document",
          entityId: done.documentId,
          entityName: done.title.slice(0, 200),
        }),
    });
  } else {
    jobs.push({
      label: "Tell the client's team",
      warning: "The upload is saved, but the client's team wasn't notified. Tell them it's there.",
      fn: async () => {
        // The portal user can't read the team; the recipients are looked up by the system, after the
        // RLS-checked confirm above, for this one client.
        const admin = createAdminClient();
        const [client, team] = await Promise.all([
          admin.from("clients").select("display_name, owner_employee_id").eq("id", done.clientId).maybeSingle(),
          admin.from("client_team_members").select("employee_id").eq("client_id", done.clientId),
        ]);
        if (client.error) throw client.error;
        if (team.error) throw team.error;
        const employeeIds = [client.data?.owner_employee_id, ...(team.data ?? []).map((t) => t.employee_id)].filter((e): e is string => !!e);
        if (employeeIds.length === 0) return;
        const where = done.requestId ? `?tab=documents&docs=requests&request=${done.requestId}` : `?tab=documents&doc=${done.documentId}`;
        await notify({
          to: { employeeIds },
          type: "document_uploaded",
          title: `${client.data?.display_name ?? "A client"} uploaded a document`,
          body: done.requestId ? `${done.title} was uploaded against a document request. Accept it, or reject it with a reason.` : `${done.title} was uploaded through the portal.`,
          linkUrl: `/clients/${done.clientId}${where}`,
          entity: { type: "document", id: done.documentId },
          clientId: done.clientId,
          dedupeKey: `document_uploaded:${done.documentId}`,
        });
      },
    });
  }
  return jobs;
}

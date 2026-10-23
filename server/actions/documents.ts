"use server";

/**
 * The document vault (§5.8, §6.8, §7.14, §7.19, §12): uploads, and managing a document.
 *
 * UPLOADING. Reused by the staff vault, the client portal (§7.22), task attachments and files saved
 * from WhatsApp (§7.25.6). The ready-made browser side is <DocumentUploader /> and the hook
 * useDocumentUpload (components/documents/uploader.tsx), which do all four steps with per-file
 * progress and reasons. Doing it by hand:
 *
 *   1. In the browser, read each file's first bytes and check it: checkFile({ name, size, bytes })
 *      from lib/domain/files.ts (type by magic bytes, 25 MB, the cleaned name), and hash it with
 *      sha256Hex(bytes). Optional: findDuplicates({ clientId, hashes }) → warn before uploading.
 *   2. requestUploadSlots({ clientId, purpose, documentId?, requestItemId?, acceptItem?, source?, files })
 *        files[i] = { key, fileName, size, mimeType, sha256, title, category, financialYear, period,
 *                     description, tags, isConfidential, expiryDate, renewalDate, changeNote }
 *        purpose  "new_document" (default) · "new_version" (documentId, one file, staff only) ·
 *                 "request_item" (requestItemId, one file; staff may pass acceptItem: true)
 *      → { slots: [{ key, uploadId, path, signedUrl, token, fileName, mimeType, expiresAt }] }
 *      Reserves each path in document_uploads under the caller's RLS, then signs an upload URL
 *      (as the caller, so Storage's policy applies too). A portal user's uploads are always
 *      source 'client_portal', never confidential, never tagged, at most 60 an hour (§13).
 *   3. PUT each file's bytes to its signedUrl with Content-Type = mimeType
 *      (components/documents/upload-transport.ts putFile does it with progress).
 *   4. confirmUpload({ uploadId })
 *      → { documentId, version, title, purpose, clientId, requestId, requestItemId, itemStatus, already }
 *      Reads the stored object back, checks size, magic bytes and content type over the whole file,
 *      hashes it, and creates the document (or the new version, or the request item's upload) in one
 *      transaction (confirm_document_upload, 0121). A refused file is removed and its reason returned.
 *      Safe to call twice. If the PUT failed or the person cancelled: discardUpload({ uploadId }).
 *
 *   Task attachments: upload with purpose "new_document", then insert task_attachments(document_id).
 *
 * MANAGING (staff who can see the client; RLS 0037):
 *   updateDocument    title, category, FY, period, description, tags, expiry and renewal dates;
 *                     Partners/Managers also confidentiality, sharing with the client and the
 *                     retention date (never earlier than the rules give, §6.8). Optimistic (§13).
 *   deleteDocument    Partner/Manager: to the recycle bin (§0.1 rule 11). Purging is the recycle
 *                     bin's, and the database blocks it before retention_until (0121).
 *   restoreDocument   Partner/Manager: back from the recycle bin.
 *
 * Downloads and previews: GET /api/files/documents/<id> (app/api/files), a 60-second signed URL
 * after an RLS-checked lookup; every view and download is logged. Never a public URL.
 */

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { isManagerOrPartner } from "@/lib/auth/roles";
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/domain/enums";
import { istDateOf } from "@/lib/domain/fy";
import { resolveRetentionParams } from "@/lib/domain/retention";
import { uploadRetention } from "@/lib/domain/files";
import { formatDate, formatTime } from "@/lib/format";
import {
  ConfirmUploadSchema,
  DeleteDocumentSchema,
  DiscardUploadSchema,
  FindDuplicatesSchema,
  RequestUploadSlotsSchema,
  RestoreDocumentSchema,
  UpdateDocumentSchema,
  type DuplicateMatch,
  type FinishedUpload,
  type IssuedSlot,
} from "@/lib/schemas/documents";
import { finishUpload, removeStoredObjects, reserveUploads, uploadAfterJobs } from "@/server/files";
import { addTimelineEvent } from "@/server/timeline";

const MANAGERS = ["partner", "manager"] as const;

// -------------------------------------------------------------------------------------------------
// Uploads
// -------------------------------------------------------------------------------------------------

export const requestUploadSlots = defineAction(
  { name: "documents.upload_slots", schema: RequestUploadSlotsSchema },
  async (input, ctx): Promise<ActionResult<{ slots: IssuedSlot[] }>> => {
    const slots = await reserveUploads(ctx, input);
    return ok({ slots });
  },
);

export const confirmUpload = defineAction(
  { name: "documents.confirm_upload", schema: ConfirmUploadSchema },
  async (input, ctx): Promise<ActionResult<FinishedUpload>> => {
    const done = await finishUpload(ctx, input.uploadId);
    for (const job of uploadAfterJobs(ctx, done)) ctx.after(job.label, job.fn, job.warning);
    return ok(done);
  },
);

export const discardUpload = defineAction(
  { name: "documents.discard_upload", schema: DiscardUploadSchema },
  async (input, ctx): Promise<ActionResult<{ discarded: boolean }>> => {
    const { data, error } = await ctx.supabase.rpc("discard_document_upload", { p_upload_id: input.uploadId, p_reason: input.reason });
    throwIfDbError(error);
    const path = typeof data === "string" ? data : null;
    if (path) await removeStoredObjects([path]);
    return ok({ discarded: Boolean(path) });
  },
);

/** The duplicate warning (§7.14): the client's documents (and older versions) with these hashes. */
export const findDuplicates = defineAction(
  { name: "documents.find_duplicates", schema: FindDuplicatesSchema },
  async (input, ctx): Promise<ActionResult<DuplicateMatch[]>> => {
    const { data, error } = await ctx.supabase.rpc("find_document_duplicates", { p_client_id: input.clientId, p_hashes: input.hashes });
    throwIfDbError(error);
    const seesBin = isManagerOrPartner(ctx.user.role);
    const rows: DuplicateMatch[] = (data ?? [])
      // The recycle bin is Partners' and Managers' (§7.19): nobody else learns what is in it.
      .filter((r) => r.document_id && r.sha256 && (seesBin || !r.in_recycle_bin))
      .map((r) => ({
        sha256: String(r.sha256),
        documentId: String(r.document_id),
        title: r.title ?? "",
        fileName: r.file_name ?? "",
        version: r.version ?? 1,
        isCurrent: Boolean(r.is_current),
        category: r.category ?? "other",
        financialYear: r.financial_year,
        uploadedAt: r.uploaded_at ?? "",
        inRecycleBin: Boolean(r.in_recycle_bin),
      }));
    return ok(rows);
  },
);

// -------------------------------------------------------------------------------------------------
// Managing a document
// -------------------------------------------------------------------------------------------------

const STAFF = ["partner", "manager", "employee"] as const;

interface DocRow {
  id: string;
  client_id: string;
  title: string;
  category: keyof typeof DOCUMENT_CATEGORY_LABELS;
  financial_year: string | null;
  period: string | null;
  description: string | null;
  expiry_date: string | null;
  renewal_date: string | null;
  is_confidential: boolean;
  shareable_with_client: boolean;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const DOC_COLUMNS =
  "id, client_id, title, category, financial_year, period, description, expiry_date, renewal_date, is_confidential, shareable_with_client, retention_until, created_at, updated_at, deleted_at";

async function loadDocument(ctx: ActionContext, id: string, clientId: string): Promise<DocRow> {
  const { data, error } = await ctx.supabase.from("documents").select(DOC_COLUMNS).eq("id", id).maybeSingle();
  throwIfDbError(error);
  const doc = data as DocRow | null;
  if (!doc || doc.client_id !== clientId) throw new ActionError("That document no longer exists. Reload to see the vault.", { code: "not_found" });
  return doc;
}

function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

/** "Changed by Anita at 12:41. Reload to see their changes." (§13), naming the last person who touched it. */
async function conflictMessage(ctx: ActionContext, doc: { id: string; updated_at: string }): Promise<string> {
  let name: string | null = null;
  try {
    const { data } = await ctx.supabase.from("document_activities").select("user_id").eq("document_id", doc.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.user_id) {
      const { data: who } = await ctx.supabase.from("employee_directory").select("full_name").eq("profile_id", data.user_id).maybeSingle();
      name = who?.full_name ?? null;
    }
  } catch {
    name = null;
  }
  const at = doc.updated_at;
  const when = formatDate(at) === formatDate(new Date()) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`;
  return `Changed by ${name ?? "someone else"} at ${when}. Reload to see their changes.`;
}

/** The earliest retention date the rules allow for this document (§6.8). */
async function minimumRetention(ctx: ActionContext, doc: DocRow, category: DocRow["category"], fy: string | null): Promise<string> {
  const [client, params] = await Promise.all([
    ctx.supabase.from("clients").select("entity_type").eq("id", doc.client_id).maybeSingle(),
    ctx.supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").like("key", "retention.%"),
  ]);
  throwIfDbError(client.error);
  throwIfDbError(params.error);
  const uploadedOn = istDateOf(doc.created_at);
  const rows = (params.data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
  return uploadRetention({ uploadedOn, category, financialYear: fy, entityType: client.data?.entity_type ?? null }, resolveRetentionParams(rows, uploadedOn).params).until;
}

export const updateDocument = defineAction(
  { name: "documents.update", schema: UpdateDocumentSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const doc = await loadDocument(ctx, input.id, input.clientId);
    if (doc.deleted_at) return fail("This document is in the recycle bin. Restore it before editing.", { code: "blocked" });
    if (!sameInstant(doc.updated_at, input.updatedAt)) return fail(await conflictMessage(ctx, doc), { code: "conflict" });

    const manager = isManagerOrPartner(ctx.user.role);
    const decisions: string[] = [];
    if (input.isConfidential !== doc.is_confidential) decisions.push("confidentiality");
    if (input.shareableWithClient !== doc.shareable_with_client) decisions.push("sharing with the client");
    if ((input.retentionUntil ?? null) !== (doc.retention_until ?? null)) decisions.push("the retention date");
    if (decisions.length && !manager) {
      return fail(`Only a Manager or a Partner can change ${decisions.join(", ")}.`, { code: "forbidden" });
    }

    // Retention is a Partner/Manager column (0037): never earlier than the rules give (§6.8).
    let retentionUntil = doc.retention_until;
    if (manager) {
      const minimum = await minimumRetention(ctx, doc, input.category, input.financialYear);
      if (!input.retentionUntil) {
        const m = "Every document needs a retention date.";
        return fail(m, { code: "validation", fieldErrors: { retentionUntil: ["Choose the date it must be kept until."] } });
      }
      const changedByHand = input.retentionUntil !== (doc.retention_until ?? null);
      if (input.retentionUntil < minimum && changedByHand) {
        const m = `The retention rules keep this document until ${formatDate(minimum)}, so it can't be set earlier.`;
        return fail(m, { code: "validation", fieldErrors: { retentionUntil: [m] } });
      }
      // Re-filed under a longer rule (a new category or FY): the date moves out by itself.
      retentionUntil = input.retentionUntil < minimum ? minimum : input.retentionUntil;
    }

    const patch = {
      title: input.title,
      category: input.category,
      financial_year: input.financialYear,
      period: input.period,
      description: input.description,
      expiry_date: input.expiryDate,
      renewal_date: input.renewalDate,
      ...(manager ? { is_confidential: input.isConfidential, shareable_with_client: input.shareableWithClient, retention_until: retentionUntil } : {}),
    };

    const { data, error } = await ctx.supabase.from("documents").update(patch).eq("id", doc.id).eq("updated_at", doc.updated_at).select("id, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!saved) return fail(await conflictMessage(ctx, doc), { code: "conflict" });

    // Tags: add the new ones, remove the dropped ones.
    const { data: current, error: tagError } = await ctx.supabase.from("document_tags").select("id, tag").eq("document_id", doc.id);
    throwIfDbError(tagError);
    const have = new Map((current ?? []).map((t) => [String(t.tag).toLowerCase(), t] as const));
    const want = new Map(input.tags.map((t) => [t.toLowerCase(), t] as const));
    const added = [...want.entries()].filter(([k]) => !have.has(k)).map(([, t]) => t);
    const removed = [...have.entries()].filter(([k]) => !want.has(k)).map(([, t]) => t);
    if (added.length) {
      const { error: insError } = await ctx.supabase.from("document_tags").insert(added.map((tag) => ({ document_id: doc.id, tag })));
      throwIfDbError(insError);
    }
    if (removed.length) {
      const { error: delError } = await ctx.supabase.from("document_tags").delete().in("id", removed.map((t) => t.id));
      throwIfDbError(delError);
    }

    const changed: string[] = [];
    if (doc.title !== input.title) changed.push("title");
    if (doc.category !== input.category) changed.push("category");
    if ((doc.financial_year ?? null) !== input.financialYear) changed.push("financial year");
    if ((doc.period ?? null) !== input.period) changed.push("period");
    if ((doc.description ?? null) !== input.description) changed.push("description");
    if ((doc.expiry_date ?? null) !== input.expiryDate) changed.push("expiry date");
    if ((doc.renewal_date ?? null) !== input.renewalDate) changed.push("renewal date");
    if (added.length || removed.length) changed.push("tags");
    changed.push(...decisions);

    await ctx.audit({
      event: "data_update",
      resourceType: "document",
      resourceId: doc.id,
      details: { client_id: doc.client_id, changed, tags_added: added, tags_removed: removed.map((t) => String(t.tag)) },
    });

    const activities: Array<{ activity: "renamed" | "tag_added" | "tag_removed"; metadata: Record<string, unknown> }> = [];
    if (doc.title !== input.title) activities.push({ activity: "renamed", metadata: { from: doc.title, to: input.title } });
    for (const t of added) activities.push({ activity: "tag_added", metadata: { tag: t } });
    for (const t of removed) activities.push({ activity: "tag_removed", metadata: { tag: String(t.tag) } });
    if (activities.length) {
      ctx.after("Record the change in the document's history", async () => {
        const { error: actError } = await ctx.supabase
          .from("document_activities")
          .insert(activities.map((a) => ({ document_id: doc.id, user_id: ctx.user.id, activity: a.activity, metadata: a.metadata as never })));
        if (actError) throw actError;
      });
    }
    if (manager && input.shareableWithClient !== doc.shareable_with_client) {
      ctx.after("Add the sharing change to the client's timeline", () =>
        addTimelineEvent({
          clientId: doc.client_id,
          eventType: input.shareableWithClient ? "document_shared" : "document_unshared",
          title: input.shareableWithClient ? `Shared with the client in the portal: ${input.title}` : `No longer shared with the client: ${input.title}`,
          metadata: { document_id: doc.id },
        }),
      );
    }
    return ok({ id: saved.id, updatedAt: saved.updated_at });
  },
);

export const deleteDocument = defineAction(
  { name: "documents.delete", schema: DeleteDocumentSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const doc = await loadDocument(ctx, input.id, input.clientId);
    if (doc.deleted_at) return ok({ id: doc.id });
    if (!sameInstant(doc.updated_at, input.updatedAt)) return fail(await conflictMessage(ctx, doc), { code: "conflict" });
    const { data, error } = await ctx.supabase
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.user.id })
      .eq("id", doc.id)
      .eq("updated_at", doc.updated_at)
      .select("id");
    throwIfDbError(error);
    if (!(data ?? []).length) return fail(await conflictMessage(ctx, doc), { code: "conflict" });

    await ctx.audit({ event: "data_delete", resourceType: "document", resourceId: doc.id, details: { client_id: doc.client_id, title: doc.title, soft: true } });
    ctx.after("Record the deletion in the document's history", async () => {
      const { error: actError } = await ctx.supabase.from("document_activities").insert({ document_id: doc.id, user_id: ctx.user.id, activity: "deleted", metadata: { soft: true } });
      if (actError) throw actError;
    });
    ctx.after("Add the deletion to the client's timeline", () =>
      addTimelineEvent({ clientId: doc.client_id, eventType: "document_deleted", title: `Document moved to the recycle bin: ${doc.title}`, metadata: { document_id: doc.id } }),
    );
    return ok({ id: doc.id });
  },
);

export const restoreDocument = defineAction(
  { name: "documents.restore", schema: RestoreDocumentSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const doc = await loadDocument(ctx, input.id, input.clientId);
    if (!doc.deleted_at) return ok({ id: doc.id });
    const { data: client, error: clientError } = await ctx.supabase.from("clients").select("deleted_at").eq("id", doc.client_id).maybeSingle();
    throwIfDbError(clientError);
    if (client?.deleted_at) return fail("The client is in the recycle bin. Restore the client first; its documents come back with it.", { code: "blocked" });
    const { error } = await ctx.supabase.from("documents").update({ deleted_at: null, deleted_by: null }).eq("id", doc.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_update", resourceType: "document", resourceId: doc.id, action: "documents.restore", details: { client_id: doc.client_id, title: doc.title } });
    ctx.after("Add the restore to the client's timeline", () =>
      addTimelineEvent({ clientId: doc.client_id, eventType: "document_restored", title: `Document restored from the recycle bin: ${doc.title}`, metadata: { document_id: doc.id } }),
    );
    return ok({ id: doc.id });
  },
);

import "server-only";

import { createElement } from "react";
import { after } from "next/server";
import type { Json } from "@/lib/database.types";
import { log, logUnexpected } from "@/lib/log";
import { todayIST } from "@/lib/domain/fy";
import { checkRateLimit } from "@/lib/rate-limit";
import { isQuotationToken, publicState, RespondSchema, type PublicState, type QuotationDocument, type RespondInput, type RespondResult } from "@/lib/schemas/quotations";
import { toQuotationDocument, type QuotationItemRow } from "@/lib/data/quotations";
import { createAdminClient, type AdminSupabase } from "@/server/admin";
import { logActivity, sessionActor } from "@/server/activity";
import { getFirmProfile, type FirmProfile } from "@/server/firm";
import { notify, type NotifyInput } from "@/server/notify";
import { loadFirmLogo, pdfFileName, pdfResponseHeaders, renderPdf } from "@/server/pdf";
import { QuotationPdf } from "@/server/pdf/quotation";

/**
 * The public quotation page's ONLY way to the data (§7.23, §4.6 "the public /q/[token] page and
 * PDFs read through a server function that exposes only the public subset"). Everything here uses
 * the service role (server/admin.ts) for narrow, token-scoped reads and the two security-definer
 * functions of 0145 for writes:
 *
 *   loadPublicQuotation(token)   the document, the firm's public profile and what the link shows
 *   recordPublicView(token, ip)  counts the view (record_quotation_view); tells the author and the
 *                                Partners on the first one
 *   respondPublic(token, input, ip)  Accept (typed full name, optional note) or Decline (reason),
 *                                rate-limited to 10 an hour per token + IP (§13); then tells the
 *                                author, the lead's owner and the Partners in-app (the link itself
 *                                shows the client their answer; nothing is emailed)
 *   publicQuotationPdf(token)    the same PDF staff download
 *
 * Tokens are 32 random bytes; anything not shaped like one is "not found" without a database
 * call. Drafts, quotations waiting for approval and deleted ones are never shown. A signed-in staff
 * member previewing the link isn't counted as a view and can't respond (the acceptance is the
 * client's own). Never throws: failures are logged and the page says what it can.
 */

/** §13: public quotation responses, 10 per hour per token + IP. */
const RESPONSE_LIMIT = { limit: 10, windowSeconds: 60 * 60 } as const;
/** Views counted per token + IP per hour (refreshing the page doesn't inflate the count beyond this). */
const VIEW_LIMIT = { limit: 60, windowSeconds: 60 * 60 } as const;
/** PDF downloads per token + IP per hour. */
const PDF_LIMIT = { limit: 30, windowSeconds: 60 * 60 } as const;

const COLUMNS =
  "id, quotation_number, status, issue_date, valid_until, revision_number, revised_from_id, client_name, client_company, client_email, client_phone, client_gstin, place_of_supply_code, notes, terms, accepted_by_name, responded_at, deleted_at, created_by, lead_id, client_id, total";

type Row = {
  id: string;
  quotation_number: string;
  status: QuotationDocument["status"];
  issue_date: string;
  valid_until: string;
  revision_number: number;
  revised_from_id: string | null;
  client_name: string;
  client_company: string | null;
  client_email: string | null;
  client_phone: string | null;
  client_gstin: string | null;
  place_of_supply_code: string | null;
  notes: string | null;
  terms: string | null;
  accepted_by_name: string | null;
  responded_at: string | null;
  deleted_at: string | null;
  created_by: string;
  lead_id: string | null;
  client_id: string | null;
  total: number;
};

export type PublicQuotation = {
  doc: QuotationDocument;
  firm: FirmProfile;
  state: PublicState;
  /** Someone signed in to the firm's app is looking: the page is a preview. */
  staffPreview: boolean;
};

const SHOWN_STATUSES = new Set(["sent", "viewed", "accepted", "rejected", "expired", "superseded"]);

async function readRow(admin: AdminSupabase, token: string): Promise<Row | null> {
  const { data, error } = await admin.from("quotations").select(COLUMNS).eq("token", token).maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

async function staffSession(): Promise<boolean> {
  const actor = await sessionActor();
  return Boolean(actor && actor.role !== "client");
}

/** The quotation behind a link, or null when the link isn't one we can show. Throws on a database error (the page shows its Ref). */
export async function loadPublicQuotation(token: string): Promise<PublicQuotation | null> {
  if (!isQuotationToken(token)) return null;
  const admin = createAdminClient();
  const row = await readRow(admin, token);
  if (!row || row.deleted_at || !SHOWN_STATUSES.has(row.status)) return null;

  const [items, author, revises, firm] = await Promise.all([
    admin.from("quotation_items").select("description, service_type, frequency, quantity, unit_price, tax_rate, sort_order").eq("quotation_id", row.id).order("sort_order"),
    admin.from("profiles").select("full_name").eq("id", row.created_by).maybeSingle(),
    row.revised_from_id ? admin.from("quotations").select("quotation_number").eq("id", row.revised_from_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    getFirmProfile(admin),
  ]);
  if (items.error) throw items.error;
  if (author.error) throw author.error;
  if (revises.error) throw revises.error;

  const doc = toQuotationDocument(row, (items.data ?? []) as unknown as QuotationItemRow[], {
    preparedBy: author.data?.full_name ?? null,
    revisesNumber: revises.data?.quotation_number ?? null,
    firmStateCode: firm.stateCode,
  });
  return {
    doc,
    firm,
    state: publicState({ status: row.status, valid_until: row.valid_until, responded_at: row.responded_at, accepted_by_name: row.accepted_by_name, deleted_at: row.deleted_at }, todayIST()),
    staffPreview: await staffSession(),
  };
}

/** Notifies through notify() when no one is signed in (the usual client), else straight through the system's function. */
async function notifyFromPublic(input: NotifyInput): Promise<void> {
  const actor = await sessionActor();
  if (!actor) {
    await notify(input);
    return;
  }
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("insert_notifications", {
      p_type: input.type,
      p_title: input.title,
      p_body: input.body,
      p_link_url: input.linkUrl,
      p_user_ids: input.to.userIds?.length ? [...input.to.userIds] : null,
      p_roles: input.to.roles?.length ? [...input.to.roles] : null,
      p_employee_ids: input.to.employeeIds?.length ? [...input.to.employeeIds] : null,
      p_entity_type: input.entity?.type ?? null,
      p_entity_id: input.entity?.id ?? null,
      p_client_id: input.clientId ?? null,
      p_dedupe_key: input.dedupeKey ?? null,
      p_exclude_user_id: null,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "public quotation notification failed", { source: "quotations-public:notify", type: input.type, err });
  }
}

function later(label: string, fn: () => Promise<unknown>): void {
  const job = async () => {
    try {
      await fn();
    } catch (err) {
      log("error", "public quotation follow-on failed", { source: `quotations-public:${label}`, err });
    }
  };
  try {
    after(job);
  } catch {
    void job();
  }
}

/** Counts a view (§7.23 "records the first and every later view"). Never throws. */
export async function recordPublicView(token: string, ip: string | null): Promise<void> {
  if (!isQuotationToken(token)) return;
  try {
    if (await staffSession()) return; // a preview by the firm is not the client's view
    const rl = await checkRateLimit({ scope: "quotation_view", identity: [token, ip], ...VIEW_LIMIT, audit: { ip } });
    if (!rl.allowed) return;
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("record_quotation_view", { p_token: token });
    if (error) throw error;
    const r = (data ?? {}) as { found?: boolean; counted?: boolean; first_view?: boolean; quotation_id?: string };
    if (!r.found || !r.counted || !r.first_view || !r.quotation_id) return;
    const id = r.quotation_id;
    later("first-view", async () => {
      const row = await readRow(admin, token);
      if (!row) return;
      await logActivity({ entityType: "quotation", entityId: id, action: "quotation_viewed", description: "Opened by the client for the first time" });
      await notifyFromPublic({
        to: { userIds: [row.created_by], roles: ["partner"] },
        type: "quotation_viewed",
        title: `Quotation ${row.quotation_number} opened`,
        body: `${row.client_company || row.client_name} opened the quotation for the first time.`,
        linkUrl: `/quotations/${id}`,
        entity: { type: "quotation", id },
        clientId: row.client_id,
        dedupeKey: `quotation_viewed:${id}`,
      });
    });
  } catch (err) {
    log("error", "public quotation view not recorded", { source: "quotations-public:view", err });
  }
}

export type { RespondResult };

const OUTCOME_MESSAGES: Record<string, string> = {
  already_accepted: "This quotation has already been accepted.",
  already_declined: "This quotation has already been declined.",
  expired: "This quotation has expired. Contact TaxWise for an updated one.",
  superseded: "This quotation has been replaced by a newer version, so it can no longer be accepted or declined.",
  not_open: "This quotation isn't open for a response.",
  not_found: "This link isn't valid any more.",
};

/** The client's Accept or Decline (§7.23). Never throws. */
export async function respondPublic(token: string, input: RespondInput, ip: string | null, userAgent: string | null): Promise<RespondResult> {
  try {
    if (!isQuotationToken(token)) return { ok: false, error: OUTCOME_MESSAGES.not_found, outcome: "not_found" };
    if (await staffSession()) {
      return { ok: false, error: "You're signed in to TaxWise as staff. Only the client can accept or decline a quotation here." };
    }
    const parsed = RespondSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      return { ok: false, error: issue?.message ?? "Please check what you entered.", field: field === "name" || field === "note" || field === "reason" ? field : undefined };
    }
    const rl = await checkRateLimit({ scope: "quotation_response", identity: [token, ip], ...RESPONSE_LIMIT, audit: { ip, userAgent } });
    if (!rl.allowed) return { ok: false, error: "Too many attempts from this connection. Please try again in an hour, or contact TaxWise." };

    const v = parsed.data;
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("respond_to_quotation", {
      p_token: token,
      p_response: v.response,
      p_name: v.response === "accept" ? v.name : null,
      p_note: v.response === "accept" ? v.note || null : null,
      p_reason: v.response === "decline" ? v.reason : null,
      p_ip: ip,
    });
    if (error) throw error;
    const r = (data ?? {}) as { outcome?: string; error?: string; field?: string; quotation_id?: string; responded_at?: string; accepted_by_name?: string; lead_id?: string | null; client_id?: string | null; created_by?: string };
    if (r.outcome !== "accepted" && r.outcome !== "declined") {
      const field = r.field === "name" || r.field === "note" || r.field === "reason" ? r.field : undefined;
      return { ok: false, error: r.error ?? OUTCOME_MESSAGES[r.outcome ?? "not_found"] ?? "This quotation can't take a response.", field, outcome: r.outcome };
    }
    const outcome = r.outcome;
    const id = r.quotation_id as string;
    // §12: the client's response is audited (as the system: there is no signed-in user).
    const { error: auditError } = await admin.from("audit_logs").insert({
      event: "data_update",
      resource_type: "quotation",
      resource_id: id,
      action: outcome === "accepted" ? "quotations.public_accept" : "quotations.public_decline",
      details: { outcome, accepted_by_name: r.accepted_by_name ?? null, lead_id: r.lead_id ?? null, client_id: r.client_id ?? null } as Json,
      success: true,
      ip,
      user_agent: userAgent?.slice(0, 500) ?? null,
    });
    if (auditError) log("error", "public quotation response not audited", { source: "quotations-public:audit", err: auditError });
    later("after-response", () => afterResponse(admin, token, id, outcome, v));
    return { ok: true, outcome, respondedAt: r.responded_at ?? null, acceptedByName: r.accepted_by_name ?? null };
  } catch (err) {
    const ref = logUnexpected(err, { source: "quotations-public:respond" });
    return { ok: false, error: `We couldn't record your response just now. Please try again in a few minutes, or call TaxWise and quote Ref ${ref}.` };
  }
}

/** The history and the in-app notices after a response. */
async function afterResponse(admin: AdminSupabase, token: string, id: string, outcome: "accepted" | "declined", v: ReturnType<typeof RespondSchema.parse>): Promise<void> {
  const row = await readRow(admin, token);
  if (!row) return;
  const who = row.client_company || row.client_name;
  const accepted = outcome === "accepted";
  await logActivity({
    entityType: "quotation",
    entityId: id,
    action: accepted ? "quotation_accepted" : "quotation_rejected",
    description: accepted
      ? `Accepted electronically by ${row.accepted_by_name ?? row.client_name} on the client's link${v.response === "accept" && v.note ? `: "${v.note}"` : ""}`
      : `Declined on the client's link${v.response === "decline" ? `: "${v.reason}"` : ""}`,
  });
  const { data: lead } = row.lead_id ? await admin.from("leads").select("assigned_to").eq("id", row.lead_id).maybeSingle() : { data: null };

  await notifyFromPublic({
    to: { userIds: [row.created_by], roles: ["partner"], employeeIds: lead?.assigned_to ? [lead.assigned_to] : [] },
    type: "quotation_responded",
    title: accepted ? `Quotation ${row.quotation_number} accepted` : `Quotation ${row.quotation_number} declined`,
    body: accepted
      ? `${who} accepted it${row.accepted_by_name ? ` (typed name: ${row.accepted_by_name})` : ""}.${row.client_id ? "" : " Create the client to start onboarding."}`
      : `${who} declined it${v.response === "decline" ? `: ${v.reason}` : ""}.`,
    linkUrl: `/quotations/${id}`,
    entity: { type: "quotation", id },
    clientId: row.client_id,
    dedupeKey: `quotation_responded:${id}`,
  });
}

/** The PDF behind the link's "Download PDF", or null when the link can't show one. Throws on a rendering or database error. */
export async function publicQuotationPdf(token: string, ip: string | null): Promise<{ bytes: Buffer; fileName: string } | "rate_limited" | null> {
  if (!isQuotationToken(token)) return null;
  const rl = await checkRateLimit({ scope: "quotation_pdf", identity: [token, ip], ...PDF_LIMIT, audit: { ip } });
  if (!rl.allowed) return "rate_limited";
  const data = await loadPublicQuotation(token);
  if (!data) return null;
  const logo = await loadFirmLogo(data.firm).catch(() => null);
  const bytes = await renderPdf(createElement(QuotationPdf, { firm: data.firm, logo, doc: data.doc }) as never);
  return { bytes, fileName: pdfFileName(data.doc.number, "Quotation") };
}

/** The client's IP from the forwarding headers (first hop). */
export function clientIp(h: Headers): string | null {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/**
 * GET handler body for the public PDF (app/api/q/[token]/pdf and app/q/[token]/pdf): the JSON error
 * contract with a Ref, never cached, never indexed (CONVENTIONS §3.5, §12).
 */
export async function publicPdfResponse(request: Request, token: string): Promise<Response> {
  const json = (body: Record<string, unknown>, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
  try {
    const result = await publicQuotationPdf(token, clientIp(request.headers));
    if (result === "rate_limited") return json({ ok: false, error: "Too many downloads from this connection. Please try again in an hour.", code: "rate_limited" }, 429);
    if (!result) return json({ ok: false, error: "This link isn't valid any more.", code: "not_found" }, 404);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(result.bytes), { status: 200, headers: { ...pdfResponseHeaders(result.fileName, { download }), "X-Robots-Tag": "noindex, nofollow" } });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:q:pdf" });
    return json({ ok: false, error: `The PDF couldn't be prepared. Please try again, and quote Ref ${ref} if it keeps happening.`, ref }, 500);
  }
}

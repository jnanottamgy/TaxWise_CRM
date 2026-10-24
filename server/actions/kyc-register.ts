"use server";

import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { addMonths, todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { toCsv } from "@/lib/schemas/clients";
import { KYC_FILTERS, KYC_SORTABLE, KYC_STATE_INFO, ReconfirmKycSchema, type KycState } from "@/lib/schemas/quality";
import { listKycRegister } from "@/lib/data/quality";
import { getAuditParams } from "@/lib/data/audits";
import { parseTableParams } from "@/components/app/data-table/params";
import { addTimelineEvent } from "@/server/timeline";

/**
 * The KYC register (§6.8 ICAI KYC Norms; §7.15.4 "KYC status by client"): re-confirm a complete
 * KYC for the year from the register, and export it as CSV. Partners and Managers (RLS 0033). The
 * KYC itself is edited on Client 360 → Profile & contacts.
 */

const MANAGERS = ["partner", "manager"] as const;
const EXPORT_MAX = 5000;

export const reconfirmKyc = defineAction(
  { name: "kyc_register.reconfirm", schema: ReconfirmKycSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ nextReviewOn: string }>> => {
    const { data: status, error: statusError } = await ctx.supabase.rpc("kyc_status", { p_client_id: input.clientId });
    throwIfDbError(statusError);
    const s = (status ?? {}) as { missing?: string[]; complete?: boolean };
    if (!s.complete) return fail(`The KYC isn't complete yet: ${(s.missing ?? []).join(", ")}. Complete it on the client's Profile tab first.`, { code: "blocked" });
    const today = todayIST();
    const { ceiling } = await getAuditParams(ctx.supabase, today);
    const next = addMonths(today, ceiling.kycReconfirmMonths);
    const { data, error } = await ctx.supabase
      .from("client_kyc")
      .update({ verified_by: ctx.user.id, verified_on: today, next_review_on: next })
      .eq("client_id", input.clientId)
      .eq("updated_at", input.kycUpdatedAt)
      .select("id");
    throwIfDbError(error);
    if (!data?.length) return fail("The KYC record was changed by someone else. Reload to see their changes.", { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "client_kyc", resourceId: data[0].id, action: "kyc_register.reconfirm", details: { client_id: input.clientId, verified_on: today, next_review_on: next } });
    ctx.after("Add it to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "kyc_reconfirmed", title: `KYC re-confirmed by ${ctx.user.fullName}`, description: `Next annual review ${formatDate(next)}.` }),
    );
    return ok({ nextReviewOn: next });
  },
);

export const exportKycRegister = defineAction(
  { name: "kyc_register.export", schema: z.object({ query: z.string().max(2000).default("") }), roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean }>> => {
    const t = parseTableParams(new URLSearchParams(input.query), { sortable: KYC_SORTABLE, defaultSort: { sort: "client_name", dir: "asc" }, filters: KYC_FILTERS });
    const { rows, total } = await listKycRegister(ctx.supabase, { ...t, from: 0, to: EXPORT_MAX - 1 }, { limit: EXPORT_MAX });
    const header = ["Client", "Code", "Entity", "KYC state", "Missing", "Verified on", "Next review", "Audit service", "Open audits"];
    const body = rows.map((r) => [
      r.client_name ?? "",
      r.client_code ?? "",
      (r.entity_type ?? "").replace(/_/g, " "),
      KYC_STATE_INFO[(r.kyc_state ?? "missing") as KycState]?.label ?? "",
      (r.missing ?? []).join("; "),
      r.verified_on ? formatDate(r.verified_on) : "",
      r.next_review_on ? formatDate(r.next_review_on) : "",
      r.has_audit_service ? "Yes" : "No",
      r.open_audits ?? 0,
    ]);
    const truncated = total > rows.length;
    await ctx.audit({ event: "export_run", resourceType: "kyc_register", details: { rows: rows.length, truncated, query: input.query } });
    return ok({ fileName: `taxwise-kyc-register-${todayIST()}.csv`, mimeType: "text/csv;charset=utf-8", base64: Buffer.from(toCsv(header, body), "utf8").toString("base64"), rows: rows.length, truncated });
  },
);

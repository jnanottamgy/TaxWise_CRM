import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums";
import { toPaise, type Paise } from "@/lib/domain/money";
import { ratioPercent } from "@/lib/domain/collections";
import { fyEnd, fyStart, type DateString } from "@/lib/domain/fy";
import { formatDateRange } from "@/lib/format";
import { REPORT_META, type ReportFilters, type ReportSlug } from "@/lib/schemas/reports";
import type { ReportResult } from "@/components/reports/report-types";

/**
 * What every report module shares (server/reports/*.ts): calling its database function under the
 * caller's session, reading amounts into paise, rates, and the period and filters in words.
 */

export type ReportContext = {
  today: DateString;
  /** The Excel/PDF export: every row of the long lists, not a page of them. */
  forExport: boolean;
};

export type ReportLoader = (supabase: ServerSupabase, f: ReportFilters, ctx: ReportContext) => Promise<ReportResult>;

export type ReportFunction = "report_compliance" | "report_work" | "report_clients" | "report_collections" | "report_people" | "report_pipeline" | "report_practice";

/** Calls one of the 0213 report functions (each takes one jsonb argument, `p`). */
export async function callReport<T>(supabase: ServerSupabase, fn: ReportFunction, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, { p: params as Json });
  if (error) throw error;
  return data as T;
}

/** A decimal string or number from the database as paise (0 when missing). */
export function paise(v: string | number | null | undefined): Paise {
  if (v === null || v === undefined || v === "") return 0;
  return toPaise(v);
}

/** `part` of `whole` as a percentage with one decimal, or null when the whole is 0. */
export function rate(part: number, whole: number): number | null {
  return ratioPercent(Math.round(part), Math.round(whole), 1);
}

/** "FY 2026-27 so far" / "FY 2025-26" / "01 Sep – 30 Sep 2026". */
export function periodLabel(f: ReportFilters, today: DateString): string {
  if (REPORT_META[f.slug].period === "fy" || f.defaultPeriod) {
    const whole = f.from === fyStart(f.fy) && f.to === fyEnd(f.fy);
    if (whole) return `FY ${f.fy}`;
    if (f.from === fyStart(f.fy) && f.to === today) return `FY ${f.fy} to date`;
  }
  return formatDateRange(f.from, f.to);
}

/** The filters in force, in words, for the header and the exports. */
export async function scopeLabels(supabase: ServerSupabase, f: ReportFilters): Promise<string[]> {
  const out: string[] = [];
  const meta = REPORT_META[f.slug];
  const [client, people] = await Promise.all([
    f.clientId ? supabase.from("clients").select("display_name, client_code").eq("id", f.clientId).maybeSingle() : Promise.resolve({ data: null }),
    f.ownerId || f.employeeId
      ? supabase.from("employees").select("id, full_name").in("id", [f.ownerId, f.employeeId].filter((v): v is string => !!v))
      : Promise.resolve({ data: [] as Array<{ id: string; full_name: string }> }),
  ]);
  const name = (id: string | null) => (people.data ?? []).find((p) => p.id === id)?.full_name ?? "Someone no longer listed";
  if (f.clientId) out.push(`Client: ${client.data ? `${client.data.display_name} (${client.data.client_code})` : "a client no longer listed"}`);
  if (f.ownerId) out.push(`Client owner: ${name(f.ownerId)}`);
  if (f.service) out.push(`Service: ${SERVICE_TYPE_LABELS[f.service]}`);
  if (f.employeeId) out.push(`${meta.employeeLabel ?? "Person"}: ${name(f.employeeId)}`);
  return out;
}

/** The header every report shares. */
export async function reportHeader(supabase: ServerSupabase, slug: ReportSlug, f: ReportFilters, ctx: ReportContext): Promise<Pick<ReportResult, "slug" | "title" | "counts" | "period" | "scope" | "generatedAt">> {
  const meta = REPORT_META[slug];
  return {
    slug,
    title: meta.title,
    counts: meta.counts,
    period: { from: f.from, to: f.to, label: periodLabel(f, ctx.today) },
    scope: await scopeLabels(supabase, f),
    generatedAt: new Date().toISOString(),
  };
}

/** Rows shown on screen for a capped list; the export takes all of them. */
export const SCREEN_LIST_ROWS = 25;

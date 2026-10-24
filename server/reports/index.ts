import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { ReportFilters, ReportSlug } from "@/lib/schemas/reports";
import type { ReportResult } from "@/components/reports/report-types";
import type { ReportContext, ReportLoader } from "@/server/reports/shared";
import { loadComplianceReport } from "@/server/reports/compliance";
import { loadWorkReport } from "@/server/reports/work";
import { loadClientsReport } from "@/server/reports/clients";
import { loadRevenueReport } from "@/server/reports/revenue";
import { loadCollectionsReport } from "@/server/reports/collections";
import { loadPeopleReport } from "@/server/reports/people";
import { loadPipelineReport } from "@/server/reports/pipeline";
import { loadPracticeReport } from "@/server/reports/practice";

/**
 * The reports centre's modules (§7.16), one per report: each runs its query under the caller's
 * session, says what it counts, and returns a ReportResult that the page, the Excel workbook
 * (server/reports/excel.ts) and the PDF (server/reports/pdf.tsx) all render.
 */
const LOADERS: Readonly<Record<ReportSlug, ReportLoader>> = {
  compliance: loadComplianceReport,
  work: loadWorkReport,
  clients: loadClientsReport,
  revenue: loadRevenueReport,
  collections: loadCollectionsReport,
  people: loadPeopleReport,
  pipeline: loadPipelineReport,
  practice: loadPracticeReport,
};

export function loadReport(supabase: ServerSupabase, f: ReportFilters, ctx: ReportContext): Promise<ReportResult> {
  return LOADERS[f.slug](supabase, f, ctx);
}

export type { ReportContext } from "@/server/reports/shared";

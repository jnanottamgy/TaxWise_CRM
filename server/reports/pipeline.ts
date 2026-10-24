import "server-only";

import { LEAD_SOURCE_LABELS, isEnumValue } from "@/lib/domain/enums";
import { getStatus } from "@/lib/status";
import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult, ReportRow } from "@/components/reports/report-types";
import { callReport, paise, rate, reportHeader, type ReportLoader } from "@/server/reports/shared";

/**
 * Pipeline (§7.16): "leads by source/stage, conversion, quotation win rate, average deal value".
 * Leads created in the period, by source and by the stage they are at now; leads won and lost in the
 * period (conversion = won of those closed); quotations sent, accepted, rejected and expired in the
 * period (win rate = accepted of those decided); deal values are quotation subtotals before GST.
 * Partners and Managers only (§4.1). report_pipeline (0213) counts it in SQL.
 */

type Raw = {
  kpis: {
    leads_created: number;
    won: number;
    lost: number;
    quotations_sent: number;
    accepted: number;
    rejected: number;
    expired: number;
    sent_value: string;
    accepted_value: string;
    rejected_value: string;
    expired_value: string;
    avg_deal_value: string | null;
    open_quotations: number;
    open_value: string;
    avg_days_to_win: number | null;
  };
  by_source: Array<{ source: string; leads: number; won: number; lost: number; open: number; estimated_value: string }>;
  by_stage: Array<{ status: string; leads: number; estimated_value: string }>;
  by_author: Array<{ profile_id: string; name: string | null; sent: number; accepted: number; rejected: number; expired: number; accepted_value: string }>;
};

export const loadPipelineReport: ReportLoader = async (supabase, f, ctx) => {
  const [header, r] = await Promise.all([reportHeader(supabase, "pipeline", f, ctx), callReport<Raw>(supabase, "report_pipeline", reportRpcParams(f))]);
  const k = r.kpis;
  const decided = k.accepted + k.rejected + k.expired;

  const sources: ReportRow[] = r.by_source.map((s) => ({
    source: isEnumValue("lead_source", s.source) ? LEAD_SOURCE_LABELS[s.source] : s.source,
    leads: s.leads,
    won: s.won,
    lost: s.lost,
    open: s.open,
    conversion: rate(s.won, s.won + s.lost),
    value: paise(s.estimated_value),
  }));

  const stages: ReportRow[] = r.by_stage.map((s) => {
    const info = getStatus("lead_status", s.status);
    return { stage: { label: info.label, tone: info.tone, meaning: info.meaning }, leads: s.leads, value: paise(s.estimated_value) };
  });

  const authors: ReportRow[] = r.by_author.map((a) => ({
    author: a.name ?? "Someone no longer listed",
    sent: a.sent,
    accepted: a.accepted,
    rejected: a.rejected,
    expired: a.expired,
    win_rate: rate(a.accepted, a.accepted + a.rejected + a.expired),
    value: paise(a.accepted_value),
  }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Quotation win rate", kind: "percent", value: rate(k.accepted, decided), sub: decided ? `${k.accepted} accepted of ${decided} decided` : "No quotation decided in the period" },
      { label: "Leads created", kind: "count", value: k.leads_created, href: "/leads" },
      { label: "Lead conversion", kind: "percent", value: rate(k.won, k.won + k.lost), sub: k.won + k.lost ? `${k.won} won, ${k.lost} lost` : "No lead closed in the period" },
      { label: "Average deal value", kind: "money", value: k.avg_deal_value === null ? null : paise(k.avg_deal_value), sub: "Accepted quotations, before GST" },
      { label: "Open quotations", kind: "money", value: paise(k.open_value), sub: `${k.open_quotations} within validity`, href: "/quotations" },
    ],
    sections: [
      {
        id: "sources",
        title: "Leads by source",
        description:
          k.avg_days_to_win === null
            ? "Leads created in the period, and leads won or lost in it. Conversion is won of those closed."
            : `Leads created in the period, and leads won or lost in it. Conversion is won of those closed; a won lead took ${Number(k.avg_days_to_win).toFixed(1)} days on average.`,
        columns: [
          { key: "source", header: "Source", kind: "text", mobile: "primary" },
          { key: "leads", header: "Leads", kind: "count", mobile: "secondary" },
          { key: "won", header: "Won", kind: "count", mobile: "secondary" },
          { key: "lost", header: "Lost", kind: "count", hideBelow: "lg" },
          { key: "open", header: "Still open", kind: "count", hideBelow: "lg" },
          { key: "conversion", header: "Conversion", kind: "percent", mobile: "trailing" },
          { key: "value", header: "Estimated value", kind: "money", hideBelow: "xl" },
        ],
        rows: sources,
        totals:
          sources.length > 1
            ? {
                source: "All sources",
                leads: k.leads_created,
                won: k.won,
                lost: k.lost,
                open: r.by_source.reduce((n, s) => n + s.open, 0),
                conversion: rate(k.won, k.won + k.lost),
                value: r.by_source.reduce((n, s) => n + paise(s.estimated_value), 0),
              }
            : null,
        empty: "No leads were created, won or lost in this period.",
      },
      {
        id: "stages",
        title: "Leads by stage",
        description: "Where the leads created in the period stand today.",
        columns: [
          { key: "stage", header: "Stage", kind: "status", mobile: "primary" },
          { key: "leads", header: "Leads", kind: "count", mobile: "trailing" },
          { key: "value", header: "Estimated value", kind: "money", mobile: "secondary" },
        ],
        rows: stages,
        empty: "No leads were created in this period.",
        half: true,
      },
      {
        id: "quotations",
        title: "Quotations",
        description: "Sent in the period, and decided in it. Values are before GST; share is of those decided.",
        columns: [
          { key: "figure", header: "Quotations", kind: "text", mobile: "primary" },
          { key: "count", header: "Count", kind: "count", mobile: "secondary" },
          { key: "value", header: "Value", kind: "money", mobile: "trailing" },
          { key: "share", header: "Share", kind: "percent", mobile: "secondary" },
        ],
        rows: [
          { figure: "Sent", count: k.quotations_sent, value: paise(k.sent_value), share: null },
          { figure: "Accepted", count: k.accepted, value: paise(k.accepted_value), share: rate(k.accepted, decided) },
          { figure: "Rejected", count: k.rejected, value: paise(k.rejected_value), share: rate(k.rejected, decided) },
          { figure: "Expired", count: k.expired, value: paise(k.expired_value), share: rate(k.expired, decided) },
        ],
        empty: "No quotations in this period.",
        half: true,
      },
      {
        id: "authors",
        title: "Quotations by who prepared them",
        columns: [
          { key: "author", header: "Prepared by", kind: "text", mobile: "primary" },
          { key: "sent", header: "Sent", kind: "count", mobile: "secondary" },
          { key: "accepted", header: "Accepted", kind: "count", mobile: "secondary" },
          { key: "rejected", header: "Rejected", kind: "count", hideBelow: "lg" },
          { key: "expired", header: "Expired", kind: "count", hideBelow: "lg" },
          { key: "win_rate", header: "Win rate", kind: "percent", mobile: "secondary" },
          { key: "value", header: "Accepted value", kind: "money", mobile: "trailing" },
        ],
        rows: authors,
        empty: "No quotations were sent or decided in this period.",
      },
    ],
  };
  return result;
};

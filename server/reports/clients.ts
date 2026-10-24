import "server-only";

import { ENTITY_TYPE_LABELS, SERVICE_TYPE_LABELS, isEnumValue } from "@/lib/domain/enums";
import { MONTH_ABBR } from "@/lib/domain/fy";
import { getStatus } from "@/lib/status";
import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult } from "@/components/reports/report-types";
import { callReport, rate, reportHeader, SCREEN_LIST_ROWS, type ReportLoader } from "@/server/reports/shared";

/**
 * Clients (§7.16): "by status, service, entity type, group; new clients per month; churned
 * (inactive) clients". Clients outside the recycle bin. A client joins on the day onboarding finished
 * (or the day it was added, before onboarding existed); it churned on the day it was last made
 * Inactive, if it still is. Services count active engagements. report_clients (0213) counts it in SQL.
 */

type Raw = {
  kpis: { total: number; active: number; pending: number; new: number; churned: number };
  by_status: Array<{ status: string; clients: number }>;
  by_entity: Array<{ entity_type: string | null; clients: number; active: number }>;
  by_service: Array<{ service_type: string; clients: number; active_clients: number }>;
  by_group: Array<{ group_id: string | null; name: string | null; clients: number; active: number }>;
  groups_total: number;
  new_per_month: Array<{ month: string; clients: number }>;
  churned_total: number;
  churned: Array<{ client_id: string; display_name: string; client_code: string; owner_name: string | null; changed_on: string; reason: string | null }>;
};

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

export const loadClientsReport: ReportLoader = async (supabase, f, ctx) => {
  const [header, r] = await Promise.all([reportHeader(supabase, "clients", f, ctx), callReport<Raw>(supabase, "report_clients", reportRpcParams(f))]);
  const k = r.kpis;

  const churned = (ctx.forExport ? r.churned : r.churned.slice(0, SCREEN_LIST_ROWS)).map((c) => ({
    client: { text: c.display_name, href: `/clients/${c.client_id}`, sub: c.client_code },
    owner: c.owner_name ?? "No owner",
    on: c.changed_on,
    reason: c.reason ?? "",
  }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Active clients", kind: "count", value: k.active, sub: `${k.total} in all`, href: "/clients?status=active" },
      { label: "New in the period", kind: "count", value: k.new, sub: "Onboarded" },
      { label: "Made inactive", kind: "count", value: k.churned, sub: "In the period, still inactive" },
      { label: "Waiting to finish onboarding", kind: "count", value: k.pending, href: "/clients?status=pending" },
    ],
    sections: [
      {
        id: "new",
        title: "New clients per month",
        description: "Clients who finished onboarding in each month of the period.",
        columns: [
          { key: "month", header: "Month", kind: "text", mobile: "primary" },
          { key: "clients", header: "New clients", kind: "count", mobile: "trailing" },
        ],
        rows: r.new_per_month.map((m) => ({ month: monthLabel(m.month), clients: m.clients })),
        totals: { month: "Period", clients: k.new },
        empty: "No months in this period.",
        chart: { x: "month", y: "clients", label: "New clients", xLabel: "Month", format: "number" },
        half: true,
      },
      {
        id: "status",
        title: "By status",
        columns: [
          { key: "status", header: "Status", kind: "status", mobile: "primary" },
          { key: "clients", header: "Clients", kind: "count", mobile: "trailing" },
          { key: "share", header: "Share", kind: "percent", mobile: "secondary" },
        ],
        rows: r.by_status.map((s) => {
          const info = getStatus("client_status", s.status);
          return { status: { label: info.label, tone: info.tone, meaning: info.meaning }, clients: s.clients, share: rate(s.clients, k.total) };
        }),
        totals: { status: "All clients", clients: k.total, share: k.total ? 100 : null },
        empty: "No clients yet.",
        half: true,
      },
      {
        id: "service",
        title: "By service",
        description: "Clients with an active engagement for each service; a client with several services counts under each.",
        columns: [
          { key: "service", header: "Service", kind: "text", mobile: "primary" },
          { key: "clients", header: "Clients", kind: "count", mobile: "trailing" },
          { key: "active", header: "Of them active", kind: "count", mobile: "secondary" },
        ],
        rows: r.by_service.map((s) => ({ service: isEnumValue("service_type", s.service_type) ? SERVICE_TYPE_LABELS[s.service_type] : s.service_type, clients: s.clients, active: s.active_clients })),
        empty: "No client has an active engagement.",
        half: true,
      },
      {
        id: "entity",
        title: "By entity type",
        columns: [
          { key: "entity", header: "Entity type", kind: "text", mobile: "primary" },
          { key: "clients", header: "Clients", kind: "count", mobile: "trailing" },
          { key: "active", header: "Of them active", kind: "count", mobile: "secondary" },
        ],
        rows: r.by_entity.map((e) => ({ entity: e.entity_type && isEnumValue("entity_type", e.entity_type) ? ENTITY_TYPE_LABELS[e.entity_type] : "Not recorded", clients: e.clients, active: e.active })),
        empty: "No clients yet.",
        half: true,
      },
      {
        id: "group",
        title: "By group",
        description: r.groups_total > 24 ? `The largest of ${r.groups_total} groups, and clients in no group.` : "Client groups, and clients in no group.",
        columns: [
          { key: "group", header: "Group", kind: "link", mobile: "primary" },
          { key: "clients", header: "Clients", kind: "count", mobile: "trailing" },
          { key: "active", header: "Of them active", kind: "count", mobile: "secondary" },
        ],
        rows: r.by_group.map((g) => ({
          group: g.group_id ? { text: g.name ?? "Group", href: `/clients/groups/${g.group_id}` } : "In no group",
          clients: g.clients,
          active: g.active,
        })),
        empty: "No clients yet.",
        half: true,
      },
      {
        id: "churned",
        title: "Made inactive in the period",
        description: "Clients whose status was last changed to Inactive in the period, with the reason given.",
        columns: [
          { key: "client", header: "Client", kind: "link", mobile: "primary" },
          { key: "owner", header: "Owner", kind: "text", mobile: "secondary" },
          { key: "on", header: "Made inactive", kind: "date", mobile: "trailing" },
          { key: "reason", header: "Reason", kind: "text", hideBelow: "lg" },
        ],
        rows: churned,
        total: r.churned_total,
        more: r.churned_total > churned.length ? { label: `View all inactive clients`, href: "/clients?status=inactive" } : null,
        empty: "No client was made inactive in this period.",
        half: true,
      },
    ],
  };
  return result;
};

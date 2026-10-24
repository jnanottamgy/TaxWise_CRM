import { SERVICE_TYPES, type ServiceType } from "@/lib/domain/enums";
import { compareDates, diffDays, fyEnd, fyStart, isDateString, isFinancialYear, financialYearOf, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { DEFAULT_PAGE_SIZE, isPageSize, readParam, type PageSize, type SearchParamsInput } from "@/components/app/data-table/params";

/**
 * The reports centre (§7.16): which reports there are, what each counts (the one line under its
 * title, §7.16 "Each report states what it counts"), which filters each takes, and the URL state they
 * share. Client-safe. Every report is for Partners and Managers (§4.1); the money reports (revenue,
 * collections, pipeline) never reach an Employee, and neither does any other.
 */

export const REPORT_SLUGS = ["compliance", "work", "clients", "revenue", "collections", "people", "pipeline", "practice"] as const;
export type ReportSlug = (typeof REPORT_SLUGS)[number];

export function isReportSlug(v: unknown): v is ReportSlug {
  return typeof v === "string" && (REPORT_SLUGS as readonly string[]).includes(v);
}

export type ReportFilterKey = "client" | "owner" | "service" | "employee";

export type ReportMeta = {
  title: string;
  /** The question the report answers (its index card). */
  question: string;
  /** What it counts, in one line under the title (§7.16). */
  counts: string;
  /** The filters it takes besides the period. */
  filters: readonly ReportFilterKey[];
  /** `range`: any period (default: the FY so far). `fy`: one financial year. */
  period: "range" | "fy";
  /** Shows fee, invoice or quotation amounts. */
  money: boolean;
  /** What "Person" means in this report's filter. */
  employeeLabel?: string;
};

export const REPORT_META: Readonly<Record<ReportSlug, ReportMeta>> = {
  compliance: {
    title: "Compliance",
    question: "Are returns going in on time, and what is coming up?",
    counts: "Statutory returns due in the period, filed on or before the due date or after it, and those still not filed; the next eight weeks' returns; overdue returns by client owner. Cancelled returns are left out.",
    filters: ["client", "owner", "service", "employee"],
    period: "range",
    money: false,
    employeeLabel: "Prepared by",
  },
  work: {
    title: "Work",
    question: "Who is getting work filed, and where is it stuck?",
    counts: "Tasks created and filed in the period per assignee, average days from creation to filing, reviews sent back out of those submitted, and tasks waiting for the client's data today.",
    filters: ["client", "owner", "service", "employee"],
    period: "range",
    money: false,
    employeeLabel: "Assigned to",
  },
  clients: {
    title: "Clients",
    question: "What does the client base look like, and is it growing?",
    counts: "Clients outside the recycle bin by status, entity type, active service and group; clients who joined in the period; clients made inactive in the period.",
    filters: ["owner", "service"],
    period: "range",
    money: false,
  },
  revenue: {
    title: "Revenue and realisation",
    question: "How much of what was agreed has been billed and collected?",
    counts: "Fees agreed for the FY's billing periods against the fee value invoiced (before GST) and collected (received plus TDS), by service and client; invoices and collections by month; periods with no invoice.",
    filters: ["client", "service"],
    period: "fy",
    money: true,
  },
  collections: {
    title: "Collections",
    question: "What is owed, how old is it, and are clients paying as promised?",
    counts: "Outstanding on issued invoices by days since the invoice date; collected (received plus TDS) out of what there was to collect in the period; payment promises falling due in the period against what came in.",
    filters: ["client", "owner", "service"],
    period: "range",
    money: true,
  },
  people: {
    title: "People",
    question: "Where did the team's time go, and who was in?",
    counts: "Hours logged in the period and the billable share, attendance days as recorded, and approved leave on working days, per person.",
    filters: ["client", "service", "employee"],
    period: "range",
    money: false,
    employeeLabel: "Person",
  },
  pipeline: {
    title: "Pipeline",
    question: "Where do new clients come from, and how often do quotations win?",
    counts: "Leads created in the period by source and stage, leads won and lost, quotations sent, accepted, rejected and expired, the win rate (accepted of those decided) and average accepted value before GST.",
    filters: ["client", "owner", "service", "employee"],
    period: "range",
    money: true,
    employeeLabel: "Quoted by",
  },
  practice: {
    title: "Practice",
    question: "Are the firm's ICAI and engagement records in order?",
    counts: "UDINs for reports signed in the period, each partner's tax audits for the FY against the ceiling, DSCs and registrations expiring within 90 days, and engagement letters for active clients for the FY.",
    filters: ["client", "owner", "service", "employee"],
    period: "range",
    money: false,
    employeeLabel: "Signed by",
  },
};

export const REPORT_FILTER_LABEL: Readonly<Record<ReportFilterKey, string>> = {
  client: "Client",
  owner: "Client owner",
  service: "Service",
  employee: "Person",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SPAN_DAYS = 3660;

export type ReportFilters = {
  slug: ReportSlug;
  from: DateString;
  to: DateString;
  /** No period chosen: the FY in the top bar, to today if it is the current one. */
  defaultPeriod: boolean;
  /** The FY a per-year section reports (the FY of `to`). */
  fy: FinancialYear;
  clientId: string | null;
  ownerId: string | null;
  service: ServiceType | null;
  employeeId: string | null;
  page: number;
  pageSize: PageSize;
  /** A period in the URL that couldn't be used, said in a sentence. */
  periodError: string | null;
};

/** The period a report shows when none is chosen: the FY, ending today while it is still running. */
export function defaultReportPeriod(fy: FinancialYear, today: DateString): { from: DateString; to: DateString } {
  const end = fyEnd(fy);
  const start = fyStart(fy);
  return { from: start, to: compareDates(today, end) < 0 && compareDates(today, start) >= 0 ? today : end };
}

/**
 * Reads a report's filters from the URL (`?from&to&client&owner&service&employee&page&size`), keeping
 * only those the report takes. Never throws: a bad period falls back to the default and says why.
 */
export function parseReportFilters(sp: SearchParamsInput, slug: ReportSlug, ctx: { selectedFy: FinancialYear; today: DateString }): ReportFilters {
  const meta = REPORT_META[slug];
  const takes = (k: ReportFilterKey) => meta.filters.includes(k);
  const id = (name: string) => {
    const v = readParam(sp, name);
    return v && UUID.test(v) ? v : null;
  };

  let periodError: string | null = null;
  let from: DateString;
  let to: DateString;
  let defaultPeriod = true;
  const rawFrom = readParam(sp, "from");
  const rawTo = readParam(sp, "to");
  const base = defaultReportPeriod(ctx.selectedFy, ctx.today);
  if (rawFrom || rawTo) {
    if (!isDateString(rawFrom) || !isDateString(rawTo)) {
      periodError = "That period isn't a pair of dates, so the report shows the financial year instead.";
      ({ from, to } = base);
    } else if (compareDates(rawTo, rawFrom) < 0) {
      periodError = "That period ends before it starts, so the report shows the financial year instead.";
      ({ from, to } = base);
    } else if (diffDays(rawTo, rawFrom) > MAX_SPAN_DAYS) {
      periodError = "Reports cover at most ten years at a time, so the report shows the financial year instead.";
      ({ from, to } = base);
    } else {
      from = rawFrom;
      to = rawTo;
      defaultPeriod = false;
    }
  } else {
    ({ from, to } = base);
  }

  let fy: FinancialYear = financialYearOf(to);
  if (meta.period === "fy") {
    // A per-year report: the FY the chosen period ends in, shown in full.
    fy = defaultPeriod ? ctx.selectedFy : financialYearOf(to);
    if (!isFinancialYear(fy)) fy = ctx.selectedFy;
    from = fyStart(fy);
    to = fyEnd(fy);
  }

  const rawService = readParam(sp, "service");
  const pageRaw = Number.parseInt(readParam(sp, "page") ?? "1", 10);
  const sizeRaw = Number.parseInt(readParam(sp, "size") ?? "", 10);
  return {
    slug,
    from,
    to,
    defaultPeriod,
    fy,
    clientId: takes("client") ? id("client") : null,
    ownerId: takes("owner") ? id("owner") : null,
    service: takes("service") && rawService && (SERVICE_TYPES as readonly string[]).includes(rawService) ? (rawService as ServiceType) : null,
    employeeId: takes("employee") ? id("employee") : null,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 100000) : 1,
    pageSize: isPageSize(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE,
    periodError,
  };
}

/** The parameters every report function in the database takes (0213). */
export function reportRpcParams(f: ReportFilters, page?: { offset: number; limit: number }): Record<string, unknown> {
  return {
    from: f.from,
    to: f.to,
    fy: f.fy,
    client_id: f.clientId,
    owner_id: f.ownerId,
    service: f.service,
    employee_id: f.employeeId,
    ...(page ? { offset: page.offset, limit: page.limit } : {}),
  };
}

/** The URL of a report with its filters (for the export links and the index cards). */
export function reportQueryString(f: Pick<ReportFilters, "from" | "to" | "defaultPeriod" | "clientId" | "ownerId" | "service" | "employeeId">): string {
  const p = new URLSearchParams();
  if (!f.defaultPeriod) {
    p.set("from", f.from);
    p.set("to", f.to);
  }
  if (f.clientId) p.set("client", f.clientId);
  if (f.ownerId) p.set("owner", f.ownerId);
  if (f.service) p.set("service", f.service);
  if (f.employeeId) p.set("employee", f.employeeId);
  return p.toString();
}

export const REPORT_FORMATS = ["xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGoToItems, getNav, getNewActions } from "@/lib/nav";
import { APP_ROLES } from "@/lib/auth/roles";
import { isPublicPath, pathAllowedForRole } from "@/lib/supabase/proxy";
import { JOB_SCHEDULE, SCHEDULED_JOBS } from "@/server/jobs/schedule";
import { parseTableParams } from "@/components/app/data-table/params";
import { INVOICE_LIST_FILTERS, INVOICE_LIST_SORTABLE, listFinancialYear } from "@/lib/schemas/invoices";
import { QUOTATION_FILTERS, QUOTATION_SORTABLE } from "@/lib/schemas/quotations";
import { whatsAppCommandLabel } from "@/components/shell/search-contract";

/**
 * Wave B integration: the sidebar, Go to and "+ New" reach real pages for leads, quotations,
 * invoices, collections, messaging, the portal and WhatsApp; every new job body is scheduled at its
 * §8 time (IST − 5:30 in JOB_SCHEDULE); the public quotation page and its PDF need no session.
 */

const ROOT = join(__dirname, "..", "..");

const WAVE_B_STAFF_ROUTES = [
  "/inbox",
  "/messages",
  "/whatsapp-groups",
  "/leads",
  "/leads/[id]",
  "/quotations",
  "/quotations/new",
  "/quotations/[id]",
  "/acceptance",
  "/invoices",
  "/invoices/new",
  "/invoices/[id]",
  "/payments",
  "/fee-realisation",
  "/revenue",
  "/tds-credits",
  "/retainer-drafts",
  "/templates/messages",
  "/settings/whatsapp",
];

const PORTAL_ROUTES = ["/portal", "/portal/deadlines", "/portal/compliance", "/portal/documents", "/portal/invoices", "/portal/invoices/[id]", "/portal/messages", "/portal/help"];

const staffPage = (path: string) => join(ROOT, "app", "(staff)", ...path.split("/").filter(Boolean), "page.tsx");
const portalPage = (path: string) => join(ROOT, "app", "(portal)", ...path.split("/").filter(Boolean), "page.tsx");
const pathOf = (href: string) => href.split(/[?#]/)[0];

describe("wave B pages", () => {
  it("every wave B staff route has a page and a loading state", () => {
    const missing = WAVE_B_STAFF_ROUTES.flatMap((r) => {
      const page = staffPage(r);
      return [existsSync(page) ? null : `${r} page`, existsSync(page.replace(/page\.tsx$/, "loading.tsx")) ? null : `${r} loading`].filter(Boolean);
    });
    expect(missing).toEqual([]);
  });

  it("every portal route has a page and a loading state, including the invoice the emails link to", () => {
    const missing = PORTAL_ROUTES.flatMap((r) => {
      const page = portalPage(r);
      return [existsSync(page) ? null : `${r} page`, existsSync(page.replace(/page\.tsx$/, "loading.tsx")) ? null : `${r} loading`].filter(Boolean);
    });
    expect(missing).toEqual([]);
  });

  it("the public quotation page and its PDF exist", () => {
    expect(existsSync(join(ROOT, "app", "q", "[token]", "page.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "app", "q", "[token]", "pdf", "route.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "app", "api", "q", "[token]", "pdf", "route.ts"))).toBe(true);
  });
});

describe("wave B navigation", () => {
  it("every sidebar and Go to link for a wave B route resolves, for every role", () => {
    for (const role of APP_ROLES) {
      const hrefs = [...getNav(role).flatMap((g) => g.items), ...getGoToItems(role)].map((i) => pathOf(i.href));
      for (const href of hrefs.filter((h) => WAVE_B_STAFF_ROUTES.includes(h))) expect(existsSync(staffPage(href)), `${role}: ${href}`).toBe(true);
      for (const href of hrefs.filter((h) => h.startsWith("/portal"))) expect(existsSync(portalPage(href)), `${role}: ${href}`).toBe(true);
    }
  });

  it("'+ New' invoice, quotation and lead land on pages that open their form (Partners and Managers)", () => {
    for (const role of ["partner", "manager"] as const) {
      const byId = Object.fromEntries(getNewActions(role).map((a) => [a.id, a.href]));
      expect(byId.invoice, role).toBe("/invoices/new");
      expect(byId.quotation, role).toBe("/quotations/new");
      expect(byId.lead, role).toBe("/leads?new=1");
      for (const id of ["invoice", "quotation", "lead"] as const) expect(existsSync(staffPage(pathOf(byId[id]))), `${role} ${id}`).toBe(true);
    }
    // /leads reads ?new=1 and opens the New lead dialog.
    expect(readFileSync(staffPage("/leads"), "utf8")).toContain('defaultOpen={one(sp.new) === "1"}');
  });

  it("Employees get no money '+ New' actions", () => {
    const ids = getNewActions("employee").map((a) => a.id);
    for (const id of ["invoice", "quotation", "lead"]) expect(ids).not.toContain(id);
  });
});

describe("dashboard links (§7.2) open the filtered list behind each tile", () => {
  const invoices = (status: string) =>
    parseTableParams({ status }, { sortable: INVOICE_LIST_SORTABLE, defaultSort: { sort: "issue_date", dir: "desc" }, filters: INVOICE_LIST_FILTERS }).filters.status;
  const quotations = (status: string) =>
    parseTableParams({ status }, { sortable: QUOTATION_SORTABLE, defaultSort: { sort: "created_at", dir: "desc" }, filters: QUOTATION_FILTERS }).filters.status;

  it("/invoices honours ?status=awaiting_approval, sent,partially_paid,disputed and overdue, across every year", () => {
    expect(invoices("awaiting_approval")).toEqual(["awaiting_approval"]);
    expect(invoices("sent,partially_paid,disputed")).toEqual(["sent", "partially_paid", "disputed"]);
    expect(invoices("overdue")).toEqual(["overdue"]);
    // Money still owed shows every year, not just the selected FY.
    expect(listFinancialYear(null, ["overdue"], "2026-27")).toBeNull();
    expect(listFinancialYear(null, ["sent", "partially_paid", "disputed"], "2026-27")).toBeNull();
  });

  it("/quotations honours ?status=pending_approval and sent,viewed", () => {
    expect(quotations("pending_approval")).toEqual(["pending_approval"]);
    expect(quotations("sent,viewed")).toEqual(["sent", "viewed"]);
  });
});

describe("wave B scheduled jobs (§8)", () => {
  const at = (job: string) => JOB_SCHEDULE.filter((e) => e.job === job).map((e) => e.cron);

  it("every wave B job body is scheduled", () => {
    for (const job of ["quotations", "lead-follow-ups", "receivables-sweep", "retainer-billing", "invoice-reminders", "team-health", "whatsapp-housekeeping", "access-review", "new-fy"]) {
      expect(Object.keys(SCHEDULED_JOBS), job).toContain(job);
      expect(at(job), job).toHaveLength(1);
    }
  });

  it("the times match §8 in IST (UTC + 5:30)", () => {
    expect(at("receivables-sweep")).toEqual(["0 2 * * *"]); // 07:30 IST
    expect(at("retainer-billing")).toEqual(["0 4 * * *"]); // 09:30 IST
    expect(at("invoice-reminders")).toEqual(["30 4 * * *"]); // 10:00 IST
    expect(at("quotations")).toEqual(["0 9 * * *"]); // 14:30 IST
    expect(at("team-health")).toEqual(["0 3 * * 1"]); // Monday 08:30 IST
    expect(at("whatsapp-housekeeping")).toEqual(["15 3 * * 1"]); // Monday 08:45 IST
    expect(at("access-review")).toEqual(["35 3 1 1,4,7,10 *"]); // 09:05 IST on 1 Jan, Apr, Jul, Oct
    expect(at("new-fy")).toEqual(["0 1 1 4 *"]); // 06:30 IST on 1 April
    expect(at("lead-follow-ups")).toEqual(["30 * * * *"]); // hourly, on the hour in IST
  });

  it("the registry runs every scheduled job (and nothing else)", () => {
    const registry = readFileSync(join(ROOT, "server", "jobs", "registry.ts"), "utf8");
    for (const job of Object.keys(SCHEDULED_JOBS)) expect(registry, job).toMatch(new RegExp(`(^|[\\s{,])"?${job}"?[,:]`, "m"));
  });
});

describe("wave B public paths", () => {
  it("the quotation page and its PDF need no session; the portal invoice PDF does", () => {
    expect(isPublicPath("/q/abc")).toBe(true);
    expect(isPublicPath("/api/q/abc/pdf")).toBe(true);
    expect(isPublicPath("/api/portal/invoices/1/pdf")).toBe(false);
    expect(isPublicPath("/portal/invoices/1")).toBe(false);
  });

  it("clients land only in the portal; staff never do", () => {
    expect(pathAllowedForRole("/portal/invoices/1", "client")).toBe(true);
    expect(pathAllowedForRole("/invoices/1", "client")).toBe(false);
    expect(pathAllowedForRole("/portal/invoices/1", "partner")).toBe(false);
  });
});

describe("⌘K Open chat (§7.25.5)", () => {
  it("names the command after the client, possessive as written", () => {
    expect(whatsAppCommandLabel("XYZ Traders")).toBe("Open XYZ Traders' WhatsApp");
    expect(whatsAppCommandLabel("Ravi Kumar")).toBe("Open Ravi Kumar's WhatsApp");
    expect(whatsAppCommandLabel("  ")).toBe("Open the client's WhatsApp");
  });
});

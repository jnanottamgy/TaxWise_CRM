import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getGoToItems, getNav, getNewActions } from "@/lib/nav";
import { APP_ROLES } from "@/lib/auth/roles";
import { SCHEDULED_JOBS } from "@/server/jobs/schedule";
import { applyTablePatch, parseTableParams, RESERVED_PARAMS } from "@/components/app/data-table/params";
import { CLIENT_LIST_FILTERS, flagOptionsFor } from "@/lib/schemas/clients";
import { PEOPLE_FILTERS, PEOPLE_SORTABLE } from "@/lib/data/people";
import { calendarTitle, parseCalendarState } from "@/components/compliance/logic/calendar";
import { agendaHref } from "@/components/home/logic";
import { parseRecentSearches } from "@/components/shell/search-contract";
import { groupOf, timelineGroups } from "@/components/client360/logic/timeline";
import { SETTINGS_SECTIONS } from "@/lib/schemas/settings";

/**
 * Wave C integration: the registers, letters, quality, audits, workpapers, reports, search, recycle
 * bin, audit log and home pages are reachable for every role that links to them; every new job body
 * is scheduled with the 09:00 IST reminders; the dashboard links open exactly the list behind each
 * figure (§7.2); an FY filter reaches the URL; the palette reads recent searches from the server.
 */

const ROOT = join(__dirname, "..", "..");
const pathOf = (href: string) => href.split(/[?#]/)[0];

const WAVE_C_STAFF_ROUTES = [
  "/registers",
  "/engagement-letters",
  "/quality",
  "/audits",
  "/audits/[id]",
  "/workpapers",
  "/workpapers/gst-recon",
  "/workpapers/gst-recon/[id]",
  "/workpapers/itr",
  "/workpapers/itr/new",
  "/workpapers/itr/[id]",
  "/workpapers/financial-statements",
  "/workpapers/financial-statements/[id]",
  "/workpapers/notices",
  "/workpapers/notices/[id]",
  "/reports",
  "/reports/[slug]",
  "/audit-log",
  "/recycle-bin",
  "/search",
  "/settings/data",
  "/settings/templates",
  "/dashboard",
  "/my-day",
];

const staffDir = (path: string) => join(ROOT, "app", "(staff)", ...path.split("/").filter(Boolean));
const portalDir = (path: string) => join(ROOT, "app", "(portal)", ...path.split("/").filter(Boolean));

/** A page and the loading state that covers it (its own, or a layout's above it). */
function routeProblems(dir: string, route: string): string[] {
  if (!existsSync(join(dir, "page.tsx"))) return [`${route}: no page`];
  let d = dir;
  while (d.length > ROOT.length) {
    if (existsSync(join(d, "loading.tsx"))) return [];
    d = dirname(d);
  }
  return [`${route}: no loading state`];
}

describe("wave C pages", () => {
  it("every wave C route has a page and a loading state of its own", () => {
    const missing = WAVE_C_STAFF_ROUTES.flatMap((r) => {
      const dir = staffDir(r);
      return [existsSync(join(dir, "page.tsx")) ? null : `${r} page`, existsSync(join(dir, "loading.tsx")) ? null : `${r} loading`].filter(Boolean);
    });
    expect(missing).toEqual([]);
  });

  it("every sidebar, Go to and '+ New' destination of every role is a real page with a loading state", () => {
    const problems: string[] = [];
    for (const role of APP_ROLES) {
      const hrefs = new Set([...getNav(role).flatMap((g) => g.items), ...getGoToItems(role), ...getNewActions(role)].map((i) => pathOf(i.href)));
      for (const href of hrefs) problems.push(...routeProblems(href.startsWith("/portal") ? portalDir(href) : staffDir(href), `${role} ${href}`));
    }
    expect(problems).toEqual([]);
  });

  it("every Settings section opens a page, Templates included (§7.21)", () => {
    expect(SETTINGS_SECTIONS.flatMap((s) => routeProblems(staffDir(`/settings/${s.slug}`), s.slug))).toEqual([]);
  });

  it("an Employee reaches their own independence declaration from ⌘K, not the sidebar (§4.2)", () => {
    expect(getGoToItems("employee").map((i) => i.href)).toContain("/quality");
    expect(getNav("employee").flatMap((g) => g.items).map((i) => i.href)).not.toContain("/quality");
  });
});

describe("wave C scheduled jobs (§8)", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
  const at = (job: string) => vercel.crons.filter((c) => pathOf(c.path) === `/api/cron/${job}`).map((c) => c.schedule);
  const registry = readFileSync(join(ROOT, "server", "jobs", "registry.ts"), "utf8");

  it("registers, notices and practice reminders run daily with the 09:00 IST reminders, after them", () => {
    expect(at("reminders")).toEqual(["30 3 * * *"]); // 09:00 IST
    expect(at("register-expiries")).toEqual(["32 3 * * *"]); // 09:02 IST
    expect(at("notice-reminders")).toEqual(["34 3 * * *"]); // 09:04 IST
    expect(at("practice-reminders")).toEqual(["36 3 * * *"]); // 09:06 IST
    for (const job of ["register-expiries", "notice-reminders", "practice-reminders"]) {
      expect(Object.keys(SCHEDULED_JOBS), job).toContain(job);
      expect(registry, job).toContain(`"${job}":`);
      expect(existsSync(join(ROOT, "server", "jobs", `${job}.ts`)), job).toBe(true);
    }
  });
});

describe("dashboard links open the list behind each figure (§7.2)", () => {
  const sp = (href: string) => Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));

  it("Team online now opens People filtered to those online", () => {
    const t = parseTableParams(sp("/people?presence=online"), { sortable: PEOPLE_SORTABLE, defaultSort: { sort: "full_name", dir: "asc" }, filters: PEOPLE_FILTERS });
    expect(t.filters.presence).toEqual(["online"]);
  });

  it("Filings due in 7 days opens the agenda for exactly those 7 days", () => {
    const href = agendaHref("2026-10-24", "2026-10-31");
    expect(href).toBe("/calendar?view=agenda&date=2026-10-24&to=2026-10-31");
    const state = parseCalendarState(sp(href), "2026-10-24");
    expect(state).toMatchObject({ view: "agenda", from: "2026-10-24", to: "2026-10-31" });
    expect(calendarTitle(state)).toBe("24 Oct 2026 to 31 Oct 2026");
    // An end before the start is ignored; without one the agenda runs on.
    expect(parseCalendarState({ view: "agenda", date: "2026-10-24", to: "2026-10-01" }, "2026-10-24").to).toBeNull();
    expect(agendaHref("2026-10-24")).toBe("/calendar?view=agenda&date=2026-10-24");
  });

  it("At-risk clients opens the client list on the same rule, for Partners and Managers only", () => {
    const t = parseTableParams(sp("/clients?flag=at_risk"), { sortable: ["display_name"], defaultSort: { sort: "display_name", dir: "asc" }, filters: CLIENT_LIST_FILTERS });
    expect(t.filters.flag).toEqual(["at_risk"]);
    expect(flagOptionsFor(true)).toContain("at_risk");
    expect(flagOptionsFor(false)).not.toContain("at_risk");
    expect(flagOptionsFor(false)).not.toContain("overdue_invoices");
  });
});

describe("table filters", () => {
  it("an FY chosen in a FilterBar reaches the URL (fy is an ordinary filter, not reserved)", () => {
    expect(RESERVED_PARAMS).not.toContain("fy");
    expect(applyTablePatch(new URLSearchParams("status=sent&page=3"), { filters: { fy: ["2025-26"] } })).toBe("status=sent&fy=2025-26");
    expect(applyTablePatch(new URLSearchParams("fy=2025-26"), { filters: { fy: [] } })).toBe("");
  });
});

describe("⌘K recent searches come from the server (§7.18)", () => {
  it("reads GET /api/search?recent=1, and anything else as none", () => {
    expect(parseRecentSearches({ ok: true, data: { groups: [], recent: [{ id: "a1", query: "Sharma", searchedAt: "2026-10-24T04:00:00Z" }, { id: "a2", query: "  " }, { query: "no id" }] } })).toEqual([
      { id: "a1", query: "Sharma", searchedAt: "2026-10-24T04:00:00Z" },
    ]);
    expect(parseRecentSearches({ ok: false, error: "Your session has ended." })).toEqual([]);
    expect(parseRecentSearches(null)).toEqual([]);
  });

  it("the palette no longer keeps searches in localStorage", () => {
    const hook = readFileSync(join(ROOT, "components", "shell", "use-recent.ts"), "utf8");
    expect(hook).toContain("/api/search?recent=1");
    expect(hook).toMatch(/rememberSearch\(/);
    expect(hook).not.toMatch(/useLocalStorageJSON<unknown>\(`tw:recent-searches/);
  });
});

describe("Client 360 timeline groups wave C events", () => {
  it("files workpapers, registers and audits under their own heading, open to Employees", () => {
    for (const t of ["gst_recon_run", "itr_computation_final", "financial_statements_reviewed", "notice_logged", "audit_engagement_created", "dsc_added", "registration_updated", "credential_removed"]) {
      expect(groupOf(t), t).toBe("practice");
    }
    expect(groupOf("udin_logged")).toBe("compliance");
    expect(groupOf("engagement_letter_issued")).toBe("billing");
    expect(timelineGroups(false).map((g) => g.id)).toContain("practice");
  });
});

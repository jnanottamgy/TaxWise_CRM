import { describe, expect, it } from "vitest";
import {
  PORTAL_NAV,
  defaultNewAction,
  findActiveNav,
  getGoToItems,
  getNav,
  getNewActions,
  isNavHref,
  navMatchScore,
  type NavItem,
} from "@/lib/nav";
import { APP_ROLES, type AppRole } from "@/lib/auth/roles";

/** Every route in docs/CONVENTIONS.md §2 that a nav item may link to (path only). */
const FIXED_ROUTES = [
  "/dashboard", "/my-day", "/inbox", "/search", "/profile",
  "/clients", "/clients/new", "/clients/groups", "/whatsapp-groups", "/messages",
  "/work", "/filings", "/calendar", "/timesheet",
  "/workpapers/gst-recon", "/workpapers/itr", "/workpapers/financial-statements", "/workpapers/notices",
  "/leads", "/quotations", "/quotations/new", "/acceptance",
  "/invoices", "/invoices/new", "/payments", "/fee-realisation", "/revenue", "/tds-credits", "/retainer-drafts",
  "/people", "/performance", "/leave",
  "/registers", "/engagement-letters", "/quality", "/audits", "/templates/jobs", "/templates/messages",
  "/reports", "/audit-log", "/recycle-bin",
  ...["firm", "bank", "numbering", "billing", "working-hours", "reminders", "email", "whatsapp", "law", "templates", "data", "diagnostics"].map(
    (s) => `/settings/${s}`,
  ),
  "/portal", "/portal/deadlines", "/portal/compliance", "/portal/documents", "/portal/invoices", "/portal/messages", "/portal/help",
];

const STAFF: AppRole[] = ["partner", "manager", "employee"];

function path(href: string): string {
  return href.split(/[?#]/)[0];
}

/** Every href a role can reach from the shell: sidebar, palette "Go to" and "+ New". */
function reachable(role: AppRole): string[] {
  return [
    ...getNav(role).flatMap((g) => g.items.map((i) => i.href)),
    ...getGoToItems(role).map((i) => i.href),
    ...getNewActions(role).map((a) => a.href),
  ].map(path);
}

function labels(role: AppRole): string[] {
  return getNav(role).flatMap((g) => g.items.map((i) => i.label));
}

const startsWithAny = (p: string, prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));

describe("lib/nav: routes", () => {
  it.each(APP_ROLES)("%s links only to the fixed routes", (role) => {
    for (const href of reachable(role)) expect(FIXED_ROUTES).toContain(href);
  });

  it.each(APP_ROLES)("%s has unique ids and hrefs in the sidebar", (role) => {
    const items = getNav(role).flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
  });

  it.each(APP_ROLES)("%s gets every item with an icon, a label and a one-line description", (role) => {
    for (const item of getGoToItems(role)) {
      expect(item.icon).toBeTruthy();
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(10);
      expect(item.description.endsWith(".")).toBe(true);
    }
  });

  it("uses sentence-case group labels", () => {
    for (const role of STAFF) {
      for (const g of getNav(role)) {
        if (g.label) expect(g.label[0]).toBe(g.label[0].toUpperCase());
        if (g.label) expect(g.label.slice(1)).toBe(g.label.slice(1).toLowerCase());
      }
    }
  });
});

describe("lib/nav: §4.2 sidebars", () => {
  it("gives the Partner the nine groups in order", () => {
    expect(getNav("partner").map((g) => g.label)).toEqual([
      "Home", "Clients", "Work", "Workpapers", "Growth", "Money", "Team", "Practice", "Admin",
    ]);
    expect(labels("partner")).toEqual([
      "Dashboard", "Inbox",
      "Clients", "Client groups", "WhatsApp groups",
      "Work tracker", "Filings", "Calendar", "Timesheet",
      "GST reconciliation", "ITR computation", "Financial statements", "Notices",
      "Leads & quotations",
      "Invoices", "Payments", "Fee realisation", "Revenue",
      "People", "Performance & attendance", "Leave",
      "Registers", "Engagement letters", "Quality", "Job templates", "Message templates",
      "Reports", "Audit log", "Recycle bin", "Settings",
    ]);
  });

  it("gives the Manager the Partner's list minus Payments and Audit log, with Settings as their profile", () => {
    const partner = labels("partner").filter((l) => l !== "Payments" && l !== "Audit log");
    expect(labels("manager")).toEqual(partner);
    const settings = getNav("manager").flatMap((g) => g.items).find((i) => i.label === "Settings");
    expect(settings?.href).toBe("/profile");
  });

  it("gives the Employee My day · My tasks · My clients · My timesheet · Calendar · four workpapers · Messages · Leave · Profile", () => {
    expect(labels("employee")).toEqual([
      "My day", "My tasks", "My clients", "My timesheet", "Calendar",
      "GST reconciliation", "ITR computation", "Financial statements", "Notices",
      "Messages", "Leave", "Profile",
    ]);
  });

  it("gives the Client the portal's seven pages", () => {
    expect(getNav("client").flatMap((g) => g.items.map((i) => i.label))).toEqual([
      "Home", "Deadlines", "Compliance", "Documents", "Invoices", "Messages", "Help",
    ]);
    expect(PORTAL_NAV.every((i) => i.href === "/portal" || i.href.startsWith("/portal/"))).toBe(true);
  });
});

describe("lib/nav: what each role must never be offered", () => {
  const EMPLOYEE_FORBIDDEN = [
    // money (§4.1: never, anywhere)
    "/invoices", "/payments", "/fee-realisation", "/revenue", "/tds-credits", "/retainer-drafts", "/reports",
    // leads and quotations
    "/leads", "/quotations", "/acceptance",
    // firm settings, audit log, admin
    "/settings", "/audit-log", "/recycle-bin", "/dashboard", "/people", "/performance",
    "/clients/new",
  ];

  it("never gives an Employee money, leads, quotations, settings, audit or payments routes", () => {
    for (const p of reachable("employee")) {
      expect(startsWithAny(p, EMPLOYEE_FORBIDDEN), `employee reaches ${p}`).toBe(false);
    }
  });

  it("never gives a Manager payments, the audit log, diagnostics or firm settings", () => {
    for (const p of reachable("manager")) {
      expect(startsWithAny(p, ["/payments", "/audit-log", "/settings"]), `manager reaches ${p}`).toBe(false);
    }
  });

  it("gives the Partner payments, the audit log, diagnostics and every settings section", () => {
    const p = reachable("partner");
    for (const href of ["/payments", "/audit-log", "/settings/firm", "/settings/diagnostics", "/settings/whatsapp", "/settings/law"]) {
      expect(p).toContain(href);
    }
  });

  it("never sends staff into the portal, or a Client out of it", () => {
    for (const role of STAFF) for (const p of reachable(role)) expect(p.startsWith("/portal")).toBe(false);
    for (const p of reachable("client")) expect(p === "/portal" || p.startsWith("/portal/")).toBe(true);
  });
});

describe("lib/nav: + New", () => {
  it("offers Partners and Managers every New item and Employees only Log time", () => {
    const all = ["New client", "New task", "New invoice", "New quotation", "New lead", "Log time"];
    expect(getNewActions("partner").map((a) => a.label)).toEqual(all);
    expect(getNewActions("manager").map((a) => a.label)).toEqual(all);
    expect(getNewActions("employee").map((a) => a.label)).toEqual(["Log time"]);
    expect(getNewActions("client")).toEqual([]);
  });

  it("makes New task the main action for Partners and Managers, Log time for Employees", () => {
    expect(defaultNewAction("partner")?.id).toBe("task");
    expect(defaultNewAction("manager")?.id).toBe("task");
    expect(defaultNewAction("employee")?.id).toBe("time");
    expect(defaultNewAction("client")).toBeNull();
  });
});

describe("lib/nav: the active item", () => {
  const item = (href: string, match?: string[]): Pick<NavItem, "href" | "match"> => ({ href, match });

  it("matches exact paths and sub-paths, never look-alike prefixes", () => {
    expect(navMatchScore("/clients", item("/clients"))).toBeGreaterThan(0);
    expect(navMatchScore("/clients/123", item("/clients"))).toBeGreaterThan(0);
    expect(navMatchScore("/clientsx", item("/clients"))).toBe(-1);
    expect(navMatchScore("/work", item("/work?new=1"))).toBeGreaterThan(0);
  });

  it("prefers the longest match", () => {
    expect(findActiveNav("/clients/groups/9", "partner")?.item.label).toBe("Client groups");
    expect(findActiveNav("/clients/9", "partner")?.item.label).toBe("Clients");
    expect(findActiveNav("/quotations/42", "partner")?.item.label).toBe("Leads & quotations");
    expect(findActiveNav("/settings", "partner")?.item.label).toBe("Settings");
    const diagnostics = findActiveNav("/settings/diagnostics", "partner");
    expect(diagnostics?.item.label).toBe("Diagnostics");
    expect(diagnostics?.parent?.item.label).toBe("Settings");
    expect(diagnostics?.parent?.group.label).toBe("Admin");
    expect(findActiveNav("/work/7", "employee")?.item.label).toBe("My tasks");
    expect(findActiveNav("/portal/documents", "client")?.item.label).toBe("Documents");
  });

  it("names pages outside the sidebar from the palette's destinations", () => {
    const search = findActiveNav("/search", "manager");
    expect(search?.item.label).toBe("Search");
    expect(search?.group).toBeNull();
    expect(search?.parent).toBeNull();
    expect(findActiveNav("/inbox", "employee")?.item.label).toBe("Inbox");
  });

  it("lets only the role's own sidebar items be favourites", () => {
    expect(isNavHref("partner", "/payments")).toBe(true);
    expect(isNavHref("manager", "/payments")).toBe(false);
    expect(isNavHref("employee", "/invoices")).toBe(false);
    expect(isNavHref("employee", "/my-day")).toBe(true);
  });
});

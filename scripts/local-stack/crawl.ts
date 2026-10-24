/**
 * Crawls every route as every role against the local QA stack (README.md) and writes a report.
 *
 *   npx tsx scripts/local-stack/crawl.ts [--round r1] [--out <dir>] [--roles partner,manager,employee,client,anon]
 *                                        [--viewports desktop-light,desktop-dark,mobile-light] [--only <text>]
 *                                        [--concurrency 4] [--no-shots]
 *   npx tsx scripts/local-stack/crawl.ts --round r1 --report-only   (rebuild report.md from results.jsonl)
 *
 * For each role (Partner P1, Manager M1, Employee E1, the portal user CA, and anonymous) it visits the
 * role's routes from lib/nav.ts, detail pages found in the QA database, and a sample of other roles'
 * routes that must be refused. Each visit runs at 1366×768 light, 1366×768 dark and 390×844 light and
 * records the HTTP status, error boundaries, ShellUnavailable, block errors with their Ref (matched to
 * the app's log), Next error text, page errors, console errors, failed requests, horizontal overflow,
 * the h1 and the load time, with a full-page screenshot.
 *
 * Output: <out>/<round>/report.json, report.md, results.jsonl (one line per visit, written as it goes, so
 * an interrupted run keeps what it saw) and <role>/<slug>-<viewport>.png.
 * Default <out>: .local-stack/qa (or $QA_OUT_DIR).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { Client } from "pg";
import { dbUrl } from "../db-local";
import { APP_URL, LOG_DIR, QA_DB, STATE_DIR, chromeBin } from "./config";
import { playwrightCookies, sessionForKey } from "./sessions";
import { C, F, U, fid } from "../../tests/db/fixtures";
import { getGoToItems, PORTAL_NAV } from "@/lib/nav";
import { REPORT_SLUGS } from "@/lib/schemas/reports";
import type { AppRole } from "@/lib/auth/roles";

// =================================================================================================
// What to visit
// =================================================================================================

type RoleKey = "partner" | "manager" | "employee" | "client" | "anon";
type Expect = "ok" | "refused";
type Visit = { role: RoleKey; path: string; slug: string; expect: Expect; why?: string };

const USERS: Record<Exclude<RoleKey, "anon">, string> = { partner: "P1", manager: "M1", employee: "E1", client: "CA" };

const VIEWPORTS = {
  "desktop-light": { viewport: { width: 1366, height: 768 }, colorScheme: "light" as const, theme: "light" },
  "desktop-dark": { viewport: { width: 1366, height: 768 }, colorScheme: "dark" as const, theme: "dark" },
  "mobile-light": { viewport: { width: 390, height: 844 }, colorScheme: "light" as const, theme: "light", isMobile: true, hasTouch: true },
} as const;
type ViewportKey = keyof typeof VIEWPORTS;

const CLIENT_TABS = ["overview", "profile", "services", "tasks", "compliance", "documents", "workpapers", "registers", "billing", "engagement", "communication", "whatsapp", "timeline"];
const REGISTER_TABS = ["vault", "registrations", "dsc", "udin", "filings"];
const WORK_VIEWS = ["table", "board", "calendar", "review"];
const SETTINGS = ["firm", "bank", "numbering", "billing", "working-hours", "reminders", "email", "whatsapp", "law", "templates", "data", "diagnostics"];

const qid = (name: string) => fid(`qa:${name}`);

function slugOf(path: string): string {
  const s = path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "id")
    .replace(/[0-9a-f]{32,}/gi, "token")
    .replace(/^\//, "")
    .replace(/[?&=#/]+/g, "-")
    .replace(/[^a-z0-9-]/gi, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return s || "home";
}

async function discover(): Promise<Record<string, string | null>> {
  const db = new Client({ connectionString: dbUrl(QA_DB) });
  await db.connect();
  try {
    const one = async (sql: string, params: unknown[] = []) => ((await db.query(sql, params)).rows[0]?.id as string | undefined) ?? null;
    return {
      group: await one("select g.id from public.client_groups g where exists (select 1 from public.clients c where c.group_id = g.id and c.deleted_at is null) order by g.name limit 1"),
      engagementLetter: await one("select id from public.engagement_letters where client_id = $1 limit 1", [C.B]),
      itrA: await one("select id from public.itr_computations where client_id = $1 limit 1", [C.A]),
      itrAny: await one("select id from public.itr_computations order by status, created_at limit 1"),
      notice: await one("select id from public.tax_notices where client_id = $1 order by created_at limit 1", [C.B]),
      token: ((await db.query("select token from public.quotations where id = $1", [qid("quotation:sent")])).rows[0]?.token as string | undefined) ?? null,
      portalInvoice: await one("select id from public.invoices where client_id = $1 and status <> 'draft' and deleted_at is null order by issue_date desc limit 1", [C.A]),
      // Another client's issued invoice: the portal user of Alpha Traders must never open it.
      otherClientInvoice: await one("select id from public.invoices where client_id = $1 and status <> 'draft' and deleted_at is null order by issue_date desc limit 1", [C.B]),
    };
  } finally {
    await db.end();
  }
}

function visitsFor(role: RoleKey, d: Record<string, string | null>): Visit[] {
  const out: Visit[] = [];
  const add = (path: string, slug = slugOf(path), expect: Expect = "ok", why?: string) => out.push({ role, path, slug, expect, why });
  if (role === "anon") {
    add("/login");
    if (d.token) add(`/q/${d.token}`, "q-token");
    // Signed out: every app page sends you to sign in.
    for (const p of ["/dashboard", "/clients", "/invoices", "/portal", "/portal/invoices"]) add(p, `refuse-${slugOf(p)}`, "refused", `Signed out → ${p}`);
    return out;
  }
  if (role === "client") {
    for (const item of PORTAL_NAV) add(item.href);
    add("/portal/welcome");
    if (d.portalInvoice) add(`/portal/invoices/${d.portalInvoice}`, "portal-invoices-detail");
    add("/dashboard", "refuse-dashboard", "refused", "Client → staff dashboard");
    for (const p of ["/clients", `/clients/${C.A}`, "/work", "/invoices", "/messages", "/settings/firm"]) add(p, `refuse-${slugOf(p)}`, "refused", `Client → staff page ${p}`);
    if (d.otherClientInvoice) add(`/portal/invoices/${d.otherClientInvoice}`, "refuse-portal-invoices-other-client", "refused", "Client → another client's invoice");
    return out;
  }
  const appRole = role as AppRole;
  const staffManager = role === "partner" || role === "manager";
  for (const item of getGoToItems(appRole)) add(item.href);
  // Detail pages, with records the role can see.
  const client = role === "employee" ? C.A : C.B;
  for (const tab of CLIENT_TABS) add(`/clients/${client}?tab=${tab}`, `client-360-${tab}`);
  add(`/work/${qid("task:e1-sent-back")}`, "work-detail");
  for (const v of WORK_VIEWS) add(`/work?view=${v}`, `work-view-${v}`);
  add(`/workpapers/gst-recon/${qid("recon:beta:092026")}`, "workpapers-gst-recon-detail");
  if (d.itrA) add(`/workpapers/itr/${d.itrA}`, "workpapers-itr-detail");
  add("/workpapers/itr/new", "workpapers-itr-new");
  add(`/workpapers/financial-statements/${qid(`fs:${C.B}`)}`, "workpapers-financial-statements-detail");
  if (d.notice) add(`/workpapers/notices/${d.notice}`, "workpapers-notices-detail");
  add("/workpapers");
  add("/search?q=a", "search-q-a");
  add("/timesheet?new=1", "timesheet-new");
  if (staffManager) {
    add("/clients/new");
    if (d.group) add(`/clients/groups/${d.group}`, "client-groups-detail");
    add("/work?new=1", "work-new");
    add(`/leads/${qid("lead:nego")}`, "leads-detail");
    add("/leads?new=1", "leads-new");
    add(`/quotations/${qid("quotation:sent")}`, "quotations-detail");
    add(`/quotations/${qid("quotation:draft")}/edit`, "quotations-edit");
    add("/quotations/new");
    add(`/invoices/${qid("invoice:awaiting")}`, "invoices-detail-awaiting");
    add(`/invoices/${qid("invoice:paid-tds")}`, "invoices-detail-paid");
    add(`/invoices/${F.invoiceDraft("A")}/edit`, "invoices-edit");
    add("/invoices/new");
    add(`/audits/${qid("audit:beta-statutory")}`, "audits-detail");
    add(`/people/${U.E1.employeeId}`, "people-detail");
    if (d.engagementLetter) add(`/engagement-letters/${d.engagementLetter}`, "engagement-letters-detail");
    add("/engagement-letters/new");
    for (const tab of REGISTER_TABS) add(`/registers?tab=${tab}`, `registers-${tab}`);
    for (const slug of REPORT_SLUGS) add(`/reports/${slug}`);
  }
  if (role === "partner") {
    add("/settings");
    for (const s of SETTINGS) if (!out.some((v) => v.path === `/settings/${s}`)) add(`/settings/${s}`);
  }
  // Other roles' pages that must be refused.
  const refuse = (paths: string[], who: string) => paths.forEach((p) => add(p, `refuse-${slugOf(p)}`, "refused", `${who} → ${p}`));
  if (role === "employee") {
    // Money, growth, practice management and firm settings (§4.1): Partners and Managers only.
    refuse(
      [
        "/invoices", "/quotations", "/leads", "/payments", "/fee-realisation", "/revenue", "/tds-credits", "/retainer-drafts", "/acceptance",
        "/audits", "/engagement-letters", "/reports", "/recycle-bin", "/audit-log", "/clients/groups", "/whatsapp-groups", "/filings",
        "/settings/firm", "/settings/bank", "/settings/numbering", "/settings/data",
        `/invoices/${qid("invoice:awaiting")}`, `/quotations/${qid("quotation:sent")}`, `/audits/${qid("audit:beta-statutory")}`, `/leads/${qid("lead:nego")}`,
        "/clients/new", "/invoices/new", "/quotations/new",
      ],
      "Employee",
    );
    // The Employee's home is My day: the firm dashboard redirects there.
    refuse(["/dashboard"], "Employee");
  }
  if (role === "manager") refuse(["/payments", "/audit-log", "/settings/firm", "/settings/bank", "/settings/numbering", "/settings/billing", "/settings/email", "/settings/law", "/settings/data", "/settings/templates"], "Manager");
  // Unique by path.
  const seen = new Set<string>();
  return out.filter((v) => (seen.has(v.path) ? false : (seen.add(v.path), true)));
}

// =================================================================================================
// Areas (how the report groups problems)
// =================================================================================================

type Area = "clients" | "work" | "money" | "practice" | "portal" | "auth";

function areaOf(path: string): Area {
  const p = path.split("?")[0];
  const under = (...prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));
  if (under("/portal", "/whatsapp-groups", "/settings/whatsapp")) return "portal";
  if (under("/login")) return "auth";
  if (under("/clients", "/filings", "/calendar")) return "clients";
  if (under("/invoices", "/payments", "/fee-realisation", "/revenue", "/tds-credits", "/retainer-drafts", "/leads", "/quotations", "/acceptance", "/q")) return "money";
  if (under("/workpapers", "/registers", "/engagement-letters", "/quality", "/audits", "/reports", "/search", "/recycle-bin", "/audit-log", "/settings")) return "practice";
  return "work";
}

// =================================================================================================
// One visit
// =================================================================================================

type Problem = { kind: string; detail: string };
type Result = {
  role: RoleKey;
  path: string;
  slug: string;
  viewport: ViewportKey;
  expect: Expect;
  area: Area;
  status: number | null;
  finalUrl: string;
  h1: string | null;
  h1Count: number;
  loadMs: number;
  themeDark: boolean | null;
  overflow: { scrollWidth: number; clientWidth: number } | null;
  errorBoundary: boolean;
  shellUnavailable: boolean;
  blockErrors: Array<{ message: string; ref: string | null; log: string | null }>;
  nextError: string | null;
  boundaryRef: string | null;
  boundaryLog: string | null;
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: Array<{ status: number | string; method: string; url: string }>;
  screenshot: string | null;
  problems: Problem[];
};

const REFUSAL_TITLES = ["Not available for your role", "Page not found"];
const NEXT_ERROR_PATTERNS = [/Application error: a (client|server)-side exception has occurred/i, /Unhandled Runtime Error/i, /Internal Server Error/i, /This page could not be found\./i, /An error occurred in the Server Components render/i];

let appLogCache: { size: number; text: string } | null = null;
function appLog(): string {
  const p = join(LOG_DIR, "app.log");
  if (!existsSync(p)) return "";
  const size = statSync(p).size;
  if (!appLogCache || appLogCache.size !== size) appLogCache = { size, text: readFileSync(p, "utf8") };
  return appLogCache.text;
}

/** The app log lines around a Ref (logUnexpected's JSON, or Next's digest line). */
function logFor(ref: string | null): string | null {
  if (!ref) return null;
  const lines = appLog().split("\n");
  const at = lines.findIndex((l) => l.includes(ref));
  if (at < 0) return null;
  const line = lines[at];
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const err = (j.err ?? j.error) as Record<string, unknown> | string | undefined;
    const text =
      err && typeof err === "object"
        ? `${String(err.name ?? "Error")}: ${String(err.message ?? "")}${err.code ? ` [${String(err.code)}]` : ""}${err.details ? ` ${String(err.details)}` : ""}${err.hint ? ` (hint: ${String(err.hint)})` : ""}`
        : String(err ?? j.msg ?? "");
    return `${String(j.source ?? "")}: ${text}`.slice(0, 600);
  } catch {
    // Next's own line: "⨯ Error: <message>" a few lines above "digest: '<ref>'".
    for (let i = at; i >= Math.max(0, at - 25); i--) {
      if (/^\s*(⨯\s*)?([A-Za-z]*Error|Error)\b/.test(lines[i])) return lines[i].replace(/^\s*⨯\s*/, "").trim().slice(0, 600);
    }
    return lines.slice(Math.max(0, at - 2), at + 4).join(" ").replace(/\s+/g, " ").slice(0, 600);
  }
}

function sameOrigin(url: string): boolean {
  return url.startsWith(APP_URL);
}

async function visit(browser: Browser, v: Visit, vp: ViewportKey, outDir: string | null, shots: boolean): Promise<Result> {
  const conf = VIEWPORTS[vp];
  const opts: BrowserContextOptions = {
    viewport: conf.viewport,
    colorScheme: conf.colorScheme,
    deviceScaleFactor: 1,
    isMobile: "isMobile" in conf ? conf.isMobile : false,
    hasTouch: "hasTouch" in conf ? conf.hasTouch : false,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  };
  const ctx = await browser.newContext(opts);
  if (v.role !== "anon") await ctx.addCookies(playwrightCookies(sessionForKey(USERS[v.role])));
  await ctx.addInitScript((theme: string) => {
    try {
      window.localStorage.setItem("theme", theme);
    } catch {
      // storage blocked: the app falls back to its default theme
    }
  }, conf.theme);
  const page: Page = await ctx.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failed: Result["failedRequests"] = [];
  // In-flight requests, for "settled". The presence heartbeat is a keepalive fetch, which Chromium never
  // reports as finished, so Playwright's own networkidle would wait forever on pages that send it.
  const inflight = new Set<unknown>();
  const counts = (url: string) => !url.includes("/api/presence/heartbeat");
  page.on("request", (r) => {
    if (counts(r.url())) inflight.add(r);
  });
  page.on("requestfinished", (r) => inflight.delete(r));
  page.on("requestfailed", (r) => inflight.delete(r));
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 500)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 500));
  });
  page.on("response", (r) => {
    const url = r.url();
    if (r.status() >= 400 && (url.includes("/rest/v1/") || sameOrigin(url))) failed.push({ status: r.status(), method: r.request().method(), url: url.slice(0, 300) });
  });
  page.on("requestfailed", (r) => {
    const url = r.url();
    const why = r.failure()?.errorText ?? "failed";
    if (why.includes("ERR_ABORTED")) return; // navigations and prefetches the page cancelled itself
    if (url.includes("/rest/v1/") || sameOrigin(url)) failed.push({ status: why, method: r.method(), url: url.slice(0, 300) });
  });

  const started = Date.now();
  let status: number | null = null;
  let navError: string | null = null;
  try {
    const res = await page.goto(`${APP_URL}${v.path}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    status = res?.status() ?? null;
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => undefined);
    // Settled: nothing in flight for 600 ms (at most 20 s).
    const until = Date.now() + 20_000;
    let quietSince = Date.now();
    while (Date.now() < until) {
      await page.waitForTimeout(100);
      if (inflight.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 600) break;
    }
  } catch (err) {
    navError = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  const loadMs = Date.now() - started;

  const facts = await page
    .evaluate(() => {
      const h1s = [...document.querySelectorAll("h1")];
      const text = document.body?.innerText ?? "";
      const blocks = [...document.querySelectorAll('[data-slot="error-block"]')].map((el) => {
        const msg = el.querySelector("p")?.textContent?.trim() ?? el.textContent?.trim() ?? "";
        const ref = el.querySelector("p + p .font-mono, .font-mono")?.textContent?.trim() ?? null;
        return { message: msg.slice(0, 300), ref };
      });
      const boundary = h1s.some((h) => /This page didn.t load/.test(h.textContent ?? ""));
      const boundaryRef = boundary ? (document.querySelector("h1 ~ p .font-mono, .font-mono")?.textContent?.trim() ?? null) : null;
      return {
        h1: h1s[0]?.textContent?.trim() ?? null,
        h1Count: h1s.length,
        text: text.slice(0, 20000),
        blocks,
        boundary,
        boundaryRef,
        shell: h1s.some((h) => /We couldn.t open/.test(h.textContent ?? "")),
        dark: document.documentElement.classList.contains("dark"),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    })
    .catch(() => null);

  let screenshot: string | null = null;
  if (outDir && shots) {
    const dir = join(outDir, v.role);
    mkdirSync(dir, { recursive: true });
    screenshot = join(dir, `${v.slug}-${vp}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, timeout: 30_000 }).catch(async () => {
      await page.screenshot({ path: screenshot!, timeout: 15_000 }).catch(() => {
        screenshot = null;
      });
    });
  }
  const finalUrl = page.url();
  await ctx.close();

  const nextError = facts ? (NEXT_ERROR_PATTERNS.map((re) => facts.text.match(re)?.[0]).find(Boolean) ?? null) : null;
  const r: Result = {
    role: v.role,
    path: v.path,
    slug: v.slug,
    viewport: vp,
    expect: v.expect,
    area: areaOf(v.path),
    status,
    finalUrl: finalUrl.replace(APP_URL, ""),
    h1: facts?.h1 ?? null,
    h1Count: facts?.h1Count ?? 0,
    loadMs,
    themeDark: facts ? facts.dark : null,
    overflow: facts ? { scrollWidth: facts.scrollWidth, clientWidth: facts.clientWidth } : null,
    errorBoundary: facts?.boundary ?? false,
    shellUnavailable: facts?.shell ?? false,
    blockErrors: (facts?.blocks ?? []).map((b) => ({ ...b, log: logFor(b.ref) })),
    nextError,
    boundaryRef: facts?.boundaryRef ?? null,
    boundaryLog: logFor(facts?.boundaryRef ?? null),
    pageErrors,
    consoleErrors,
    failedRequests: failed,
    screenshot,
    problems: [],
  };
  r.problems = judge(r, navError);
  return r;
}

// =================================================================================================
// Judging a visit
// =================================================================================================

function judge(r: Result, navError: string | null): Problem[] {
  const p: Problem[] = [];
  const add = (kind: string, detail: string) => p.push({ kind, detail });
  if (navError) add("navigation failed", navError);
  const landedOnLogin = r.role !== "anon" && r.finalUrl.startsWith("/login");
  if (landedOnLogin) add("sent to sign-in", `The session wasn't accepted: ended on ${r.finalUrl}.`);

  if (r.expect === "refused") {
    const refusedPage = r.h1 !== null && REFUSAL_TITLES.includes(r.h1);
    const redirected = r.finalUrl.split("?")[0] !== r.path.split("?")[0];
    const okStatus = r.status === 403 || r.status === 404;
    if (!(okStatus || refusedPage || redirected)) add("NOT REFUSED", `Expected a 403/404 or a redirect; got HTTP ${r.status}, h1 "${r.h1 ?? "none"}".`);
    else if (refusedPage && !okStatus) add("refusal status", `The refusal page rendered with HTTP ${r.status} instead of 403/404.`);
    if (r.errorBoundary) add("error boundary", `Refusal crashed instead (Ref ${r.boundaryRef ?? "?"}).`);
    return p;
  }

  if (r.status !== null && r.status >= 500) add(`HTTP ${r.status}`, `The page answered ${r.status}.`);
  else if (r.status !== null && r.status >= 400) add(`HTTP ${r.status}`, `An allowed page answered ${r.status} (h1 "${r.h1 ?? "none"}").`);
  if (r.errorBoundary) add("error boundary", `"This page didn't load" (Ref ${r.boundaryRef ?? "?"})${r.boundaryLog ? `: ${r.boundaryLog}` : ""}`);
  if (r.shellUnavailable) add("ShellUnavailable", "The layout couldn't confirm the sign-in.");
  for (const b of r.blockErrors) add("block error", `${b.message}${b.ref ? ` (Ref ${b.ref})` : ""}${b.log ? ` — log: ${b.log}` : ""}`);
  if (r.nextError) add("Next error text", r.nextError);
  for (const e of r.pageErrors) add("page error", e);
  for (const e of r.consoleErrors) add("console error", e);
  for (const f of r.failedRequests) add("failed request", `${f.status} ${f.method} ${f.url}`);
  if (r.overflow && r.overflow.scrollWidth > r.overflow.clientWidth + 1) add("horizontal overflow", `scrollWidth ${r.overflow.scrollWidth} > clientWidth ${r.overflow.clientWidth}`);
  if (r.h1Count === 0 && !landedOnLogin) add("no h1", "The page has no h1.");
  if (r.h1Count > 1) add("several h1", `${r.h1Count} h1 elements.`);
  if (r.viewport === "desktop-dark" && r.themeDark === false) add("dark theme not applied", "html has no .dark class with theme=dark.");
  if (r.loadMs > 12_000) add("slow", `${(r.loadMs / 1000).toFixed(1)} s to settle.`);
  if (r.h1 && REFUSAL_TITLES.includes(r.h1)) add("refused on an allowed route", `h1 "${r.h1}"`);
  return p;
}

// =================================================================================================
// The report
// =================================================================================================

const AREA_TITLES: Record<Area, string> = {
  clients: "Clients (clients, documents, compliance, filings, calendar)",
  work: "Work (work, timesheet, people, leave, performance, profile, dashboard, my-day, inbox, messages, templates)",
  money: "Money (invoices, payments, realisation, revenue, TDS credits, retainers, leads, quotations, acceptance, /q)",
  practice: "Practice (workpapers, registers, engagement letters, quality, audits, reports, search, recycle bin, audit log, settings)",
  portal: "Portal and WhatsApp (portal, WhatsApp groups, Settings → WhatsApp)",
  auth: "Sign-in",
};

function restErrors(sinceIso: string): Array<{ count: number; status: number; path: string; body: string }> {
  const p = join(LOG_DIR, "mock.log");
  if (!existsSync(p)) return [];
  const groups = new Map<string, { count: number; status: number; path: string; body: string }>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as { ts: string; kind: string; status: number; path: string; body?: string };
      if (j.kind !== "rest" || j.ts < sinceIso) continue;
      const path = j.path.split("?")[0];
      const key = `${j.status} ${path} ${(j.body ?? "").slice(0, 160)}`;
      const g = groups.get(key) ?? { count: 0, status: j.status, path, body: (j.body ?? "").slice(0, 300) };
      g.count++;
      groups.set(key, g);
    } catch {
      // not a log line
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Server-side errors the app logged during the crawl (logUnexpected JSON lines and Next's "⨯" lines), grouped. */
function appErrors(fromByte: number): Array<{ count: number; message: string }> {
  const text = appLog().slice(fromByte);
  const groups = new Map<string, number>();
  for (const line of text.split("\n")) {
    let message: string | null = null;
    if (line.startsWith("{")) {
      try {
        const j = JSON.parse(line) as { level?: string; source?: string; err?: { name?: string; message?: string; code?: string }; msg?: string };
        if (j.level === "error" || j.level === "warn") message = `[${j.level}] ${j.source ?? j.msg ?? ""}: ${j.err ? `${j.err.name ?? "Error"}: ${j.err.message ?? ""}${j.err.code ? ` [${j.err.code}]` : ""}` : (j.msg ?? "")}`;
      } catch {
        message = null;
      }
    } else if (/^\s*⨯/.test(line)) message = line.replace(/^\s*⨯\s*/, "").trim();
    if (message) groups.set(message.slice(0, 400), (groups.get(message.slice(0, 400)) ?? 0) + 1);
  }
  return [...groups.entries()].map(([message, count]) => ({ count, message })).sort((a, b) => b.count - a.count);
}

function writeReport(dir: string, round: string, results: Result[], started: string, finished: string, appLogFrom = 0) {
  const problems = results.filter((r) => r.problems.length > 0);
  const rest = restErrors(started);
  const appErrs = appErrors(appLogFrom);
  writeFileSync(join(dir, "report.json"), JSON.stringify({ round, started, finished, app: APP_URL, visits: results.length, withProblems: problems.length, restErrors: rest, appErrors: appErrs, results }, null, 2));

  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const md: string[] = [];
  md.push(`# QA crawl ${round}`, "", `${results.length} visits (${new Set(results.map((r) => `${r.role} ${r.path}`)).size} routes × viewports), ${problems.length} with problems. ${started} → ${finished}. App ${APP_URL}.`, "");
  const byKind = new Map<string, number>();
  for (const r of results) for (const p of r.problems) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  md.push("## Problems by kind", "", "| Kind | Visits |", "|---|---|", ...[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`), "");
  const refusals = results.filter((r) => r.expect === "refused");
  md.push("## Refusals", "", "| Role | Route | Viewport | HTTP | Final URL | h1 | Verdict |", "|---|---|---|---|---|---|---|");
  for (const r of refusals) md.push(`| ${r.role} | \`${r.path}\` | ${r.viewport} | ${r.status ?? "-"} | \`${r.finalUrl}\` | ${esc(r.h1 ?? "—")} | ${r.problems.length ? esc(r.problems.map((p) => p.kind).join(", ")) : "refused"} |`);
  md.push("");
  for (const area of Object.keys(AREA_TITLES) as Area[]) {
    const inArea = problems.filter((r) => r.area === area && r.expect === "ok");
    md.push(`## ${AREA_TITLES[area]}`, "");
    if (inArea.length === 0) {
      md.push(`No problems in ${results.filter((r) => r.area === area).length} visits.`, "");
      continue;
    }
    md.push("| Role | Route | Viewport | Symptom | First error | Screenshot |", "|---|---|---|---|---|---|");
    for (const r of inArea) {
      const first = r.problems[0];
      md.push(`| ${r.role} | \`${esc(r.path)}\` | ${r.viewport} | ${esc(r.problems.map((p) => p.kind).filter((k, i, a) => a.indexOf(k) === i).join(", "))} | ${esc(first.detail.slice(0, 300))} | ${r.screenshot ?? "—"} |`);
    }
    md.push("");
  }
  if (rest.length) {
    md.push("## PostgREST errors seen by the Supabase stand-in during the crawl", "", "| Count | Status | Path | Body |", "|---|---|---|---|");
    for (const g of rest.slice(0, 60)) md.push(`| ${g.count} | ${g.status} | \`${g.path}\` | ${esc(g.body)} |`);
    md.push("");
  }
  if (appErrs.length) {
    md.push("## Errors in the app's server log during the crawl", "", "| Count | Message |", "|---|---|");
    for (const g of appErrs.slice(0, 40)) md.push(`| ${g.count} | ${esc(g.message)} |`);
    md.push("");
  }
  md.push("## Slowest visits", "", "| Role | Route | Viewport | Seconds |", "|---|---|---|---|");
  for (const r of [...results].sort((a, b) => b.loadMs - a.loadMs).slice(0, 15)) md.push(`| ${r.role} | \`${r.path}\` | ${r.viewport} | ${(r.loadMs / 1000).toFixed(1)} |`);
  writeFileSync(join(dir, "report.md"), `${md.join("\n")}\n`);
}

// =================================================================================================
// Run
// =================================================================================================

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const round = arg("round", "r1");
  const outRoot = arg("out", process.env.QA_OUT_DIR ?? join(STATE_DIR, "qa"));
  const roles = arg("roles", "partner,manager,employee,client,anon").split(",") as RoleKey[];
  const viewports = arg("viewports", "desktop-light,desktop-dark,mobile-light").split(",") as ViewportKey[];
  const only = arg("only", "");
  const concurrency = Number(arg("concurrency", "4"));
  const shots = !process.argv.includes("--no-shots");
  const exe = chromeBin();
  if (!exe && !process.argv.includes("--report-only")) throw new Error("chrome-headless-shell isn't installed. See README.md (Binaries).");
  const health = await fetch(`${APP_URL}/api/health`).then((r) => r.status).catch(() => null);
  if (health !== 200 && !process.argv.includes("--report-only")) throw new Error(`The app isn't answering on ${APP_URL}. Run: npx tsx scripts/local-stack/stack.ts up`);

  const dir = join(outRoot, round);
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, "results.jsonl");
  if (process.argv.includes("--report-only")) {
    const saved = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Result);
    writeReport(dir, round, saved, arg("since", new Date(0).toISOString()), new Date().toISOString());
    console.log(`${saved.length} visits → ${join(dir, "report.md")}`);
    return;
  }
  const d = await discover();
  const queue: Array<{ v: Visit; vp: ViewportKey }> = [];
  for (const role of roles) for (const v of visitsFor(role, d)) if (!only || v.path.includes(only) || v.slug.includes(only)) for (const vp of viewports) queue.push({ v, vp });
  console.log(`Crawling ${queue.length} visits (${roles.join(", ")}; ${viewports.join(", ")}) with ${concurrency} pages at a time → ${dir}`);

  // No background traffic (component updates and the like): the browser talks to the app only.
  const browser = await chromium.launch({
    executablePath: exe ?? undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--disable-sync", "--metrics-recording-only"],
  });
  const started = new Date().toISOString();
  const appLogFrom = appLog().length;
  writeFileSync(jsonl, "");
  const results: Result[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { v, vp } = queue[next++];
      const r = await visit(browser, v, vp, dir, shots).catch(
        (err): Result => ({
          role: v.role, path: v.path, slug: v.slug, viewport: vp, expect: v.expect, area: areaOf(v.path), status: null, finalUrl: "", h1: null, h1Count: 0, loadMs: 0, themeDark: null, overflow: null,
          errorBoundary: false, shellUnavailable: false, blockErrors: [], nextError: null, boundaryRef: null, boundaryLog: null, pageErrors: [], consoleErrors: [], failedRequests: [], screenshot: null,
          problems: [{ kind: "harness", detail: err instanceof Error ? err.message : String(err) }],
        }),
      );
      results.push(r);
      appendFileSync(jsonl, `${JSON.stringify(r)}\n`);
      done++;
      if (r.problems.length || done % 25 === 0) console.log(`[${done}/${queue.length}] ${r.role} ${r.viewport} ${r.path} → ${r.status ?? "-"} ${r.problems.map((p) => p.kind).join(", ")}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  await browser.close();
  const finished = new Date().toISOString();
  results.sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path) || a.viewport.localeCompare(b.viewport));
  writeReport(dir, round, results, started, finished, appLogFrom);
  const withProblems = results.filter((r) => r.problems.length).length;
  console.log(`\n${results.length} visits, ${withProblems} with problems. Report: ${join(dir, "report.md")}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

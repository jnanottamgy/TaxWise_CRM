import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGoToItems, getNav, getNewActions } from "@/lib/nav";
import { APP_ROLES, homePathFor } from "@/lib/auth/roles";
import { JOB_SCHEDULE, SCHEDULED_JOBS } from "@/server/jobs/schedule";
import { parseCron } from "@/lib/domain/cron";

/**
 * Wave A integration: the sidebar, the command palette's Go to list and the "+ New" menu reach real
 * pages for every module built so far, and every scheduled job body is on the schedule.
 */

const ROOT = join(__dirname, "..", "..");

/** The staff routes wave A ships (docs/CONVENTIONS.md §2): home pages, people, clients, Client 360, compliance, work, settings. */
const WAVE_A_ROUTES = [
  "/dashboard",
  "/my-day",
  "/profile",
  "/clients",
  "/clients/new",
  "/clients/groups",
  "/work",
  "/filings",
  "/calendar",
  "/timesheet",
  "/people",
  "/performance",
  "/leave",
  "/templates/jobs",
  ...["firm", "bank", "numbering", "billing", "working-hours", "reminders", "law", "diagnostics"].map((s) => `/settings/${s}`),
];

function pageFile(path: string): string {
  return join(ROOT, "app", "(staff)", ...path.split("/").filter(Boolean), "page.tsx");
}

const pathOf = (href: string) => href.split(/[?#]/)[0];

describe("wave A navigation", () => {
  it("every wave A route has a page", () => {
    const missing = WAVE_A_ROUTES.filter((r) => !existsSync(pageFile(r)));
    expect(missing).toEqual([]);
  });

  it("every staff role lands on a real page after sign-in (§4.4), with its loading state", () => {
    for (const role of ["partner", "manager", "employee"] as const) {
      const home = homePathFor(role);
      expect(existsSync(pageFile(home)), `${role}: ${home}`).toBe(true);
      expect(existsSync(pageFile(home).replace(/page\.tsx$/, "loading.tsx")), `${role}: ${home} loading`).toBe(true);
    }
  });

  it("every sidebar and Go to link for a wave A route resolves, for every role", () => {
    for (const role of APP_ROLES) {
      const hrefs = [...getNav(role).flatMap((g) => g.items), ...getGoToItems(role)].map((i) => pathOf(i.href));
      for (const href of hrefs.filter((h) => WAVE_A_ROUTES.includes(h))) expect(existsSync(pageFile(href)), `${role}: ${href}`).toBe(true);
    }
  });

  it("the '+ New' items for clients, tasks and time land on pages that open their form", () => {
    const actions = getNewActions("partner");
    const byId = Object.fromEntries(actions.map((a) => [a.id, a.href]));
    expect(byId.client).toBe("/clients/new");
    expect(byId.task).toBe("/work?new=1");
    expect(byId.time).toBe("/timesheet?new=1");
    for (const id of ["client", "task", "time"] as const) expect(existsSync(pageFile(pathOf(byId[id]))), id).toBe(true);
    // The pages read the flag: NewTaskButton (new / apply_template) and TimesheetLogTime.
    expect(readFileSync(join(ROOT, "components", "tasks", "new-task-button.tsx"), "utf8")).toContain('openParam = "new"');
    expect(readFileSync(join(ROOT, "components", "timesheet", "log-time-button.tsx"), "utf8")).toContain('params.get("new") === "1"');
  });

  it("Employees get Log time but not New client or New task", () => {
    const ids = getNewActions("employee").map((a) => a.id);
    expect(ids).toEqual(["time"]);
  });
});

describe("scheduled jobs", () => {
  const scheduled = JOB_SCHEDULE.map((e) => e.job);

  it("every job has a schedule entry, and every entry names a job", () => {
    expect([...new Set(scheduled)].sort()).toEqual(Object.keys(SCHEDULED_JOBS).sort());
  });

  it("each entry is a five-field UTC cron expression the scheduler can read", () => {
    for (const e of JOB_SCHEDULE) {
      expect(e.cron.trim().split(/\s+/), e.job).toHaveLength(5);
      expect(() => parseCron(e.cron), e.job).not.toThrow();
    }
  });

  it("the daily times match §8 in IST (UTC + 5:30)", () => {
    const at = (job: string) => JOB_SCHEDULE.filter((e) => e.job === job).map((e) => e.cron);
    expect(at("workforce-sweep")).toEqual(["45 18 * * *"]); // 00:15 IST
    expect(at("escalation")).toEqual(["30 2 * * *"]); // 08:00 IST
    expect(at("compliance-top-up")).toEqual(["0 3 1 * *"]); // 08:30 IST on the 1st
    expect(at("reminders")).toEqual(["30 3 * * *"]); // 09:00 IST
    expect(at("absent-without-cover")).toEqual(["30 4 * * *", "0 5 * * *"]); // 10:00 and 10:30 IST
    expect(at("attendance")).toEqual(["0 6 * * *"]); // 11:30 IST
  });
});

import { describe, expect, it } from "vitest";
import {
  REPORT_META,
  REPORT_SLUGS,
  defaultReportPeriod,
  isReportSlug,
  parseReportFilters,
  reportQueryString,
  reportRpcParams,
} from "@/lib/schemas/reports";
import { formatHours, isLinkCell, isNumericKind, isStatusCell, reportCellText } from "@/components/reports/report-types";
import { fyPresets, reportPeriodPresets, yearPresets } from "@/components/reports/presets";

const CLIENT = "0b6f1c2e-6a3d-4c1b-9f0e-2d7a5b8c9e01";
const OWNER = "1c7a2d3f-7b4e-4d2c-8a1f-3e8b6c9d0f12";
const today = "2026-10-24";
const ctx = { selectedFy: "2026-27" as const, today };

describe("the report catalogue (§7.16)", () => {
  it("has the eight reports, each with the one line on what it counts", () => {
    expect(REPORT_SLUGS).toEqual(["compliance", "work", "clients", "revenue", "collections", "people", "pipeline", "practice"]);
    for (const s of REPORT_SLUGS) {
      expect(REPORT_META[s].counts.length).toBeGreaterThan(40);
      expect(REPORT_META[s].question.endsWith("?")).toBe(true);
    }
    expect(isReportSlug("revenue")).toBe(true);
    expect(isReportSlug("payroll")).toBe(false);
    expect(isReportSlug(undefined)).toBe(false);
  });

  it("marks the reports that show fees, invoices or quotations", () => {
    const money = REPORT_SLUGS.filter((s) => REPORT_META[s].money);
    expect(money).toEqual(["revenue", "collections", "pipeline"]);
  });

  it("keeps revenue and realisation per financial year", () => {
    expect(REPORT_META.revenue.period).toBe("fy");
    expect(REPORT_SLUGS.filter((s) => REPORT_META[s].period === "fy")).toEqual(["revenue"]);
  });
});

describe("defaultReportPeriod", () => {
  it("runs the current FY to today", () => {
    expect(defaultReportPeriod("2026-27", today)).toEqual({ from: "2026-04-01", to: today });
  });

  it("shows a past or future FY in full", () => {
    expect(defaultReportPeriod("2025-26", today)).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(defaultReportPeriod("2027-28", today)).toEqual({ from: "2027-04-01", to: "2028-03-31" });
  });
});

describe("parseReportFilters", () => {
  it("falls back to the selected FY when no period is given", () => {
    const f = parseReportFilters({}, "compliance", ctx);
    expect(f).toMatchObject({ from: "2026-04-01", to: today, defaultPeriod: true, fy: "2026-27", periodError: null, page: 1, pageSize: 25 });
  });

  it("takes a valid period and reads the FY from its end", () => {
    const f = parseReportFilters({ from: "2025-11-01", to: "2026-05-31" }, "work", ctx);
    expect(f).toMatchObject({ from: "2025-11-01", to: "2026-05-31", defaultPeriod: false, fy: "2026-27", periodError: null });
  });

  it("refuses a bad period in a sentence and shows the FY instead", () => {
    expect(parseReportFilters({ from: "2026-13-01", to: "2026-12-31" }, "work", ctx)).toMatchObject({
      from: "2026-04-01",
      to: today,
      defaultPeriod: true,
      periodError: expect.stringMatching(/isn't a pair of dates/),
    });
    expect(parseReportFilters({ from: "2026-06-01" }, "work", ctx).periodError).toMatch(/isn't a pair of dates/);
    expect(parseReportFilters({ from: "2026-06-30", to: "2026-06-01" }, "work", ctx).periodError).toMatch(/ends before it starts/);
    expect(parseReportFilters({ from: "2010-04-01", to: "2026-03-31" }, "work", ctx).periodError).toMatch(/at most ten years/);
  });

  it("shows a per-year report for the whole FY the period ends in", () => {
    const f = parseReportFilters({ from: "2025-06-01", to: "2025-09-30" }, "revenue", ctx);
    expect(f).toMatchObject({ from: "2025-04-01", to: "2026-03-31", fy: "2025-26", defaultPeriod: false });
    const d = parseReportFilters({}, "revenue", ctx);
    expect(d).toMatchObject({ from: "2026-04-01", to: "2027-03-31", fy: "2026-27", defaultPeriod: true });
  });

  it("keeps only the filters the report takes, and only well-formed ones", () => {
    const sp = { client: CLIENT, owner: OWNER, service: "gst", employee: OWNER };
    const clients = parseReportFilters(sp, "clients", ctx);
    expect(clients.clientId).toBeNull(); // the clients report has no client filter
    expect(clients.ownerId).toBe(OWNER);
    expect(clients.employeeId).toBeNull();
    expect(clients.service).toBe("gst");

    const people = parseReportFilters(sp, "people", ctx);
    expect(people.ownerId).toBeNull();
    expect(people.clientId).toBe(CLIENT);
    expect(people.employeeId).toBe(OWNER);
    expect(parseReportFilters(sp, "revenue", ctx)).toMatchObject({ clientId: CLIENT, service: "gst", ownerId: null, employeeId: null });

    const bad = parseReportFilters({ client: "not-a-uuid", owner: "1; drop table", service: "astrology" }, "compliance", ctx);
    expect(bad).toMatchObject({ clientId: null, ownerId: null, service: null });
  });

  it("reads the page and page size, within bounds", () => {
    expect(parseReportFilters({ page: "3", size: "50" }, "practice", ctx)).toMatchObject({ page: 3, pageSize: 50 });
    expect(parseReportFilters({ page: "-2", size: "7" }, "practice", ctx)).toMatchObject({ page: 1, pageSize: 25 });
    expect(parseReportFilters({ page: "99999999" }, "practice", ctx).page).toBe(100000);
  });
});

describe("reportRpcParams and reportQueryString", () => {
  it("passes every filter to the database function, with the page when given", () => {
    const f = parseReportFilters({ from: "2026-04-01", to: "2026-06-30", client: CLIENT }, "compliance", ctx);
    expect(reportRpcParams(f)).toEqual({ from: "2026-04-01", to: "2026-06-30", fy: "2026-27", client_id: CLIENT, owner_id: null, service: null, employee_id: null });
    expect(reportRpcParams(f, { offset: 25, limit: 25 })).toMatchObject({ offset: 25, limit: 25 });
  });

  it("writes the period only when one was chosen", () => {
    const d = parseReportFilters({ owner: OWNER }, "work", ctx);
    expect(reportQueryString(d)).toBe(`owner=${OWNER}`);
    const p = parseReportFilters({ from: "2026-04-01", to: "2026-06-30", client: CLIENT }, "work", ctx);
    expect(new URLSearchParams(reportQueryString(p)).get("from")).toBe("2026-04-01");
    expect(new URLSearchParams(reportQueryString(p)).get("client")).toBe(CLIENT);
  });
});

describe("report cells", () => {
  it("formats each kind the way the page, Excel and PDF show it", () => {
    expect(reportCellText("money", 1234567)).toBe("₹12,345.67");
    expect(reportCellText("count", 12345)).toBe("12,345");
    expect(reportCellText("percent", 12.25)).toMatch(/^12\.[23]%$/);
    expect(reportCellText("days", 1)).toBe("1 day");
    expect(reportCellText("days", 4.5)).toBe("4.5 days");
    expect(reportCellText("hours", 135)).toBe("2.3 h");
    expect(reportCellText("date", "2026-10-22")).toBe("22 Oct 2026");
    expect(reportCellText("text", "Sharma Traders")).toBe("Sharma Traders");
  });

  it("shows a dash for nothing, and the label of a status or link", () => {
    expect(reportCellText("money", null)).toBe("—");
    expect(reportCellText("count", undefined)).toBe("—");
    expect(reportCellText("text", "")).toBe("—");
    expect(reportCellText("status", { label: "Late", tone: "warning" })).toBe("Late");
    expect(reportCellText("link", { text: "TW-0042", href: "/clients/x" })).toBe("TW-0042");
    expect(isStatusCell({ label: "Late", tone: "warning" })).toBe(true);
    expect(isLinkCell({ text: "a", href: "/b" })).toBe(true);
    expect(isLinkCell("a")).toBe(false);
  });

  it("right-aligns the numeric kinds", () => {
    expect(["count", "money", "percent", "days", "hours", "date"].every((k) => isNumericKind(k as never))).toBe(true);
    expect(isNumericKind("text")).toBe(false);
    expect(isNumericKind("status")).toBe(false);
    expect(formatHours(0)).toBe("0 h");
  });
});

describe("period presets", () => {
  it("offers this FY to date, then earlier FYs in full", () => {
    const p = fyPresets(today, 2);
    expect(p.map((x) => [x.label, x.from, x.to])).toEqual([
      ["FY 2026-27 to date", "2026-04-01", today],
      ["FY 2025-26", "2025-04-01", "2026-03-31"],
      ["FY 2024-25", "2024-04-01", "2025-03-31"],
    ]);
  });

  it("offers whole FYs for a per-year report", () => {
    const p = yearPresets(today, 2);
    expect(p.map((x) => x.id)).toEqual(["fy-2026-27", "fy-2025-26", "fy-2024-25"]);
    expect(p[0]).toMatchObject({ from: "2026-04-01", to: "2027-03-31" });
  });

  it("has months, quarters and rolling windows, none ending after today", () => {
    const p = reportPeriodPresets(today);
    const byId = Object.fromEntries(p.map((x) => [x.id, x]));
    expect(byId["this-month"]).toMatchObject({ from: "2026-10-01", to: today });
    expect(byId["last-month"]).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(byId["this-quarter"]).toMatchObject({ from: "2026-10-01", to: today, label: "This quarter (Q3 2026-27)" });
    expect(byId["last-quarter"]).toMatchObject({ from: "2026-07-01", to: "2026-09-30", label: "Last quarter (Q2 2026-27)" });
    expect(byId["last-30"]).toMatchObject({ from: "2026-09-25", to: today });
    expect(byId["last-90"]).toMatchObject({ from: "2026-07-27", to: today });
    expect(p.every((x) => x.to <= today)).toBe(true);
    expect(new Set(p.map((x) => x.id)).size).toBe(p.length);
  });

  it("takes last quarter from the previous FY in April to June", () => {
    const byId = Object.fromEntries(reportPeriodPresets("2026-05-10").map((x) => [x.id, x]));
    expect(byId["last-quarter"]).toMatchObject({ from: "2026-01-01", to: "2026-03-31", label: "Last quarter (Q4 2025-26)" });
    expect(byId["last-month"]).toMatchObject({ from: "2026-04-01", to: "2026-04-30" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => {
    throw new Error("no service role in unit tests");
  },
}));
vi.mock("@/server/notify", () => ({ notify: vi.fn(async () => undefined) }));

import { notify } from "@/server/notify";
import { capacityLine, namesLine, run as runTeamHealth, weekKey } from "@/server/jobs/team-health";
import { accessReviewBody, calendarQuarterKey, inAccessReviewWindow, run as runAccessReview } from "@/server/jobs/access-review";
import { firstNumberOf, inNewFyWindow, run as runNewFy } from "@/server/jobs/new-fy";

/**
 * The team jobs (§8): team health (Mondays), access review (quarterly) and the new FY (1 April),
 * against a recording stand-in for the service-role client: who is told what, with which dedupe
 * key, and that one failing part doesn't stop the others.
 */

type Call = { op: string; args: unknown[] };
type Answer = { data?: unknown; error?: unknown; count?: number | null };

function fakeAdmin(answer: (table: string, calls: Call[]) => Answer) {
  const from = (table: string) => {
    const calls: Call[] = [];
    const q: Record<string, unknown> = {};
    const chain = (name: string) =>
      (...args: unknown[]) => {
        calls.push({ op: name, args });
        return q;
      };
    for (const m of ["select", "eq", "neq", "is", "not", "in", "lt", "lte", "gt", "gte", "order", "range", "limit", "update", "insert"]) q[m] = chain(m);
    const settle = () => {
      const a = answer(table, calls);
      return { data: a.data ?? null, error: a.error ?? null, count: a.count ?? null };
    };
    q.maybeSingle = async () => settle();
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(settle).then(resolve, reject);
    return q;
  };
  return { from, rpc: async () => ({ data: null, error: null }) } as never;
}

const has = (calls: Call[], op: string, ...args: unknown[]) => calls.some((c) => c.op === op && JSON.stringify(c.args.slice(0, args.length)) === JSON.stringify(args));

beforeEach(() => {
  vi.mocked(notify).mockClear();
});

describe("helpers", () => {
  it("keys a week by its Monday (IST)", () => {
    expect(weekKey("2026-10-26")).toBe("2026-10-26");
    expect(weekKey("2026-10-23")).toBe("2026-10-19");
    expect(weekKey("2026-11-01")).toBe("2026-10-26");
  });

  it("lists people and names without a dangling separator", () => {
    expect(capacityLine([{ name: "Ravi", band: "over", perDay: "5.2" }])).toBe("Ravi OVER (5.2 a day)");
    expect(capacityLine([{ name: "Ravi", band: "over", perDay: "5.2" }, { name: "Anita", band: "tight", perDay: "2.8" }])).toBe("Ravi OVER (5.2 a day) and Anita TIGHT (2.8 a day)");
    expect(namesLine(["A", "B", "C", "D"], 3)).toBe("A, B, C and 1 more");
    expect(namesLine(["A", "B"], 3, 9)).toBe("A, B and 7 more");
    expect(namesLine(["A", "B"])).toBe("A and B");
  });

  it("knows the quarter and its window", () => {
    expect(calendarQuarterKey("2026-10-01")).toBe("2026-Q4");
    expect(calendarQuarterKey("2027-03-31")).toBe("2027-Q1");
    expect(inAccessReviewWindow("2026-10-01")).toBe(true);
    expect(inAccessReviewWindow("2026-10-15")).toBe(true);
    expect(inAccessReviewWindow("2026-10-16")).toBe(false);
    expect(inAccessReviewWindow("2026-11-01")).toBe(false);
  });

  it("knows the new FY's window and first numbers", () => {
    expect(inNewFyWindow("2027-04-01")).toBe(true);
    expect(inNewFyWindow("2027-04-30")).toBe(true);
    expect(inNewFyWindow("2027-05-01")).toBe(false);
    expect(firstNumberOf("TW", "2027-28")).toBe("TW/27-28/0001");
  });

  it("says who holds what in the access review", () => {
    expect(accessReviewBody({ partners: 2, managers: 1, employees: 9, vault: 1, vaultCovers: 0 })).toBe(
      "2 Partners, 1 Manager and 9 Employees have access. 1 Employee can reveal stored portal passwords (vault access). Check each role and each vault grant is still right, and take away what isn't needed.",
    );
  });
});

describe("team health, Mondays 08:30 IST", () => {
  const NOW = new Date("2026-10-26T03:00:00Z"); // Mon 26 Oct, 08:30 IST

  function answers(overrides: Partial<Record<string, Answer | ((calls: Call[]) => Answer)>> = {}) {
    return (table: string, calls: Call[]): Answer => {
      const o = overrides[table];
      if (o) return typeof o === "function" ? o(calls) : o;
      switch (table) {
        case "employees":
          return { data: [{ id: "e1", full_name: "Ravi Kumar", profiles: { is_active: true, role: "employee" } }, { id: "e2", full_name: "Anita Rao", profiles: { is_active: true, role: "employee" } }] };
        case "firm_settings":
          return { data: { working_weekdays: [1, 2, 3, 4, 5, 6], capacity_thresholds: { busy: 1.5, tight: 2.5, over: 4 } } };
        case "tasks":
          if (has(calls, "is", "assigned_employee_id", null)) return { data: [{ id: "t9", title: "TDS return Q2", due_date: "2026-10-31", clients: { display_name: "Beta Industries" } }], count: 3 };
          return { data: Array.from({ length: 60 }, () => ({ assigned_employee_id: "e1" })).concat([{ assigned_employee_id: "e2" }]) };
        case "leads":
          return { data: [{ id: "l1", name: "Asha", company: "Asha Foods" }], count: 1 };
        case "client_services":
          return { data: [{ client_id: "c1", clients: { display_name: "Sharma Traders", status: "active", deleted_at: null } }, { client_id: "c2", clients: { display_name: "Gamma LLP", status: "active", deleted_at: null } }] };
        case "engagement_letters":
          return { data: [{ client_id: "c2" }] };
        default:
          return { data: [] };
      }
    };
  }

  it("tells Managers who is over capacity, Partners and Managers about stale leads and missing letters, Managers about unassigned work", async () => {
    const r = await runTeamHealth(fakeAdmin(answers()), NOW);
    expect(r.counts).toMatchObject({ people_checked: 2, over_capacity: 1, stale_leads: 1, unassigned_tasks: 3, clients_without_letter: 1, notified: 4, failed: 0 });
    const calls = vi.mocked(notify).mock.calls.map((c) => c[0]);
    const capacity = calls.find((c) => c.dedupeKey === "team_health:capacity:2026-10-26");
    expect(capacity).toMatchObject({ to: { roles: ["manager"] }, type: "warning", linkUrl: "/people" });
    expect(capacity?.body).toContain("Ravi Kumar OVER");
    expect(calls.find((c) => c.dedupeKey === "team_health:stale_leads:2026-10-26")).toMatchObject({ to: { roles: ["partner", "manager"] }, linkUrl: "/leads?flag=stale" });
    expect(calls.find((c) => c.dedupeKey === "team_health:unassigned:2026-10-26")?.body).toContain("TDS return Q2 for Beta Industries, due 31 Oct 2026");
    const letters = calls.find((c) => c.dedupeKey === "team_health:engagement_letters:2026-27:2026-10-26");
    expect(letters).toMatchObject({ to: { roles: ["partner", "manager"] }, title: "1 client has no engagement letter for FY 2026-27" });
    expect(letters?.body).toContain("Sharma Traders");
  });

  it("says nothing when the team is fine, and keeps going when one part fails", async () => {
    const quiet = answers({
      tasks: (calls) => (has(calls, "is", "assigned_employee_id", null) ? { data: [], count: 0 } : { data: [] }),
      leads: { data: [], count: 0 },
      engagement_letters: { data: [{ client_id: "c1" }, { client_id: "c2" }] },
      employees: { error: new Error("boom") },
    });
    const r = await runTeamHealth(fakeAdmin(quiet), NOW);
    expect(r.counts).toMatchObject({ notified: 0, failed: 1, stale_leads: 0, unassigned_tasks: 0, clients_without_letter: 0 });
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });
});

describe("access review, quarterly", () => {
  const answers = (table: string): Answer => {
    switch (table) {
      case "profiles":
        return { data: [{ id: "p1", role: "partner", is_active: true }, { id: "m1", role: "manager", is_active: true }, { id: "e1", role: "employee", is_active: true }, { id: "e9", role: "employee", is_active: false }] };
      case "employees":
        return { data: [{ id: "x1", profile_id: "e1", is_active: true, deleted_at: null, vault_access: true }, { id: "x9", profile_id: "e9", is_active: false, deleted_at: null, vault_access: true }] };
      case "client_covers":
        return { data: null, count: 2 };
      default:
        return { data: [] };
    }
  };

  it("reminds every Partner once a quarter, in the first fortnight", async () => {
    const r = await runAccessReview(fakeAdmin(answers), new Date("2026-10-01T03:00:00Z"));
    expect(r.counts).toMatchObject({ out_of_window: 0, partners_told: 1, failed: 0 });
    const n = vi.mocked(notify).mock.calls[0][0];
    expect(n).toMatchObject({ to: { roles: ["partner"] }, dedupeKey: "access_review:2026-Q4", linkUrl: "/people" });
    expect(n.body).toContain("1 Partner, 1 Manager and 1 Employee have access.");
    expect(n.body).toContain("1 Employee can reveal stored portal passwords");
    expect(n.body).toContain("2 covers in force include portal passwords.");
  });

  it("does nothing outside the window", async () => {
    const r = await runAccessReview(fakeAdmin(answers), new Date("2026-10-23T03:00:00Z"));
    expect(r.counts.out_of_window).toBe(1);
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });
});

describe("new FY, 1 April", () => {
  const NOW = new Date("2027-04-01T03:00:00Z");
  const answers = (table: string, calls: Call[]): Answer => {
    switch (table) {
      case "number_series":
        return { data: [{ key: "invoice", financial_year: "2026-27", next_value: 120 }, { key: "receipt", financial_year: "2027-28", next_value: 2 }] };
      case "firm_settings":
        return { data: { invoice_prefix: "TW", credit_note_prefix: "TW-CN", quotation_prefix: "TW-Q", receipt_prefix: "TW-R" } };
      case "client_services":
        return { data: [{ client_id: "c1", clients: { display_name: "Sharma Traders" } }, { client_id: "c2", clients: { display_name: "Gamma LLP" } }] };
      case "engagement_letters":
        return has(calls, "eq", "financial_year", "2026-27") ? { data: [{ client_id: "c1" }, { client_id: "c2" }] } : { data: [{ client_id: "c2" }] };
      case "employees":
        return { data: [{ id: "x1", profiles: { is_active: true, role: "employee" } }, { id: "x2", profiles: { is_active: true, role: "partner" } }] };
      case "independence_declarations":
        return { data: [{ employee_id: "x2" }] };
      case "statutory_parameters":
        return { data: null, count: 4 };
      default:
        return { data: [] };
    }
  };

  it("tells Partners which series restart, who to renew, who hasn't declared, and to review the law", async () => {
    const r = await runNewFy(fakeAdmin(answers), NOW);
    expect(r.counts).toMatchObject({ out_of_window: 0, series_restarting: 3, letters_to_renew: 1, declarations_due: 1, parameters_unverified: 4, notified: 4, failed: 0 });
    const byKey = new Map(vi.mocked(notify).mock.calls.map((c) => [c[0].dedupeKey, c[0]]));
    expect(byKey.get("new_fy:2027-28:numbering")?.body).toContain("Invoices TW/27-28/0001, Credit notes TW-CN/27-28/0001, Quotations TW-Q/27-28/0001");
    expect(byKey.get("new_fy:2027-28:numbering")?.body).not.toContain("Receipts");
    expect(byKey.get("new_fy:2027-28:engagement_letters")).toMatchObject({ to: { roles: ["partner", "manager"] }, title: "1 engagement letter to renew for FY 2027-28" });
    expect(byKey.get("new_fy:2027-28:independence")?.body).toBe("1 of 2 staff haven't made their annual independence declaration for FY 2027-28 yet. Collect them before attest work for the year begins.");
    expect(byKey.get("new_fy:2027-28:law_review")?.body).toContain("4 are still marked unverified");
  });

  it("does nothing outside April", async () => {
    const r = await runNewFy(fakeAdmin(answers), new Date("2026-10-23T03:00:00Z"));
    expect(r.counts.out_of_window).toBe(1);
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });
});

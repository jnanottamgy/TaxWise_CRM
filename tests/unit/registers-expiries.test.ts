import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => {
    throw new Error("no service role in unit tests");
  },
}));
vi.mock("@/server/notify", () => ({ notify: vi.fn(async () => undefined) }));

import { notify } from "@/server/notify";
import { custodyPhrase, daysText, dscAlertKey, letterExpiryKey, registrationAlertKey, run, udinAlertKey, udinAlertStage } from "@/server/jobs/register-expiries";

/**
 * The register-expiries job (§8 09:00 reminders: DSC, registration and engagement-letter expiries;
 * UDIN 60-day warnings; §9): its pure rules, and a run against a stand-in for the service-role
 * client: who is told, with which dedupe key, and what is skipped.
 */

type Call = { op: string; args: unknown[] };

function fakeAdmin(tables: Record<string, unknown[]>) {
  const queries: Array<{ table: string; calls: Call[] }> = [];
  const from = (table: string) => {
    const entry = { table, calls: [] as Call[] };
    queries.push(entry);
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "not", "in", "lt", "lte", "gt", "gte", "order", "range", "limit"]) {
      q[m] = (...args: unknown[]) => {
        entry.calls.push({ op: m, args });
        return q;
      };
    }
    const answer = () => {
      let rows = [...(tables[table] ?? [])] as Array<Record<string, unknown>>;
      for (const c of entry.calls) if (c.op === "in") rows = rows.filter((r) => (c.args[1] as unknown[]).includes(r[c.args[0] as string]));
      return { data: rows, error: null };
    };
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject);
    return q;
  };
  return { admin: { from } as never, queries };
}

const NOW = new Date("2026-10-24T03:30:00Z"); // 09:00 IST on 24 Oct 2026

beforeEach(() => vi.mocked(notify).mockClear());

describe("the pure rules", () => {
  it("names each alert by record, date and threshold, so a re-run never repeats it", () => {
    expect(dscAlertKey("d1", "2026-11-10", 30)).toBe("dsc_expiry:d1:2026-11-10:30");
    expect(registrationAlertKey("r1", "2026-12-31")).toBe("registration_expiry:r1:2026-12-31");
    expect(letterExpiryKey("l1", "2027-03-31")).toBe("engagement_letter_expiry:l1:2027-03-31");
    expect(udinAlertKey("a1", "2026-09-01", "left:7")).toBe("udin_missing:a1:2026-09-01:left:7");
  });

  it("warns about a missing UDIN at 30, 15, 7 and 3 days left and on the last day, then weekly while late", () => {
    expect(udinAlertStage(45)).toBeNull();
    expect(udinAlertStage(30)).toEqual({ key: "left:30", late: false });
    expect(udinAlertStage(20)).toEqual({ key: "left:30", late: false });
    expect(udinAlertStage(15)).toEqual({ key: "left:15", late: false });
    expect(udinAlertStage(6)).toEqual({ key: "left:7", late: false });
    expect(udinAlertStage(3)).toEqual({ key: "left:3", late: false });
    expect(udinAlertStage(0)).toEqual({ key: "left:0", late: false });
    expect(udinAlertStage(-1)).toEqual({ key: "late:0", late: true });
    expect(udinAlertStage(-7)).toEqual({ key: "late:0", late: true });
    expect(udinAlertStage(-8)).toEqual({ key: "late:1", late: true });
  });

  it("says who holds the token", () => {
    expect(custodyPhrase("Firm")).toBe("; the token is with the firm");
    expect(custodyPhrase("client")).toBe("; the token is with the client");
    expect(custodyPhrase("Asha Rao")).toBe("; the token is with Asha Rao");
    expect(custodyPhrase(null)).toBe("");
  });

  it("says when in words", () => {
    expect(daysText(0)).toBe("today");
    expect(daysText(1)).toBe("tomorrow");
    expect(daysText(15)).toBe("in 15 days");
  });
});

describe("a run (§8, §9)", () => {
  const clients = [
    { id: "c1", display_name: "Sharma Traders", owner_employee_id: "e-emp", deleted_at: null },
    { id: "c2", display_name: "Binned Pvt Ltd", owner_employee_id: "e-emp", deleted_at: "2026-10-01T00:00:00Z" },
    { id: "c3", display_name: "Rao & Co LLP", owner_employee_id: "e-mgr", deleted_at: null },
  ];
  const employees = [
    { id: "e-emp", profile_id: "p-emp" },
    { id: "e-mgr", profile_id: "p-mgr" },
    { id: "e-partner", profile_id: "p-partner" },
  ];
  const profiles = [
    { id: "p-emp", role: "employee", is_active: true },
    { id: "p-mgr", role: "manager", is_active: true },
    { id: "p-partner", role: "partner", is_active: true },
  ];

  it("sends each DSC alert at its threshold to the owner and Partners, skipping clients in the recycle bin", async () => {
    const { admin } = fakeAdmin({
      dsc_records: [
        { id: "d1", client_id: "c1", holder_name: "Ravi Sharma", expiry_date: "2026-11-05", custody: "Firm" }, // 12 days → 15
        { id: "d2", client_id: "c2", holder_name: "Old Director", expiry_date: "2026-10-30", custody: null },
      ],
      clients,
    });
    const r = await run(admin, NOW);
    expect(r.counts.dsc_alerts).toBe(1);
    const n = vi.mocked(notify).mock.calls.map((c) => c[0]).find((x) => x.dedupeKey?.startsWith("dsc_expiry"));
    expect(n?.dedupeKey).toBe("dsc_expiry:d1:2026-11-05:15");
    expect(n?.to).toEqual({ roles: ["partner"], employeeIds: ["e-emp"] });
    expect(n?.linkUrl).toBe("/registers?tab=dsc&client=c1");
    expect(n?.title).toBe("DSC of Ravi Sharma expires in 12 days");
  });

  it("reminds a registration once its own window opens, and not before", async () => {
    const { admin } = fakeAdmin({
      statutory_registrations: [
        { id: "r1", client_id: "c1", registration_type: "FSSAI", registration_number: "11223344556677", expiry_date: "2026-11-20", reminder_days: 30, status: "active" },
        { id: "r2", client_id: "c1", registration_type: "PT", registration_number: "PT-123", expiry_date: "2026-12-31", reminder_days: 30, status: "active" },
      ],
      clients,
    });
    const r = await run(admin, NOW);
    expect(r.counts.registration_alerts).toBe(1);
    const n = vi.mocked(notify).mock.calls.map((c) => c[0]).find((x) => x.dedupeKey?.startsWith("registration_expiry"));
    expect(n?.dedupeKey).toBe("registration_expiry:r1:2026-11-20");
    expect(n?.title).toBe("FSSAI registration expires in 27 days");
  });

  it("tells the Partners about an expiring letter, and the owner only when they are a Partner or Manager (§4.1)", async () => {
    const { admin } = fakeAdmin({
      engagement_letters_register: [
        { id: "l1", client_id: "c1", client_name: "Sharma Traders", owner_employee_id: "e-emp", financial_year: "2026-27", status: "signed", expires_at: "2026-11-15", renewal_id: null },
        { id: "l2", client_id: "c3", client_name: "Rao & Co LLP", owner_employee_id: "e-mgr", financial_year: "2026-27", status: "issued", expires_at: "2026-11-01", renewal_id: null },
      ],
      employees,
      profiles,
    });
    const r = await run(admin, NOW);
    expect(r.counts.letter_alerts).toBe(2);
    const sent = vi.mocked(notify).mock.calls.map((c) => c[0]).filter((x) => x.dedupeKey?.startsWith("engagement_letter_expiry"));
    const employeeOwned = sent.find((x) => x.entity?.id === "l1");
    const managerOwned = sent.find((x) => x.entity?.id === "l2");
    expect(employeeOwned?.to).toEqual({ roles: ["partner"], employeeIds: [] });
    expect(managerOwned?.to).toEqual({ roles: ["partner"], employeeIds: ["e-mgr"] });
    expect(managerOwned?.body).toContain("never signed");
    expect(employeeOwned?.linkUrl).toBe("/engagement-letters/l1");
  });

  it("warns the signing partner about a signed report without a UDIN, by days left", async () => {
    const { admin } = fakeAdmin({
      audit_engagements: [
        { id: "a1", client_id: "c3", audit_type: "tax_audit", financial_year: "2025-26", report_date: "2026-08-30", engagement_partner_id: "e-partner" }, // 55 days → 5 left
        { id: "a2", client_id: "c1", audit_type: "statutory_companies_act", financial_year: "2025-26", report_date: "2026-10-20", engagement_partner_id: "e-partner" }, // 56 left: nothing
      ],
      statutory_parameters: [],
      clients,
      employees,
    });
    const r = await run(admin, NOW);
    expect(r.counts.udin_alerts).toBe(1);
    const n = vi.mocked(notify).mock.calls.map((c) => c[0]).find((x) => x.dedupeKey?.startsWith("udin_missing"));
    expect(n?.to).toEqual({ userIds: ["p-partner"] });
    expect(n?.dedupeKey).toBe("udin_missing:a1:2026-08-30:left:7");
    expect(n?.title).toBe("UDIN due in 5 days: tax audit report of Rao & Co LLP");
    expect(r.counts.failed).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => {
    throw new Error("no service role in unit tests");
  },
}));
vi.mock("@/server/notify", () => ({ notify: vi.fn(async () => undefined) }));

import { notify } from "@/server/notify";
import { run } from "@/server/jobs/practice-reminders";

/**
 * Practice reminders (§8, §6.8, §6.9, §6.10, §12) against a recording stand-in for the service-role
 * client: the peer review warning, SA 230 assembly dates, KYC re-confirmation, DPDP due dates, the
 * Board's breach report and the quarterly restore drill; each notice deduped by record and date,
 * and one failing part not stopping the rest.
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
    for (const m of ["select", "eq", "neq", "is", "not", "in", "lt", "lte", "gt", "gte", "order", "range", "limit"]) q[m] = chain(m);
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

const selected = (calls: Call[]) => String(calls.find((c) => c.op === "select")?.args[0] ?? "");
const keys = () => vi.mocked(notify).mock.calls.map((c) => c[0].dedupeKey)

// 5 Oct 2026, 09:10 IST: the first days of Q4.
const NOW = new Date("2026-10-05T03:40:00Z");

function world(over: Partial<Record<string, Answer | ((calls: Call[]) => Answer)>> = {}) {
  const base: Record<string, Answer | ((calls: Call[]) => Answer)> = {
    statutory_parameters: { data: [] },
    peer_reviews: { data: { id: "pr1", certificate_no: "PRB/2023/77", valid_until: "2026-12-01", reviewer_name: "CA Meera Iyer" } },
    audit_engagements: (calls) =>
      selected(calls).includes("file_assembly_due")
        ? {
            data: [
              { id: "a1", client_id: "c1", audit_type: "tax_audit", financial_year: "2025-26", report_date: "2026-08-10", file_assembly_due: "2026-10-09", engagement_partner_id: "e1", review_manager_id: "e2", clients: { display_name: "Sharma Traders", deleted_at: null } },
              { id: "a2", client_id: "c2", audit_type: "statutory_companies_act", financial_year: "2025-26", report_date: "2026-07-20", file_assembly_due: "2026-09-18", engagement_partner_id: "e1", review_manager_id: null, clients: { display_name: "Rao Steels", deleted_at: null } },
              { id: "a3", client_id: "c3", audit_type: "tax_audit", financial_year: "2025-26", report_date: "2026-08-10", file_assembly_due: "2026-10-09", engagement_partner_id: "e1", review_manager_id: null, clients: { display_name: "Gone Ltd", deleted_at: "2026-09-01T00:00:00Z" } },
            ],
          }
        : { data: [{ client_id: "c1", engagement_partner_id: "e1", review_manager_id: "e2" }] },
    kyc_register: {
      data: [
        { client_id: "c1", client_name: "Sharma Traders", owner_employee_id: "e9", kyc_id: "k1", verified_on: "2025-10-20", next_review_on: null, complete: true },
        { client_id: "c4", client_name: "Iyer & Co", owner_employee_id: "e9", kyc_id: "k4", verified_on: "2025-09-01", next_review_on: null, complete: true },
        { client_id: "c5", client_name: "Later Ltd", owner_employee_id: null, kyc_id: "k5", verified_on: "2026-06-01", next_review_on: null, complete: true },
      ],
    },
    data_requests: {
      data: [
        { id: "r1", type: "erasure", status: "open", due_by: "2026-10-01", handled_by: "p2" },
        { id: "r2", type: "access", status: "in_progress", due_by: "2026-10-09", handled_by: null },
        { id: "r3", type: "access", status: "completed", due_by: "2026-10-02", handled_by: null },
      ],
    },
    data_incidents: { data: [{ id: "i1", title: "Laptop stolen", detected_at: "2026-10-01T05:00:00Z", contained_at: null, assessed_at: null, board_notified_at: null, principals_notified_at: null, root_cause: null, closed_at: null }] },
    restore_drills: { data: { performed_on: "2026-08-20" } },
  };
  const merged = { ...base, ...over };
  return fakeAdmin((table, calls) => {
    const a = merged[table];
    if (!a) return { data: [] };
    return typeof a === "function" ? a(calls) : a;
  });
}

beforeEach(() => {
  vi.mocked(notify).mockClear();
});

describe("practice reminders", () => {
  it("sends each reminder once per record and date", async () => {
    const { counts } = await run(world(), NOW);
    expect(counts).toEqual({ peer_review: 1, assembly_due: 1, assembly_overdue: 1, kyc_due_soon: 1, kyc_due: 1, requests_due_soon: 1, requests_overdue: 1, incidents_board: 1, restore_drill: 1, failed: 0 });
    expect(keys()).toEqual(
      expect.arrayContaining([
        "peer_review_expiring:pr1:2026-12-01",
        "audit_assembly_due_soon:a1:2026-10-09",
        "audit_assembly_overdue:a2:2026-09-18",
        "kyc_review_due_soon:c1:2026-10-20",
        "kyc_review_due:c4:2026-09-01",
        "data_request_overdue:r1:2026-10-01",
        "data_request_due_soon:r2:2026-10-09",
        "data_incident_board_late:i1",
        "restore_drill_start:2026-Q4",
      ]),
    );
  });

  it("tells the right people", async () => {
    await run(world(), NOW);
    const sent = vi.mocked(notify).mock.calls.map((c) => c[0]);
    expect(sent.find((n) => n.dedupeKey?.startsWith("audit_assembly_due_soon"))?.to).toEqual({ employeeIds: ["e1", "e2"] });
    expect(sent.find((n) => n.dedupeKey === "kyc_review_due_soon:c1:2026-10-20")?.to).toEqual({ employeeIds: ["e1", "e2"] });
    expect(sent.find((n) => n.dedupeKey === "kyc_review_due:c4:2026-09-01")?.to).toEqual({ employeeIds: ["e9"] });
    expect(sent.find((n) => n.dedupeKey?.startsWith("data_request_overdue"))?.to).toEqual({ roles: ["partner"], userIds: ["p2"] });
    expect(sent.find((n) => n.dedupeKey?.startsWith("data_incident_board"))?.type).toBe("security_alert");
    for (const n of sent) expect(JSON.stringify(n)).not.toMatch(/fee|₹/i);
  });

  it("stays quiet when nothing is due", async () => {
    const { counts } = await run(
      world({
        peer_reviews: { data: { id: "pr1", certificate_no: "PRB/2026/1", valid_until: "2029-06-01" } },
        audit_engagements: (calls) => (selected(calls).includes("file_assembly_due") ? { data: [] } : { data: [] }),
        kyc_register: { data: [] },
        data_requests: { data: [] },
        data_incidents: { data: [] },
        restore_drills: { data: { performed_on: "2026-10-02" } },
      }),
      NOW,
    );
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("carries on past a part that fails", async () => {
    const { counts } = await run(world({ kyc_register: { error: new Error("timeout") } }), NOW);
    expect(counts.failed).toBe(1);
    expect(counts.kyc_due + counts.kyc_due_soon).toBe(0);
    expect(counts.peer_review).toBe(1);
    expect(counts.restore_drill).toBe(1);
  });
});

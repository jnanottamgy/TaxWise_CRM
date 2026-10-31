import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => {
    throw new Error("no service role in unit tests");
  },
}));
vi.mock("@/server/notify", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/log", () => ({ log: vi.fn(), logUnexpected: vi.fn(() => "REF") }));

import { notify } from "@/server/notify";
import { run } from "@/server/jobs/whatsapp-housekeeping";

/**
 * WhatsApp housekeeping (§8 Mon 08:45): the review reminder to each office number's custodian (the
 * Partners when there is none), and clients onboarded 2+ days ago with no Active group to their
 * engagement partner; weekly dedupe keys; one failed notice doesn't stop the others.
 */

type Answer = { data?: unknown; error?: unknown };

function fakeAdmin(answer: (table: string, ops: string[]) => Answer) {
  const from = (table: string) => {
    const ops: string[] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "not", "in", "lt", "lte", "gt", "gte", "order", "range", "limit"]) {
      q[m] = (...args: unknown[]) => {
        ops.push(`${m}:${JSON.stringify(args[0] ?? null)}`);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => {
          const a = answer(table, ops);
          return { data: a.data ?? [], error: a.error ?? null };
        })
        .then(resolve, reject);
    return q;
  };
  return { from } as never;
}

const NOW = new Date("2026-10-26T03:15:00Z"); // Monday 08:45 IST
const E_CUSTODIAN = "e0000000-0000-4000-8000-000000000001";
const E_PARTNER = "e0000000-0000-4000-8000-000000000002";
const E_OWNER = "e0000000-0000-4000-8000-000000000003";

function world(over: Partial<Record<string, Answer>> = {}) {
  const base: Record<string, Answer> = {
    firm_whatsapp_numbers: {
      data: [
        { id: "num-staff", label: "Staff office", kind: "staff_office", shared: true, is_active: true, custodian_employee_id: E_CUSTODIAN, devices_reviewed_at: null },
        { id: "num-mgr", label: "Managers' office", kind: "managers_office", shared: true, is_active: true, custodian_employee_id: null, devices_reviewed_at: "2026-10-19T05:00:00Z" },
        { id: "num-p1", label: "CA Vinay H Karlagere (Partner)", kind: "partner", shared: false, is_active: true, custodian_employee_id: null, devices_reviewed_at: null },
      ],
    },
    employees: { data: [{ id: E_CUSTODIAN, is_active: true, deleted_at: null }] },
    client_whatsapp_groups: { data: [{ client_id: "c-has-group" }] },
    clients: {
      data: [
        { id: "c-has-group", display_name: "Alpha Traders", onboarded_at: "2026-10-01T05:00:00Z", owner_employee_id: E_OWNER },
        { id: "c-ep", display_name: "XYZ Traders", onboarded_at: "2026-10-20T05:00:00Z", owner_employee_id: E_OWNER },
        { id: "c-owner", display_name: "Beta Industries", onboarded_at: "2026-10-22T05:00:00Z", owner_employee_id: E_OWNER },
        { id: "c-nobody", display_name: "Gamma LLP", onboarded_at: "2026-10-23T05:00:00Z", owner_employee_id: null },
        { id: "c-too-new", display_name: "Delta Foods", onboarded_at: "2026-10-25T05:00:00Z", owner_employee_id: E_OWNER },
      ],
    },
    client_team_members: { data: [{ client_id: "c-ep", employee_id: E_PARTNER }] },
  };
  const all = { ...base, ...over };
  return fakeAdmin((table) => all[table] ?? { data: [] });
}

beforeEach(() => {
  vi.mocked(notify).mockClear();
});

describe("WhatsApp housekeeping (§8)", () => {
  it("reminds custodians, reports numbers without one, and flags missing groups", async () => {
    const { counts } = await run(world(), NOW);
    expect(counts).toEqual({ review_reminders: 1, no_custodian: 1, groups_missing: 3, failed: 0 });
    const calls = vi.mocked(notify).mock.calls.map((c) => c[0]);
    const byKey = new Map(calls.map((c) => [c.dedupeKey, c]));

    const review = byKey.get("whatsapp_devices_review:num-staff:2026-W44")!;
    expect(review.to).toEqual({ employeeIds: [E_CUSTODIAN] });
    expect(review.title).toBe("Check the Staff office phone's linked devices");
    expect(review.linkUrl).toBe("/settings/whatsapp#numbers");
    expect(review.body).toContain("WhatsApp → Settings → Linked devices");
    expect(review.body).not.toContain("Linked PCs");

    const noCustodian = byKey.get("whatsapp_no_custodian:num-mgr:2026-W44")!;
    expect(noCustodian.to).toEqual({ roles: ["partner"] });
    // a Partner's own number isn't an office number: no reminder for it
    expect([...byKey.keys()].some((k) => k?.includes("num-p1"))).toBe(false);

    expect(byKey.get("whatsapp_group_missing:c-ep:2026-W44")).toMatchObject({
      to: { employeeIds: [E_PARTNER] },
      type: "whatsapp_group_missing",
      title: "XYZ Traders has no WhatsApp group yet",
      linkUrl: "/clients/c-ep?tab=whatsapp",
      clientId: "c-ep",
    });
    expect(byKey.get("whatsapp_group_missing:c-owner:2026-W44")?.to).toEqual({ employeeIds: [E_OWNER] });
    expect(byKey.get("whatsapp_group_missing:c-nobody:2026-W44")?.to).toEqual({ roles: ["partner"] });
    expect(byKey.has("whatsapp_group_missing:c-has-group:2026-W44")).toBe(false);
    expect(byKey.has("whatsapp_group_missing:c-too-new:2026-W44")).toBe(false);
  });

  it("treats a disabled custodian as none", async () => {
    await run(world({ employees: { data: [{ id: E_CUSTODIAN, is_active: false, deleted_at: null }] } }), NOW);
    const keys = vi.mocked(notify).mock.calls.map((c) => c[0].dedupeKey);
    expect(keys).toContain("whatsapp_no_custodian:num-staff:2026-W44");
    expect(keys).not.toContain("whatsapp_devices_review:num-staff:2026-W44");
  });

  it("keeps going when one notice fails, and counts it", async () => {
    vi.mocked(notify).mockRejectedValueOnce(new Error("down"));
    const { counts } = await run(world(), NOW);
    expect(counts).toEqual({ review_reminders: 0, no_custodian: 1, groups_missing: 3, failed: 1 });
  });

  it("sends nothing when everything is in order", async () => {
    const { counts } = await run(
      world({
        firm_whatsapp_numbers: { data: [] },
        clients: { data: [] },
      }),
      NOW,
    );
    expect(counts).toEqual({ review_reminders: 0, no_custodian: 0, groups_missing: 0, failed: 0 });
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });
});

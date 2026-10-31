import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => {
    throw new Error("no service role in unit tests");
  },
}));
vi.mock("@/server/notify", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/server/firm", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/firm")>();
  return { ...real, getFirmProfile: vi.fn(async () => real.defaultFirmProfile()) };
});

import { notify } from "@/server/notify";
import { run as runQuotations } from "@/server/jobs/quotations";
import { run as runLeadFollowUps } from "@/server/jobs/lead-follow-ups";

/**
 * The growth jobs (§7.5.1 automation, §7.5.3 follow-ups and expiry) against a recording stand-in for
 * the service-role client: who each run tells, what it records and counts, and that a second run
 * does nothing new (idempotent). Nothing is emailed: follow-ups go on WhatsApp, sent by a person.
 */

type Call = { table: string; op: string; args: unknown[] };

/** A chainable query stand-in: every filter is recorded; awaiting it (or .maybeSingle()) answers from `answer`. */
function fakeAdmin(answer: (table: string, op: string, calls: Call[]) => { data: unknown; error: unknown }, rpc: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const log: Array<{ table: string; op: string; calls: Call[]; payload?: unknown }> = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const entry = { table, op: "select", calls: [] as Call[], payload: undefined as unknown };
    log.push(entry);
    const q: Record<string, unknown> = {};
    const chain = (name: string) =>
      (...args: unknown[]) => {
        if (name === "update" || name === "insert" || name === "delete") {
          entry.op = name;
          entry.payload = args[0];
        }
        entry.calls.push({ table, op: name, args });
        return q;
      };
    for (const m of ["select", "eq", "neq", "is", "not", "in", "lt", "lte", "gt", "gte", "order", "range", "limit", "update", "insert", "delete"]) q[m] = chain(m);
    q.maybeSingle = async () => answer(table, `${entry.op}:single`, entry.calls);
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(table, entry.op, entry.calls)).then(resolve, reject);
    return q;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return rpc(fn, args);
    },
  };
  return { admin: admin as never, log, rpcs };
}

const NOW = new Date("2026-10-23T09:00:00Z"); // 14:30 IST

function quotation(over: Record<string, unknown> = {}) {
  return {
    id: "q1",
    quotation_number: "TW-Q/26-27/0007",
    status: "sent",
    valid_until: "2026-11-22",
    deleted_at: null,
    client_name: "Ravi Sharma",
    client_company: "Sharma Traders",
    client_email: "ravi@sharmatraders.in",
    client_id: null,
    token: "Qm9vNXJmZ3B1a2hzZ3V5dmJ5cGh6d2xrbXF2Y2Rhbm8",
    total: 30197.63,
    sent_at: "2026-10-09T06:00:00Z",
    created_by: "author-1",
    ...over,
  };
}

function followUps(q: ReturnType<typeof quotation>, notifiedAt: string | null = null) {
  return [
    { id: "f3", quotation_id: q.id, follow_up_day: 3, scheduled_at: "2026-10-11T18:30:00Z", status: "pending", notified_at: null, quotations: q },
    { id: "f7", quotation_id: q.id, follow_up_day: 7, scheduled_at: "2026-10-15T18:30:00Z", status: "pending", notified_at: notifiedAt, quotations: q },
  ];
}

beforeEach(() => {
  vi.mocked(notify).mockReset();
  vi.mocked(notify).mockResolvedValue(undefined);
});

describe("quotations job, 14:30 IST (§7.5.3)", () => {
  it("expires lapsed quotations and tells each author", async () => {
    const { admin } = fakeAdmin(
      () => ({ data: [], error: null }),
      (fn) =>
        fn === "expire_lapsed_quotations"
          ? { data: [{ id: "q9", quotation_number: "TW-Q/26-27/0003", created_by: "author-2", lead_id: null, client_id: null, client_name: "Beta Industries", previous_status: "viewed", valid_until: "2026-10-22" }], error: null }
          : { data: null, error: null },
    );
    const r = await runQuotations(admin, NOW);
    expect(r.counts).toMatchObject({ expired: 1, failed: 0 });
    expect(vi.mocked(notify)).toHaveBeenCalledWith(expect.objectContaining({ to: { userIds: ["author-2"] }, title: "Quotation TW-Q/26-27/0003 expired", dedupeKey: "quotation_expired:q9" }));
  });

  it("asks the author, once, to send the latest follow-up due on WhatsApp, and skips the earlier one", async () => {
    const q = quotation();
    const first = fakeAdmin(
      (table, op) => (table === "quotation_follow_ups" && op === "select" ? { data: followUps(q), error: null } : { data: null, error: null }),
      (fn) => (fn === "expire_lapsed_quotations" ? { data: [], error: null } : { data: null, error: null }),
    );
    const r1 = await runQuotations(first.admin, NOW);
    expect(r1.counts).toMatchObject({ follow_ups_to_hand_off: 1, follow_ups_skipped: 1, failed: 0 });
    expect(r1.counts).not.toHaveProperty("follow_ups_emailed");
    expect(vi.mocked(notify)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { userIds: ["author-1"] },
        title: "Follow up quotation TW-Q/26-27/0007 on WhatsApp (day 7)",
        body: expect.stringContaining("on WhatsApp"),
        linkUrl: "/quotations/q1?followup=7",
        dedupeKey: "quotation_follow_up:q1:7",
      }),
    );
    expect(first.rpcs.some((c) => c.fn === "record_quotation_follow_up")).toBe(false);
    const skip = first.log.find((e) => e.table === "quotation_follow_ups" && e.op === "update" && (e.payload as Record<string, unknown>).status === "skipped");
    expect(skip?.calls.find((c) => c.op === "in")?.args).toEqual(["id", ["f3"]]);
    expect(first.log.some((e) => e.op === "update" && (e.payload as Record<string, unknown>).notified_at === NOW.toISOString())).toBe(true);

    vi.mocked(notify).mockClear();
    const again = fakeAdmin(
      (table, op) => (table === "quotation_follow_ups" && op === "select" ? { data: followUps(q, NOW.toISOString()), error: null } : { data: null, error: null }),
      (fn) => (fn === "expire_lapsed_quotations" ? { data: [], error: null } : { data: null, error: null }),
    );
    const r2 = await runQuotations(again.admin, NOW);
    expect(r2.counts.follow_ups_to_hand_off).toBe(0);
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });

  it("skips the follow-ups of a quotation that is no longer open", async () => {
    const q = quotation({ status: "accepted" });
    const { admin, log } = fakeAdmin(
      (table, op) => (table === "quotation_follow_ups" && op === "select" ? { data: followUps(q), error: null } : { data: null, error: null }),
      (fn) => (fn === "expire_lapsed_quotations" ? { data: [], error: null } : { data: null, error: null }),
    );
    const r = await runQuotations(admin, NOW);
    expect(r.counts).toMatchObject({ follow_ups_skipped: 2, follow_ups_to_hand_off: 0 });
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    expect(log.find((e) => e.op === "update")?.payload).toMatchObject({ status: "skipped" });
  });

  it("counts a quotation that fails and carries on", async () => {
    vi.mocked(notify).mockRejectedValueOnce(new Error("network down"));
    const a = quotation();
    const b = quotation({ id: "q2", quotation_number: "TW-Q/26-27/0008" });
    const rows = [
      { id: "fa", quotation_id: "q1", follow_up_day: 3, scheduled_at: "2026-10-20T18:30:00Z", status: "pending", notified_at: null, quotations: a },
      { id: "fb", quotation_id: "q2", follow_up_day: 3, scheduled_at: "2026-10-20T18:30:00Z", status: "pending", notified_at: null, quotations: b },
    ];
    const { admin } = fakeAdmin(
      (table, op) => (table === "quotation_follow_ups" && op === "select" ? { data: rows, error: null } : { data: null, error: null }),
      (fn) => (fn === "expire_lapsed_quotations" ? { data: [], error: null } : { data: null, error: null }),
    );
    const r = await runQuotations(admin, NOW);
    expect(r.counts).toMatchObject({ failed: 1, follow_ups_to_hand_off: 1 });
  });
});

describe("lead follow-ups job, hourly (§7.5.1 automation)", () => {
  const lead = (over: Record<string, unknown> = {}) => ({
    id: "l1",
    lead_number: "LD-0012",
    name: "Ravi Sharma",
    company: "Sharma Traders",
    status: "contacted",
    assigned_to: "emp-1",
    created_by: "author-1",
    next_follow_up_at: "2026-10-23T08:30:00Z",
    follow_up_reminded_for: null,
    last_activity_at: "2026-10-20T08:00:00Z",
    stale_notified_at: null,
    ...over,
  });

  it("reminds the assignee once per follow-up time", async () => {
    let call = 0;
    const { admin, log } = fakeAdmin(
      (table, op) => {
        if (table !== "leads" || op !== "select") return { data: null, error: null };
        call++;
        return { data: call === 1 ? [lead()] : [], error: null };
      },
      () => ({ data: null, error: null }),
    );
    const r = await runLeadFollowUps(admin, NOW);
    expect(r.counts).toMatchObject({ follow_ups_reminded: 1, stale_notified: 0, failed: 0 });
    expect(vi.mocked(notify)).toHaveBeenCalledWith(expect.objectContaining({ to: { employeeIds: ["emp-1"] }, title: "Follow up: Sharma Traders · Ravi Sharma", dedupeKey: "lead_follow_up:l1:2026-10-23T08:30:00Z" }));
    expect(log.find((e) => e.op === "update")?.payload).toEqual({ follow_up_reminded_for: "2026-10-23T08:30:00Z" });

    vi.mocked(notify).mockClear();
    let again = 0;
    const second = fakeAdmin(
      (table, op) => {
        if (table !== "leads" || op !== "select") return { data: null, error: null };
        again++;
        return { data: again === 1 ? [lead({ follow_up_reminded_for: "2026-10-23T08:30:00.000Z" })] : [], error: null };
      },
      () => ({ data: null, error: null }),
    );
    expect((await runLeadFollowUps(second.admin, NOW)).counts.follow_ups_reminded).toBe(0);
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });

  it("tells the owner about a lead untouched for 14 days, once per quiet spell", async () => {
    const quiet = lead({ assigned_to: null, next_follow_up_at: null, last_activity_at: "2026-10-01T08:00:00Z" });
    let call = 0;
    const { admin } = fakeAdmin(
      (table, op) => {
        if (table !== "leads" || op !== "select") return { data: null, error: null };
        call++;
        return { data: call === 2 ? [quiet] : [], error: null };
      },
      () => ({ data: null, error: null }),
    );
    const r = await runLeadFollowUps(admin, NOW);
    expect(r.counts).toMatchObject({ stale_notified: 1 });
    expect(vi.mocked(notify)).toHaveBeenCalledWith(expect.objectContaining({ to: { userIds: ["author-1"] }, type: "warning", dedupeKey: "lead_stale:l1:2026-10-01T08:00:00Z" }));

    vi.mocked(notify).mockClear();
    let again = 0;
    const second = fakeAdmin(
      (table, op) => {
        if (table !== "leads" || op !== "select") return { data: null, error: null };
        again++;
        return { data: again === 2 ? [{ ...quiet, stale_notified_at: "2026-10-16T09:00:00Z" }] : [], error: null };
      },
      () => ({ data: null, error: null }),
    );
    expect((await runLeadFollowUps(second.admin, NOW)).counts.stale_notified).toBe(0);
  });
});

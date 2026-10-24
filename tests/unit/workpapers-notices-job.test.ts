import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sent: Array<Record<string, unknown>> = [];
vi.mock("@/server/notify", () => ({
  notify: vi.fn(async (input: Record<string, unknown>) => {
    sent.push(input);
  }),
}));
vi.mock("@/lib/log", () => ({ logUnexpected: vi.fn(() => "REF123"), log: vi.fn() }));

import { run } from "@/server/jobs/notice-reminders";
import type { AdminSupabase } from "@/server/admin";

type Row = Record<string, unknown>;

/** A stand-in for the service-role client: every query answers with the same rows. */
function fakeAdmin(rows: Row[]): AdminSupabase {
  const builder = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "in", "lte", "lt", "gte", "eq", "is", "limit", "order"]) q[m] = () => q;
    q.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null });
    return q;
  };
  return { from: () => builder() } as unknown as AdminSupabase;
}

const NOW = new Date("2026-10-24T03:30:00Z"); // 09:00 IST

function notice(o: Row): Row {
  return {
    id: "n1",
    client_id: "c1",
    notice_type: "IT 143(2)",
    reference_no: "DIN-1",
    status: "open",
    reply_due_date: null,
    hearing_date: null,
    appeal_decision: null,
    appeal_forum: null,
    limitation_date: null,
    assigned_employee_id: "emp-assigned",
    appeal_task_id: null,
    clients: { display_name: "Alpha Traders", owner_employee_id: "emp-owner", deleted_at: null },
    tasks: null,
    ...o,
  };
}

beforeEach(() => {
  sent.length = 0;
});

describe("notice reminders job (§7.8.4, §8 09:00)", () => {
  it("reminds the assignee 2 days before the reply is due, once, with a dedupe key", async () => {
    const r = await run(fakeAdmin([notice({ reply_due_date: "2026-10-26" })]), NOW);
    expect(r.counts).toMatchObject({ reply_reminders: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: { employeeIds: ["emp-assigned"], roles: [] },
      type: "compliance_due",
      title: "Reply due in 2 days: IT 143(2)",
      linkUrl: "/workpapers/notices/n1",
      clientId: "c1",
      dedupeKey: "notice_reply:n1:2026-10-26:2",
    });
    expect(String(sent[0].body)).toMatch(/Alpha Traders \(ref\. DIN-1\): the reply is due on 26 Oct 2026\./);
  });

  it("flags an overdue reply to the Managers too, and falls back to the client's owner when unassigned", async () => {
    await run(fakeAdmin([notice({ reply_due_date: "2026-10-21", assigned_employee_id: null })]), NOW);
    expect(sent[0]).toMatchObject({ to: { employeeIds: ["emp-owner"], roles: ["manager"] }, type: "warning", title: "Reply overdue: IT 143(2)", dedupeKey: "notice_reply_overdue:n1:2026-10-21" });
  });

  it("reminds about a hearing and an appeal limitation, Partners in the last two days", async () => {
    await run(
      fakeAdmin([
        notice({ id: "h1", status: "hearing", hearing_date: "2026-10-31T06:00:00Z" }),
        notice({ id: "a1", status: "closed_unfavourable", appeal_decision: "appeal", appeal_forum: "income_tax_first_appeal", limitation_date: "2026-10-25" }),
      ]),
      NOW,
    );
    const hearing = sent.find((s) => s.dedupeKey === "notice_hearing:h1:2026-10-31:7");
    expect(hearing).toMatchObject({ type: "compliance_due", title: "Hearing in 7 days: IT 143(2)" });
    expect(String(hearing?.body)).toMatch(/31 Oct 2026, 11:30/);
    const appeal = sent.find((s) => s.dedupeKey === "notice_appeal:a1:2026-10-25:2");
    expect(appeal).toMatchObject({ to: { employeeIds: ["emp-assigned"], roles: ["partner"] }, title: "Appeal limitation tomorrow: IT 143(2)" });
    expect(String(appeal?.body)).toMatch(/to Income tax: first appeal \(CIT\(A\)\) by 25 Oct 2026/);
  });

  it("stays quiet once the appeal is filed, and skips clients in the recycle bin", async () => {
    const r = await run(
      fakeAdmin([
        notice({ id: "a2", status: "closed_unfavourable", appeal_decision: "appeal", limitation_date: "2026-10-25", appeal_task_id: "t1", tasks: { status: "filed_done", deleted_at: null } }),
        notice({ id: "d1", reply_due_date: "2026-10-25", clients: { display_name: "Gone", owner_employee_id: null, deleted_at: "2026-10-01T00:00:00Z" } }),
      ]),
      NOW,
    );
    expect(sent).toEqual([]);
    expect(r.counts.failed).toBe(0);
  });

  it("logs a notice that fails and carries on with the rest", async () => {
    const { notify } = await import("@/server/notify");
    vi.mocked(notify).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const r = await run(fakeAdmin([notice({ id: "x1", reply_due_date: "2026-10-26" }), notice({ id: "x2", reply_due_date: "2026-10-26" })]), NOW);
    expect(r.counts).toMatchObject({ failed: 1, reply_reminders: 1 });
    expect(sent.map((s) => s.dedupeKey)).toEqual(["notice_reply:x2:2026-10-26:2"]);
  });
});

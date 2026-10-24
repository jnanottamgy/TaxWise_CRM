import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({ createAdminClient: vi.fn(() => { throw new Error("tests pass their own client"); }) }));

const { recordBeat } = await import("@/server/presence");

/**
 * An in-memory employee_sessions table behind the few query shapes server/presence.ts uses. Every
 * call yields to the event loop first, so beats started together interleave their reads and writes
 * the way concurrent requests do against PostgREST.
 */
type Row = { id: string; employee_id: string; user_id: string; login_at: string; last_active_at: string; active_minutes: number; is_active: boolean };

function fakeAdmin(initial: Row[] = []) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  let seq = 0;
  let writes = 0;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));

  const filterable = <T>(run: (filters: Array<[string, unknown]>) => Promise<T>) => {
    const filters: Array<[string, unknown]> = [];
    const chain = {
      eq(col: string, value: unknown) {
        filters.push([col, value]);
        return chain;
      },
      maybeSingle: () => run(filters),
      select: () => run(filters),
      then: (ok: (v: T) => unknown, bad?: (e: unknown) => unknown) => run(filters).then(ok, bad),
    };
    return chain;
  };
  const matches = (r: Row, filters: Array<[string, unknown]>) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v);

  const client = {
    from(table: string) {
      if (table === "statutory_parameters") {
        return { select: () => filterable(async () => ({ data: [], error: null })) };
      }
      if (table !== "employee_sessions") throw new Error(`unexpected table ${table}`);
      return {
        select: () =>
          filterable(async (filters) => {
            await tick();
            const found = rows.filter((r) => matches(r, filters));
            return { data: found[0] ? { ...found[0] } : null, error: null };
          }),
        update: (patch: Partial<Row>) =>
          filterable(async (filters) => {
            await tick();
            const hit = rows.filter((r) => matches(r, filters));
            for (const r of hit) Object.assign(r, patch);
            if (hit.length) writes++;
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          }),
        insert: async (row: Omit<Row, "id">) => {
          await tick();
          if (row.is_active && rows.some((r) => r.employee_id === row.employee_id && r.is_active)) {
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          rows.push({ ...row, id: `s${++seq}` });
          writes++;
          return { error: null };
        },
      };
    },
  };
  return { client: client as unknown as Parameters<typeof recordBeat>[2], rows, writes: () => writes };
}

const who = { employeeId: "e1", userId: "u1" };

describe("recordBeat under concurrent beats from several tabs (§7.12)", () => {
  it("answers every beat and credits the elapsed minutes once", async () => {
    const t0 = Date.parse("2026-10-24T05:00:00.000Z");
    const admin = fakeAdmin([{ id: "s0", employee_id: "e1", user_id: "u1", login_at: new Date(t0 - 60 * 60_000).toISOString(), last_active_at: new Date(t0 - 3 * 60_000).toISOString(), active_minutes: 40, is_active: true }]);
    // Eight tabs beat within a few milliseconds of each other.
    const beats = Array.from({ length: 8 }, (_, i) => recordBeat(who, new Date(t0 + i * 3), admin.client));
    const results = await Promise.all(beats);
    expect(results.every((r) => r.outcome === "credited")).toBe(true);
    const open = admin.rows.filter((r) => r.is_active);
    expect(open).toHaveLength(1);
    // Three minutes of silence credited once, never once per tab.
    expect(open[0].active_minutes).toBe(43);
    expect(Date.parse(open[0].last_active_at)).toBeGreaterThanOrEqual(t0);
  });

  it("opens exactly one session when several tabs beat with none open", async () => {
    const t0 = Date.parse("2026-10-24T05:00:00.000Z");
    const admin = fakeAdmin();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => recordBeat(who, new Date(t0 + i), admin.client)));
    expect(results.filter((r) => r.outcome === "opened")).toHaveLength(1);
    expect(admin.rows.filter((r) => r.is_active)).toHaveLength(1);
    expect(admin.rows.filter((r) => r.is_active)[0].active_minutes).toBe(0);
  });

  it("writes nothing for a beat a concurrent one already covered", async () => {
    const t0 = Date.parse("2026-10-24T05:00:00.000Z");
    const admin = fakeAdmin([{ id: "s0", employee_id: "e1", user_id: "u1", login_at: new Date(t0 - 60 * 60_000).toISOString(), last_active_at: new Date(t0 + 1000).toISOString(), active_minutes: 12, is_active: true }]);
    const r = await recordBeat(who, new Date(t0), admin.client);
    expect(r).toEqual({ outcome: "credited", activeMinutes: 12, lastActiveAt: new Date(t0 + 1000).toISOString() });
    expect(admin.writes()).toBe(0);
  });
});

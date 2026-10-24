import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

/**
 * Review of wave C: the §13 rate limits on every server action and on revealing stored passwords;
 * engagement papers left out of an Employee's document categories (§4.1); the dashboard's "Filings
 * due in 7 days" opening the agenda with only the deadlines it counts (§7.2).
 */

const checkRateLimit = vi.fn();
const rpc = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...real, checkRateLimit: (...args: unknown[]) => checkRateLimit(...args) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "vitest" }) }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => undefined }));
vi.mock("@/lib/auth/current-user", () => ({
  getSession: async () => ({
    status: "ok",
    user: { id: "user-1", email: "m1@taxwise.test", fullName: "Test M1", role: "manager", mustChangePassword: false, employeeId: "emp-1" },
    supabase: {
      rpc,
      auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) } },
    },
  }),
}));

const { defineAction } = await import("@/lib/action");
const { RATE_LIMITS } = await import("@/lib/rate-limit");
const { categoryOptionsFor, CATEGORY_OPTIONS, MANAGER_ONLY_CATEGORIES } = await import("@/lib/schemas/documents");
const { agendaHref } = await import("@/components/home/logic");
const { calendarHref, parseCalendarState } = await import("@/components/compliance/logic/calendar");

describe("server actions are rate limited per person (§13)", () => {
  beforeEach(() => {
    checkRateLimit.mockReset();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: null });
  });

  const action = defineAction({ name: "test.echo", schema: z.object({ n: z.number() }), roles: ["partner", "manager"] }, async (input) => ({ ok: true as const, data: input.n * 2 }));

  it("uses the spec's 300 a minute, and runs the action within it", async () => {
    expect(RATE_LIMITS.serverAction).toEqual({ limit: 300, windowSeconds: 60 });
    checkRateLimit.mockResolvedValue({ allowed: true, failedOpen: false });
    const r = await action({ n: 21 });
    expect(r).toMatchObject({ ok: true, data: 42 });
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "action", identity: ["user-1"], limit: 300, windowSeconds: 60, audit: expect.objectContaining({ userId: "user-1", ip: "203.0.113.7" }) }),
    );
  });

  it("refuses with a plain sentence past the limit, before the handler runs", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, failedOpen: false });
    const handler = vi.fn();
    const limited = defineAction({ name: "test.limited", schema: z.object({}) }, handler);
    const r = await limited({});
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a reveal limit for stored passwords, tighter than the general one", () => {
    expect(RATE_LIMITS.credentialReveal.limit).toBeLessThan(RATE_LIMITS.serverAction.limit);
    expect(RATE_LIMITS.credentialReveal.windowSeconds).toBeGreaterThanOrEqual(600);
  });
});

describe("engagement papers stay out of an Employee's document categories (§4.1)", () => {
  it("leaves 'engagement' out for an Employee only", () => {
    expect(MANAGER_ONLY_CATEGORIES).toEqual(["engagement"]);
    expect(categoryOptionsFor("employee").map((c) => c.value)).not.toContain("engagement");
    expect(categoryOptionsFor("employee")).toHaveLength(CATEGORY_OPTIONS.length - 1);
    for (const role of ["partner", "manager", null, undefined]) expect(categoryOptionsFor(role)).toEqual(CATEGORY_OPTIONS);
  });
});

describe("Filings due in 7 days opens only the deadlines it counts (§7.2)", () => {
  const sp = (href: string) => Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));

  it("links to the agenda's not-yet-filed deadlines for those 7 days", () => {
    const href = agendaHref("2026-10-24", "2026-10-31", { pendingOnly: true });
    expect(href).toBe("/calendar?view=agenda&date=2026-10-24&to=2026-10-31&pending=1");
    expect(parseCalendarState(sp(href), "2026-10-24")).toMatchObject({ view: "agenda", from: "2026-10-24", to: "2026-10-31", pending: true });
  });

  it("keeps 'pending' to the agenda, and the nav can drop it", () => {
    expect(parseCalendarState({ view: "agenda", date: "2026-10-24" }, "2026-10-24").pending).toBe(false);
    expect(parseCalendarState({ view: "month", date: "2026-10", pending: "1" }, "2026-10-24").pending).toBe(false);
    expect(parseCalendarState({ view: "agenda", day: "2026-10-24", pending: "1" }, "2026-10-24").pending).toBe(false);
    expect(calendarHref({ view: "agenda", date: "2026-10-24", to: "2026-10-31", pending: "1" }, { pending: null })).toBe("/calendar?view=agenda&date=2026-10-24&to=2026-10-31");
  });
});

describe("financial statements are reviewed and finalised only as the server builds them (§6.13)", async () => {
  const { emptyInputs, readInputs, readLedgers, readStatements, rebuildStatements, statementsAgree } = await import("@/lib/schemas/financial-statements");
  type StoredLedger = import("@/lib/schemas/financial-statements").StoredLedger;
  const RUPEE = 100;
  const ledger = (name: string, bucket: StoredLedger["bucket"], debit: number, credit: number): StoredLedger => ({
    name,
    group: null,
    debit: debit * RUPEE,
    credit: credit * RUPEE,
    row: 0,
    bucket,
    matched: bucket !== null,
    source: bucket ? "keyword" : "unmapped",
    confidence: bucket ? "medium" : "none",
    reason: "",
  });
  const ledgers: StoredLedger[] = [
    ledger("Capital Account", "share_capital", 0, 1_00_000),
    ledger("Sales", "revenue_from_operations", 0, 1_00_000),
    ledger("Purchases", "purchases", 70_000, 0),
    ledger("Cash in hand", "cash_bank", 1_30_000, 0),
  ];
  const inputs = { ...emptyInputs("proprietorship"), closingStock: 5_000 * RUPEE };
  const built = rebuildStatements(ledgers, inputs, { financialYear: "2025-26", previous: null });
  // What the database hands back: JSON, read through the same readers the detail page uses.
  const roundTrip = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

  it("agrees with its own stored copy after a round trip through the database", () => {
    const rebuilt = rebuildStatements(readLedgers(roundTrip(ledgers)), readInputs(roundTrip(inputs), "proprietorship"), { financialYear: "2025-26", previous: null });
    expect(statementsAgree(readStatements(roundTrip(built)), rebuilt)).toBe(true);
  });

  it("refuses figures that weren't built from the trial balance, a forged check result, or none at all", () => {
    const forged = roundTrip(built) as { figures: { profit: number; buckets: Record<string, number> }; allChecksPassed: boolean };
    forged.figures.profit += 1_00_000 * RUPEE;
    expect(statementsAgree(readStatements(forged), built)).toBe(false);

    const bucket = roundTrip(built) as typeof forged;
    bucket.figures.buckets.cash_bank += 1;
    expect(statementsAgree(readStatements(bucket), built)).toBe(false);

    const unbalanced = rebuildStatements([...ledgers, ledger("Suspense", null, 10, 0)], inputs, { financialYear: "2025-26", previous: null });
    expect(unbalanced.allChecksPassed).toBe(false);
    const claimed = { ...(roundTrip(unbalanced) as object), allChecksPassed: true };
    expect(statementsAgree(readStatements(claimed), unbalanced)).toBe(false);

    expect(statementsAgree(null, built)).toBe(false);
  });
});

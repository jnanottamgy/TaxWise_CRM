import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const insert = vi.fn();
const from = vi.fn(() => ({ insert }));
vi.mock("@/server/admin", () => ({ createAdminClient: vi.fn(() => ({ rpc, from })) }));

const { checkRateLimit, interpretRateLimitResult, rateLimitKey, RATE_LIMITS } = await import("@/lib/rate-limit");

describe("RATE_LIMITS (§13)", () => {
  it("has the spec's numbers", () => {
    expect(RATE_LIMITS.login).toEqual({ limit: 5, windowSeconds: 900 });
    expect(RATE_LIMITS.passwordReset).toEqual({ limit: 3, windowSeconds: 3600 });
  });
});

describe("rateLimitKey", () => {
  it("is stable, scoped and never contains the raw email or IP", async () => {
    const a = await rateLimitKey("login", ["Ravi@Example.com ", "203.0.113.7"]);
    const b = await rateLimitKey("login", ["ravi@example.com", "203.0.113.7"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^login:[0-9a-f]{64}$/);
    expect(a).not.toContain("ravi");
    expect(a).not.toContain("203.0.113.7");
  });

  it("separates scopes and identities", async () => {
    const login = await rateLimitKey("login", ["ravi@example.com", "203.0.113.7"]);
    expect(await rateLimitKey("password_reset", ["ravi@example.com", "203.0.113.7"])).not.toBe(login);
    expect(await rateLimitKey("login", ["ravi@example.com", "203.0.113.8"])).not.toBe(login);
    expect(await rateLimitKey("login", ["ravi@example.com", null])).toMatch(/^login:/);
  });
});

describe("interpretRateLimitResult", () => {
  it.each([
    [true, true],
    [false, false],
    [{ allowed: true }, true],
    [{ allowed: false }, false],
    [[{ allowed: false }], false],
    [[{ check_rate_limit: true }], true],
    [{ remaining: 2 }, true],
    [{ remaining: -1 }, false],
    [null, null],
    ["yes", null],
    [{}, null],
  ])("%j -> %j", (input, expected) => {
    expect(interpretRateLimitResult(input)).toBe(expected);
  });
});

describe("checkRateLimit", () => {
  const check = {
    scope: "login",
    identity: ["ravi@example.com", "203.0.113.7"],
    limit: 5,
    windowSeconds: 900,
    audit: { email: "ravi@example.com", ip: "203.0.113.7", userAgent: "test" },
  };

  beforeEach(() => {
    rpc.mockReset();
    insert.mockReset().mockResolvedValue({ error: null });
    from.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("calls check_rate_limit with the hashed key, limit and window", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(checkRateLimit(check)).resolves.toEqual({ allowed: true, failedOpen: false });
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      p_key: expect.stringMatching(/^login:[0-9a-f]{64}$/),
      p_limit: 5,
      p_window_seconds: 900,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("blocks over the limit and writes an access_denied audit row (§13)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(checkRateLimit(check)).resolves.toEqual({ allowed: false, failedOpen: false });
    expect(from).toHaveBeenCalledWith("audit_logs");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "access_denied",
        user_email: "ravi@example.com",
        ip: "203.0.113.7",
        action: "rate_limit.login",
        success: false,
      }),
    );
  });

  it("still blocks when the audit write fails", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    insert.mockResolvedValue({ error: { message: "permission denied" } });
    await expect(checkRateLimit(check)).resolves.toEqual({ allowed: false, failedOpen: false });
  });

  it("fails open when the database errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function check_rate_limit does not exist", code: "42883" } });
    await expect(checkRateLimit(check)).resolves.toEqual({ allowed: true, failedOpen: true });
  });

  it("fails open when the call throws", async () => {
    rpc.mockRejectedValue(new Error("fetch failed"));
    await expect(checkRateLimit(check)).resolves.toEqual({ allowed: true, failedOpen: true });
  });

  it("fails open on an answer it can't read", async () => {
    rpc.mockResolvedValue({ data: "maybe", error: null });
    await expect(checkRateLimit(check)).resolves.toEqual({ allowed: true, failedOpen: true });
  });
});

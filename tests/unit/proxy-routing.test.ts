import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  ACTIVITY_COOKIE,
  decideRoute,
  destinationFor,
  IDLE_LIMIT_MS,
  isIdleExpired,
  isPublicPath,
  isStaffPath,
  parseActivity,
  pathAllowedForRole,
  safeNextPath,
  storedUserHasVerifiedFactor,
  type RouteInput,
  type SessionHint,
} from "@/lib/supabase/proxy";

// -------------------------------------------------------------------------------------------------
// Pure rules
// -------------------------------------------------------------------------------------------------

const partner: SessionHint = { role: "partner", mustChangePassword: false, aal: "aal2", mfaEnrolled: true };
const manager: SessionHint = { role: "manager", mustChangePassword: false, aal: "aal2", mfaEnrolled: true };
const employee: SessionHint = { role: "employee", mustChangePassword: false, aal: "aal1", mfaEnrolled: false };
const client: SessionHint = { role: "client", mustChangePassword: false, aal: "aal1", mfaEnrolled: false };

function route(pathname: string, session: SessionHint | null, extra: Partial<RouteInput> = {}) {
  return decideRoute({ pathname, search: "", isServerAction: false, session, idleExpired: false, ...extra });
}

describe("public paths", () => {
  it.each(["/login", "/forgot-password", "/setup", "/q/abc123", "/q/abc123/pdf", "/api/q/abc123/pdf", "/api/health", "/api/cron/receivables", "/api/cron/tick", "/_next/static/chunk.js", "/favicon.ico", "/logo.svg"])(
    "%s is public",
    (p) => expect(isPublicPath(p)).toBe(true),
  );

  it.each(["/dashboard", "/clients/1", "/portal", "/portal/invoices/1", "/api/files/sign", "/api/pdf/quotation/1", "/api/portal/invoices/1/pdf", "/api/desktop/context", "/api/webhooks/resend", "/reset-password", "/auth/confirm", "/api/qx/1", "/no-access", "/mfa", "/set-password", "/q", "/loginx", "/setup/extra"])("%s is not public", (p) =>
    expect(isPublicPath(p)).toBe(false),
  );

  it("lets anyone through to a public path", () => {
    expect(route("/q/abc123", null)).toEqual({ kind: "next" });
    expect(route("/api/q/abc123/pdf", null)).toEqual({ kind: "next" });
    expect(route("/setup", null)).toEqual({ kind: "next" });
    expect(route("/api/cron/receivables", null)).toEqual({ kind: "next" });
  });
});

describe("no session", () => {
  it("sends pages to /login with next", () => {
    expect(route("/clients", null, { search: "?tab=billing" })).toEqual({ kind: "redirect", to: "/login?next=%2Fclients%3Ftab%3Dbilling" });
  });

  it("sends the root to /login without next", () => {
    expect(route("/", null)).toEqual({ kind: "redirect", to: "/login" });
  });

  it("answers APIs with 401 JSON instead of a redirect", () => {
    expect(route("/api/files/sign", null)).toMatchObject({ kind: "json", status: 401, code: "unauthenticated" });
  });

  it("lets Server Actions through so they can answer for themselves", () => {
    expect(route("/clients", null, { isServerAction: true })).toEqual({ kind: "next" });
  });
});

describe("role hint (§0.1 rule 9)", () => {
  const noRole: SessionHint = { role: null, mustChangePassword: false, aal: "aal1", mfaEnrolled: false };

  it("treats a missing app_metadata.role as no access, with no fallback", () => {
    expect(route("/dashboard", noRole)).toEqual({ kind: "redirect", to: "/no-access" });
    expect(route("/portal", noRole)).toEqual({ kind: "redirect", to: "/no-access" });
    expect(route("/", noRole)).toEqual({ kind: "redirect", to: "/no-access" });
    expect(route("/api/files/sign", noRole)).toMatchObject({ kind: "json", status: 403 });
  });

  it("lets them see /no-access (and sign out from it)", () => {
    expect(route("/no-access", noRole)).toEqual({ kind: "next" });
    expect(route("/no-access", noRole, { isServerAction: true })).toEqual({ kind: "next" });
  });

  it("sends clients away from staff pages and staff away from the portal", () => {
    expect(route("/dashboard", client)).toEqual({ kind: "redirect", to: "/portal" });
    expect(route("/invoices/123", client)).toEqual({ kind: "redirect", to: "/portal" });
    expect(route("/portal/invoices", client)).toEqual({ kind: "next" });
    expect(route("/portal", partner)).toEqual({ kind: "redirect", to: "/dashboard" });
    expect(route("/portal/documents", employee)).toEqual({ kind: "redirect", to: "/my-day" });
    expect(route("/clients", employee)).toEqual({ kind: "next" });
  });

  it("sends the root to each role's home", () => {
    expect(route("/", partner)).toEqual({ kind: "redirect", to: "/dashboard" });
    expect(route("/", manager)).toEqual({ kind: "redirect", to: "/dashboard" });
    expect(route("/", employee)).toEqual({ kind: "redirect", to: "/my-day" });
    expect(route("/", client)).toEqual({ kind: "redirect", to: "/portal" });
  });

  it("never decides API permissions: route handlers check for themselves", () => {
    expect(route("/api/files/sign", client)).toEqual({ kind: "next" });
  });

  it("sends a signed-in person away from /login to where they belong", () => {
    expect(route("/login", partner)).toEqual({ kind: "redirect", to: "/dashboard" });
    expect(route("/login", client, { search: "?next=%2Fportal%2Finvoices" })).toEqual({ kind: "redirect", to: "/portal/invoices" });
    expect(route("/login", client, { search: "?next=%2Fdashboard" })).toEqual({ kind: "redirect", to: "/portal" });
    expect(route("/login", { ...partner, role: null })).toEqual({ kind: "next" });
  });
});

describe("forced password change (§4.4)", () => {
  const temp: SessionHint = { ...employee, mustChangePassword: true };

  it("redirects every page except /set-password", () => {
    expect(route("/my-day", temp)).toEqual({ kind: "redirect", to: "/set-password" });
    expect(route("/", temp)).toEqual({ kind: "redirect", to: "/set-password" });
    expect(route("/mfa", temp)).toEqual({ kind: "redirect", to: "/set-password" });
    expect(route("/set-password", temp)).toEqual({ kind: "next" });
  });

  it("refuses APIs and leaves actions to lib/action.ts (which refuses them)", () => {
    expect(route("/api/files/sign", temp)).toMatchObject({ kind: "json", status: 403, code: "must_change_password" });
    expect(route("/clients", temp, { isServerAction: true })).toEqual({ kind: "next" });
  });

  it("comes before two-step sign-in", () => {
    expect(route("/dashboard", { ...partner, aal: "aal1", mustChangePassword: true })).toEqual({ kind: "redirect", to: "/set-password" });
  });
});

describe("two-step sign-in (§12)", () => {
  it("requires aal2 for Partners and Managers", () => {
    expect(route("/dashboard", { ...partner, aal: "aal1" })).toEqual({ kind: "redirect", to: "/mfa?next=%2Fdashboard" });
    expect(route("/clients", { ...manager, aal: "aal1", mfaEnrolled: false }, { search: "?q=ravi" })).toEqual({
      kind: "redirect",
      to: "/mfa?next=%2Fclients%3Fq%3Dravi",
    });
    expect(route("/dashboard", partner)).toEqual({ kind: "next" });
    expect(route("/", { ...partner, aal: "aal1" })).toEqual({ kind: "redirect", to: "/mfa?next=%2Fdashboard" });
  });

  it("challenges an Employee or Client only when they turned it on", () => {
    expect(route("/my-day", employee)).toEqual({ kind: "next" });
    expect(route("/my-day", { ...employee, mfaEnrolled: true })).toEqual({ kind: "redirect", to: "/mfa?next=%2Fmy-day" });
    expect(route("/portal", { ...client, mfaEnrolled: true })).toEqual({ kind: "redirect", to: "/mfa?next=%2Fportal" });
  });

  it("lets the gate pages through and refuses APIs and actions elsewhere", () => {
    const pending = { ...partner, aal: "aal1" as const };
    expect(route("/mfa", pending)).toEqual({ kind: "next" });
    expect(route("/no-access", pending)).toEqual({ kind: "next" });
    expect(route("/mfa", pending, { isServerAction: true })).toEqual({ kind: "next" });
    expect(route("/api/files/sign", pending)).toMatchObject({ kind: "json", status: 403, code: "mfa_required" });
    expect(route("/invoices", pending, { isServerAction: true })).toMatchObject({ kind: "json", status: 403 });
  });
});

describe("storedUserHasVerifiedFactor (the two-step hint from the session cookie)", () => {
  it("is true only for a verified authenticator", () => {
    expect(storedUserHasVerifiedFactor({ factors: [{ status: "verified", factor_type: "totp" }] })).toBe(true);
    expect(storedUserHasVerifiedFactor({ factors: [{ status: "unverified" }, { status: "verified" }] })).toBe(true);
    expect(storedUserHasVerifiedFactor({ factors: [{ status: "unverified" }] })).toBe(false);
    expect(storedUserHasVerifiedFactor({ factors: [] })).toBe(false);
    expect(storedUserHasVerifiedFactor({})).toBe(false);
    expect(storedUserHasVerifiedFactor({ factors: "verified" })).toBe(false);
    expect(storedUserHasVerifiedFactor(null)).toBe(false);
    expect(storedUserHasVerifiedFactor(undefined)).toBe(false);
  });

  it("reads supabase-js's warning proxy of the stored user without tripping its warning", () => {
    const warned: string[] = [];
    const stored = new Proxy(
      { id: "u1", factors: [{ status: "verified" }] },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") warned.push(prop);
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    expect(storedUserHasVerifiedFactor(stored)).toBe(true);
    expect(warned).toEqual([]);
  });
});

describe("idle timeout (§4.4)", () => {
  const now = Date.UTC(2026, 9, 22, 6, 30);

  it("allows 12 hours for staff and 2 hours for clients", () => {
    expect(isIdleExpired(now - IDLE_LIMIT_MS.staff + 1000, now, "partner")).toBe(false);
    expect(isIdleExpired(now - IDLE_LIMIT_MS.staff - 1000, now, "employee")).toBe(true);
    expect(isIdleExpired(now - 3 * 60 * 60 * 1000, now, "manager")).toBe(false);
    expect(isIdleExpired(now - 3 * 60 * 60 * 1000, now, "client")).toBe(true);
    expect(isIdleExpired(null, now, "client")).toBe(false);
  });

  it("reads only well-formed millisecond timestamps", () => {
    expect(parseActivity(String(now))).toBe(now);
    expect(parseActivity("abc")).toBeNull();
    expect(parseActivity("")).toBeNull();
    expect(parseActivity("12")).toBeNull();
    expect(parseActivity(undefined)).toBeNull();
  });

  it("signs out and sends pages to /login?reason=idle", () => {
    expect(route("/clients", partner, { idleExpired: true })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fclients&reason=idle",
      signOut: true,
    });
    expect(route("/login", partner, { idleExpired: true })).toEqual({ kind: "redirect", to: "/login?reason=idle", signOut: true });
    expect(route("/login", partner, { idleExpired: true, search: "?reason=idle" })).toEqual({ kind: "next", signOut: true });
  });

  it("signs out APIs with 401 and actions by passing them through signed out", () => {
    expect(route("/api/files/sign", client, { idleExpired: true })).toMatchObject({ kind: "json", status: 401, signOut: true });
    expect(route("/portal", client, { idleExpired: true, isServerAction: true })).toEqual({ kind: "next", signOut: true });
  });
});

describe("safeNextPath and destinationFor", () => {
  it.each([
    ["/clients?tab=billing", "/clients?tab=billing"],
    ["/work/123#comments", "/work/123#comments"],
    ["https://evil.example/x", null],
    ["//evil.example/x", null],
    ["/\\evil.example", null],
    ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"],
    ["/ok\nbad", null],
    ["javascript:alert(1)", null],
    ["/login", null],
    ["/mfa?next=/x", null],
    ["/api/files/sign", null],
    ["", null],
    [undefined, null],
  ])("safeNextPath(%j) = %j", (input, expected) => {
    expect(safeNextPath(input as string | undefined)).toBe(expected);
  });

  it("keeps next only when it suits the role", () => {
    expect(destinationFor("partner", "/invoices?status=overdue")).toBe("/invoices?status=overdue");
    expect(destinationFor("partner", "/portal")).toBe("/dashboard");
    expect(destinationFor("employee", null)).toBe("/my-day");
    expect(destinationFor("client", "/portal/documents")).toBe("/portal/documents");
    expect(destinationFor("client", "/clients")).toBe("/portal");
    expect(destinationFor("manager", "https://evil.example")).toBe("/dashboard");
  });

  it("classifies staff paths", () => {
    expect(isStaffPath("/dashboard")).toBe(true);
    expect(isStaffPath("/portal")).toBe(false);
    expect(isStaffPath("/")).toBe(false);
    expect(pathAllowedForRole("/settings/firm", "manager")).toBe(true);
    expect(pathAllowedForRole("/portal/help", "employee")).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// The proxy body, with Supabase mocked
// -------------------------------------------------------------------------------------------------

const auth = {
  getClaims: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
};
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => ({ auth })) }));

const { isDecodablePath, updateSession } = await import("@/lib/supabase/proxy");

function claims(appMetadata: Record<string, unknown> | null, aal: "aal1" | "aal2" = "aal2") {
  return { data: appMetadata ? { claims: { sub: "u1", aal, app_metadata: appMetadata } } : null, error: null };
}

function request(path: string, init: { cookies?: Record<string, string>; method?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookies) headers.set("cookie", Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  return new NextRequest(new URL(path, "https://crm.twchartered.com"), { method: init.method ?? "GET", headers });
}

describe("updateSession", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    auth.getClaims.mockReset();
    auth.signOut.mockReset().mockResolvedValue({ error: null });
    auth.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "t", user: { id: "u1", factors: [] } } }, error: null });
  });

  it("redirects an anonymous visitor to /login with next, marked noindex", async () => {
    auth.getClaims.mockResolvedValue(claims(null));
    const res = await updateSession(request("/clients?tab=billing"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://crm.twchartered.com/login?next=%2Fclients%3Ftab%3Dbilling");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("answers 400 for a path with a malformed percent escape, before any session work", async () => {
    const res = await updateSession(request("/clients/%E0%A4%A"));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(auth.getClaims).not.toHaveBeenCalled();
    expect((await updateSession(request("/api/pdf/invoice/%ZZ"))).status).toBe(400);
  });

  it("passes a path with valid escapes through", () => {
    expect(isDecodablePath("/clients/Sharma%20Traders")).toBe(true);
    expect(isDecodablePath("/clients/%E0%A4%85")).toBe(true);
    expect(isDecodablePath("/clients/%E0%A4%A")).toBe(false);
  });

  it("leaves the sign-in page indexable", async () => {
    auth.getClaims.mockResolvedValue(claims(null));
    const res = await updateSession(request("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("never reads user_metadata: a role there grants nothing", async () => {
    auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "u1", aal: "aal2", app_metadata: {}, user_metadata: { role: "partner" } } },
      error: null,
    });
    const res = await updateSession(request("/dashboard"));
    expect(res.headers.get("location")).toBe("https://crm.twchartered.com/no-access");
  });

  it("passes a verified Partner through and starts the activity clock", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "partner" }, "aal2"));
    const res = await updateSession(request("/dashboard"));
    expect(res.headers.get("location")).toBeNull();
    const activity = res.cookies.get(ACTIVITY_COOKIE);
    expect(activity?.value).toMatch(/^[0-9]{13}$/);
    expect(activity?.httpOnly).toBe(true);
    expect(activity?.secure).toBe(true);
    expect(activity?.sameSite).toBe("lax");
  });

  it("sends a Manager at aal1 to /mfa", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "manager" }, "aal1"));
    const res = await updateSession(request("/work"));
    expect(res.headers.get("location")).toBe("https://crm.twchartered.com/mfa?next=%2Fwork");
  });

  it("sends an Employee who turned on two-step sign-in to /mfa, from the stored session's factors", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "employee" }, "aal1"));
    expect((await updateSession(request("/my-day"))).headers.get("location")).toBeNull();
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "t", user: { id: "u1", factors: [{ status: "verified" }] } } }, error: null });
    expect((await updateSession(request("/my-day"))).headers.get("location")).toBe("https://crm.twchartered.com/mfa?next=%2Fmy-day");
  });

  it("doesn't read the stored session for a role that always needs the second step", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "manager" }, "aal1"));
    await updateSession(request("/work"));
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("sends a temporary password to /set-password", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "employee", must_change_password: true }, "aal1"));
    const res = await updateSession(request("/my-day"));
    expect(res.headers.get("location")).toBe("https://crm.twchartered.com/set-password");
  });

  it("revokes an idle session and clears its cookies", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "client" }, "aal1"));
    const threeHoursAgo = String(Date.now() - 3 * 60 * 60 * 1000);
    const res = await updateSession(
      request("/portal/invoices", { cookies: { [ACTIVITY_COOKIE]: threeHoursAgo, "sb-example-auth-token": "token" } }),
    );
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(res.headers.get("location")).toBe("https://crm.twchartered.com/login?next=%2Fportal%2Finvoices&reason=idle");
    expect(res.cookies.get("sb-example-auth-token")?.value).toBe("");
    expect(res.cookies.get(ACTIVITY_COOKIE)?.value).toBe("");
  });

  it("does not let API calls keep a session alive", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "employee" }, "aal1"));
    const res = await updateSession(request("/api/presence/heartbeat", { method: "POST" }));
    expect(res.cookies.get(ACTIVITY_COOKIE)).toBeUndefined();
  });

  it("tells pages which path is being rendered, overwriting anything the client sent", async () => {
    auth.getClaims.mockResolvedValue(claims({ role: "partner" }, "aal2"));
    const req = request("/clients?tab=tasks", { headers: { "x-tw-path": "https://evil.example" } });
    await updateSession(req);
    expect(req.headers.get("x-tw-path")).toBe("/clients?tab=tasks");
  });

  it("skips Supabase entirely for machine endpoints", async () => {
    const res = await updateSession(request("/api/cron/receivables"));
    expect(auth.getClaims).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });

  it("treats a failed session check as signed out, not as a crash", async () => {
    auth.getClaims.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await updateSession(request("/dashboard"));
    expect(res.headers.get("location")).toBe("https://crm.twchartered.com/login?next=%2Fdashboard");
  });
});

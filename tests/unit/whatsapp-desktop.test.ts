import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The TaxWise Desktop API's shared checks (server/desktop.ts, docs/DESKTOP-API.md and its security
 * review additions): a removed PC is refused 403 device_revoked BEFORE any session check (even
 * signed out), only TaxWise Desktop may call, 401 without a session and never a redirect, 403 for
 * portal users, temporary passwords and unverified Partners/Managers, Cache-Control no-store and
 * JSON on every answer.
 */

const state = vi.hoisted(() => ({
  revokedKeys: new Set<string>(),
  revokedLookups: 0,
  sessionCalls: 0,
  session: null as unknown,
  aal: { currentLevel: "aal2", nextLevel: "aal2" } as { currentLevel: string; nextLevel: string },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({ log: vi.fn(), logUnexpected: vi.fn(() => "REF12345") }));
vi.mock("@/lib/env", () => ({ env: { appUrl: () => "https://crm.twchartered.com" } }));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let keys: string[] = [];
      const q = {
        select: () => q,
        in: (_c: string, k: string[]) => {
          keys = k;
          return q;
        },
        not: () => q,
        limit: async () => {
          state.revokedLookups += 1;
          return { data: keys.filter((k) => state.revokedKeys.has(k)).map((k) => ({ id: k })), error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getSession: vi.fn(async () => {
    state.sessionCalls += 1;
    return state.session;
  }),
}));

import { NextRequest } from "next/server";
import { z } from "zod";
import { DesktopRefusal, handleDesktop, refuseUnlessOk } from "@/server/desktop";

const KEY = "c".repeat(64);
const OTHER = "d".repeat(64);
const ORIGIN = "https://crm.twchartered.com";

function supabaseFor(aal = state.aal) {
  return { auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error: null }) } } };
}

function staff(role: "partner" | "manager" | "employee" | "client", over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    supabase: supabaseFor(),
    user: { id: "u1", email: "a@b.c", role, fullName: "Anita Desai", isActive: true, mustChangePassword: false, employeeId: "e1", vaultAccess: false, preferences: {}, ...over },
  };
}

function req(method: "GET" | "POST", opts: { headers?: Record<string, string>; body?: unknown; path?: string } = {}) {
  const headers: Record<string, string> = { "x-taxwise-desktop": "1.4.0", "x-taxwise-device": KEY, origin: ORIGIN, ...(opts.headers ?? {}) };
  if (method === "POST") headers["content-type"] = headers["content-type"] ?? "application/json";
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  return new NextRequest(`${ORIGIN}${opts.path ?? "/api/desktop/context"}`, {
    method,
    headers,
    body: method === "POST" ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {})) : undefined,
  });
}

async function answer(res: Response) {
  return { status: res.status, cache: res.headers.get("cache-control"), type: res.headers.get("content-type"), body: (await res.json()) as Record<string, unknown> };
}

const ok = async () => ({ fine: true });

beforeEach(() => {
  state.revokedKeys.clear();
  state.revokedLookups = 0;
  state.sessionCalls = 0;
  state.aal = { currentLevel: "aal2", nextLevel: "aal2" };
  state.session = staff("employee");
});

describe("revocation comes first (security review addition 1)", () => {
  it("refuses a removed PC with 403 device_revoked even when nobody is signed in", async () => {
    state.revokedKeys.add(KEY);
    state.session = { status: "anonymous" };
    const a = await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok));
    expect(a).toMatchObject({ status: 403, cache: "no-store", body: { ok: false, error: "This PC was removed from TaxWise.", code: "device_revoked" } });
    expect(state.sessionCalls).toBe(0);
  });

  it("checks the body's deviceKey too", async () => {
    state.revokedKeys.add(OTHER);
    const a = await answer(await handleDesktop(req("POST", { body: { deviceKey: OTHER } }), { source: "t", schema: null }, ok));
    expect(a.body.code).toBe("device_revoked");
    expect(state.sessionCalls).toBe(0);
  });

  it("refuses revoked before the app headers are even checked", async () => {
    state.revokedKeys.add(KEY);
    const a = await answer(await handleDesktop(req("GET", { headers: { "x-taxwise-desktop": "" } }), { source: "t", schema: null }, ok));
    expect(a.body.code).toBe("device_revoked");
  });
});

describe("only TaxWise Desktop", () => {
  it("requires X-TaxWise-Desktop and a 64-hex X-TaxWise-Device", async () => {
    const noApp = await answer(await handleDesktop(req("GET", { headers: { "x-taxwise-desktop": "" } }), { source: "t", schema: null }, ok));
    expect(noApp).toMatchObject({ status: 403, body: { code: "forbidden" } });
    const badKey = await answer(await handleDesktop(req("GET", { headers: { "x-taxwise-device": "ABC" } }), { source: "t", schema: null }, ok));
    expect(badKey).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(state.sessionCalls).toBe(0);
  });

  it("refuses a body key that isn't the header's, a foreign Origin, and a body that isn't JSON", async () => {
    const mismatch = await answer(await handleDesktop(req("POST", { body: { deviceKey: OTHER } }), { source: "t", schema: null }, ok));
    expect(mismatch).toMatchObject({ status: 403, body: { code: "forbidden" } });
    const foreign = await answer(await handleDesktop(req("POST", { headers: { origin: "https://evil.example" }, body: {} }), { source: "t", schema: null }, ok));
    expect(foreign).toMatchObject({ status: 403, body: { code: "forbidden" } });
    const noOrigin = await answer(await handleDesktop(req("POST", { headers: { origin: "" }, body: {} }), { source: "t", schema: null }, ok));
    expect(noOrigin.status).toBe(403);
    const broken = await answer(await handleDesktop(req("POST", { body: "{not json" }), { source: "t", schema: null }, ok));
    expect(broken).toMatchObject({ status: 400, body: { code: "validation" } });
  });
});

describe("the session", () => {
  it("answers 401 without a session, never a redirect", async () => {
    state.session = { status: "anonymous" };
    const res = await handleDesktop(req("GET"), { source: "t", schema: null }, ok);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect((await answer(res)).body).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("refuses portal users, disabled accounts and temporary passwords", async () => {
    state.session = staff("client");
    expect((await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok))).body.code).toBe("forbidden");
    state.session = { status: "inactive", authUserId: "u" };
    expect((await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok))).status).toBe(403);
    state.session = staff("employee", { mustChangePassword: true });
    expect((await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok))).body.code).toBe("must_change_password");
  });

  it("applies the two-step sign-in gate to Partners and Managers", async () => {
    state.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    state.session = { ...staff("manager"), supabase: supabaseFor({ currentLevel: "aal1", nextLevel: "aal2" }) };
    expect((await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok))).body.code).toBe("mfa_required");
    state.session = { ...staff("employee"), supabase: supabaseFor({ currentLevel: "aal1", nextLevel: "aal1" }) };
    expect((await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok))).status).toBe(200);
  });
});

describe("answers", () => {
  it("wraps data as { ok: true, data } with no-store JSON", async () => {
    const a = await answer(await handleDesktop(req("GET"), { source: "t", schema: null }, ok));
    expect(a).toEqual({ status: 200, cache: "no-store", type: "application/json; charset=utf-8", body: { ok: true, data: { fine: true } } });
  });

  it("validates the body with the route's schema", async () => {
    const schema = z.object({ clientId: z.uuid({ error: "That client doesn't exist." }) });
    const bad = await answer(await handleDesktop(req("POST", { body: { clientId: "x" } }), { source: "t", schema }, ok));
    expect(bad).toMatchObject({ status: 400, body: { ok: false, error: "That client doesn't exist.", code: "validation" } });
    const seen: unknown[] = [];
    await handleDesktop(req("POST", { body: { clientId: "11111111-1111-4111-8111-111111111111" } }), { source: "t", schema }, async (ctx) => {
      seen.push(ctx.body, ctx.deviceKey, ctx.appVersion);
      return {};
    });
    expect(seen).toEqual([{ clientId: "11111111-1111-4111-8111-111111111111" }, KEY, "1.4.0"]);
  });

  it("turns refusals into their status, and anything else into 500 with a Ref", async () => {
    const refused = await answer(
      await handleDesktop(req("GET"), { source: "t", schema: null }, async () => {
        throw new DesktopRefusal(409, "no_group", "XYZ Traders has no WhatsApp group yet.");
      }),
    );
    expect(refused).toMatchObject({ status: 409, cache: "no-store", body: { ok: false, error: "XYZ Traders has no WhatsApp group yet.", code: "no_group" } });
    const crashed = await answer(
      await handleDesktop(req("GET"), { source: "t", schema: null }, async () => {
        throw new Error("boom");
      }),
    );
    expect(crashed).toMatchObject({ status: 500, body: { ok: false, ref: "REF12345" } });
  });

  it("maps the database functions' statuses", () => {
    expect(() => refuseUnlessOk({ status: "ok" })).not.toThrow();
    expect(() => refuseUnlessOk({ status: "revoked" })).toThrow(expect.objectContaining({ status: 403, code: "device_revoked" }));
    expect(() => refuseUnlessOk({ status: "not_found", error: "Not checked in." })).toThrow(expect.objectContaining({ status: 404, code: "not_found", message: "Not checked in." }));
    expect(() => refuseUnlessOk({ status: "forbidden" })).toThrow(expect.objectContaining({ status: 403, code: "forbidden" }));
    expect(() => refuseUnlessOk(null)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { createDesktopApi, interpretResponse } from "../src/main/api";
import { parseOpenData } from "../src/main/contract";

const KEY = "ab".repeat(32);
const ok = (data: unknown) => ({ ok: true, data });

function fakeFetch(status: number, body: unknown, contentType = "application/json") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, headers: new Headers({ "content-type": contentType }), json: async () => body };
  };
  return { fetch, calls };
}

describe("interpreting desktop API responses", () => {
  const any = (d: unknown) => d;
  it("401 or a redirect to sign-in → signed out (hide the panel)", () => {
    expect(interpretResponse(401, { ok: false, error: "Sign in" }, any)).toEqual({ kind: "signed-out" });
    expect(interpretResponse(307, null, any)).toEqual({ kind: "signed-out" });
    expect(interpretResponse(0, null, any)).toEqual({ kind: "signed-out" });
  });

  it("403 device_revoked → revoked (wipe WhatsApp, removed-PC screen)", () => {
    expect(interpretResponse(403, { ok: false, error: "This PC was removed.", code: "device_revoked" }, any)).toEqual({ kind: "revoked" });
  });

  it("any other 403 is a refusal, never a wipe", () => {
    expect(interpretResponse(403, { ok: false, error: "You can't open this client's WhatsApp.", code: "forbidden" }, any)).toEqual({
      kind: "refused",
      status: 403,
      message: "You can't open this client's WhatsApp.",
      code: "forbidden",
    });
    expect(interpretResponse(403, null, any).kind).toBe("refused");
  });

  it("ok → data; a 5xx carries the Ref", () => {
    expect(interpretResponse(200, ok({ a: 1 }), any)).toEqual({ kind: "ok", data: { a: 1 } });
    expect(interpretResponse(500, { ok: false, error: "Something went wrong.", ref: "K7Q2M9XA" }, any)).toEqual({
      kind: "error",
      message: "Something went wrong.",
      ref: "K7Q2M9XA",
    });
    expect(interpretResponse(200, ok({ bad: true }), () => null).kind).toBe("error");
  });
});

describe("calling the API with the CRM session's cookies", () => {
  it("never sends a page token; uses the session's credentials, no caching, no redirects", async () => {
    const f = fakeFetch(200, ok({ groupName: "TW · TW-C-0142 · XYZ Traders", numberId: "n-staff", inviteCode: "AbCdEfGhIjKlMnOpQrStUv" }));
    const api = createDesktopApi({ fetch: f.fetch, appOrigin: "https://app.twchartered.com", deviceKey: KEY, appVersion: "0.1.0" });
    const r = await api.openWhatsApp("c-xyz");
    expect(r).toEqual({ kind: "ok", data: { groupName: "TW · TW-C-0142 · XYZ Traders", numberId: "n-staff", inviteCode: "AbCdEfGhIjKlMnOpQrStUv", clientName: null } });
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://app.twchartered.com/api/desktop/whatsapp/open");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-TaxWise-Device"]).toBe(KEY);
    expect(headers["X-TaxWise-Desktop"]).toBe("0.1.0");
    expect(headers.Origin).toBe("https://app.twchartered.com");
    expect(JSON.parse(init.body as string)).toEqual({ clientId: "c-xyz" });
  });

  it("sends each endpoint's body exactly", async () => {
    const f = fakeFetch(200, ok({}));
    const api = createDesktopApi({ fetch: f.fetch, appOrigin: "https://app.twchartered.com", deviceKey: KEY, appVersion: "0.1.0" });
    await api.checkin({ deviceName: "FRONTDESK-2", os: "Windows 10.0", appVersion: "0.1.0" });
    await api.link("n-staff", true);
    await api.health(["searchBox"]);
    await api.accessDenied("n-staff", "TW · TW-C-0201 · Patel Builders");
    const sent = f.calls.map((c) => [c.url.replace("https://app.twchartered.com", ""), JSON.parse(c.init.body as string)]);
    expect(sent).toEqual([
      ["/api/desktop/devices/checkin", { deviceKey: KEY, deviceName: "FRONTDESK-2", os: "Windows 10.0", appVersion: "0.1.0" }],
      ["/api/desktop/devices/link", { deviceKey: KEY, numberId: "n-staff", linked: true }],
      ["/api/desktop/health", { deviceKey: KEY, failing: ["searchBox"] }],
      ["/api/desktop/access-denied", { deviceKey: KEY, numberId: "n-staff", chatTitle: "TW · TW-C-0201 · Patel Builders" }],
    ]);
  });

  it("GET /context has no body", async () => {
    const f = fakeFetch(401, { ok: false, error: "Sign in" });
    const api = createDesktopApi({ fetch: f.fetch, appOrigin: "https://app.twchartered.com", deviceKey: KEY, appVersion: "0.1.0" });
    expect(await api.getContext()).toEqual({ kind: "signed-out" });
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(f.calls[0]!.init.body).toBeUndefined();
  });

  it("a network failure is an error, not a sign-out", async () => {
    const api = createDesktopApi({
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
      appOrigin: "https://app.twchartered.com",
      deviceKey: KEY,
      appVersion: "0.1.0",
    });
    expect((await api.getContext()).kind).toBe("error");
  });

  it("an HTML page (e.g. a login page) is not taken as data", async () => {
    const f = fakeFetch(200, null, "text/html");
    const api = createDesktopApi({ fetch: f.fetch, appOrigin: "https://app.twchartered.com", deviceKey: KEY, appVersion: "0.1.0" });
    expect((await api.getContext()).kind).toBe("refused");
  });
});

describe("POST /api/desktop/whatsapp/open data", () => {
  it("keeps a valid invite code for the main process and drops anything else", () => {
    expect(parseOpenData({ groupName: "G", numberId: "n1", inviteCode: "AbCdEfGhIjKlMnOpQrStUv" })?.inviteCode).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(parseOpenData({ groupName: "G", numberId: "n1", inviteCode: "https://chat.whatsapp.com/x" })?.inviteCode).toBeNull();
    expect(parseOpenData({ groupName: "G", numberId: "../n1" })).toBeNull();
    expect(parseOpenData({ numberId: "n1" })).toBeNull();
  });
});

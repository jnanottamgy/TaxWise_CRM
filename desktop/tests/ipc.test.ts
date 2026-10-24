import { describe, expect, it } from "vitest";
import { expectedOrigin, isAllowedSender, registerInvoke, registerSend, type SenderRules } from "../src/main/ipc";
import { ViewRegistry } from "../src/main/registry";
import { INVOKE, PayloadError, readArg, SEND } from "../src/shared/channels";
import { preloadMayRun } from "../src/shared/url";

const APP = "https://app.twchartered.com";
const registry = new ViewRegistry();
registry.add("crm", 1);
registry.add("whatsapp", 2, "n-staff");
registry.add("panel", 3);
const rules: SenderRules = { appOrigin: APP, isKnownWebContents: (k, id) => registry.isKnown(k, id) };

describe("IPC sender validation (§7.25.3)", () => {
  it("accepts each view's own main frame at its own origin", () => {
    expect(isAllowedSender("crm", { url: `${APP}/clients/42`, isMainFrame: true, webContentsId: 1 }, rules)).toBe(true);
    expect(isAllowedSender("whatsapp", { url: "https://web.whatsapp.com/", isMainFrame: true, webContentsId: 2 }, rules)).toBe(true);
    expect(isAllowedSender("panel", { url: "taxwise://panel/panel-header.html", isMainFrame: true, webContentsId: 3 }, rules)).toBe(true);
  });

  it("refuses another origin in the right view (e.g. the CRM view after a bad navigation)", () => {
    expect(isAllowedSender("crm", { url: "https://evil.example/", isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
    expect(isAllowedSender("crm", { url: "http://app.twchartered.com/", isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
    expect(isAllowedSender("whatsapp", { url: "https://web.whatsapp.com.evil.example/", isMainFrame: true, webContentsId: 2 }, rules)).toBe(false);
    expect(isAllowedSender("panel", { url: "taxwise://other/panel-header.html", isMainFrame: true, webContentsId: 3 }, rules)).toBe(false);
    expect(isAllowedSender("panel", { url: "file:///panel-header.html", isMainFrame: true, webContentsId: 3 }, rules)).toBe(false);
  });

  it("refuses a blob: document in the right view, though its creator was that origin", () => {
    expect(isAllowedSender("crm", { url: `blob:${APP}/6a1f0c4e-1111-4000-8000-000000000001`, isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
    expect(isAllowedSender("whatsapp", { url: "blob:https://web.whatsapp.com/6a1f0c4e", isMainFrame: true, webContentsId: 2 }, rules)).toBe(false);
    expect(isAllowedSender("crm", { url: `filesystem:${APP}/temporary/x`, isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
  });

  it("refuses subframes (an iframe in the CRM or in WhatsApp)", () => {
    expect(isAllowedSender("crm", { url: `${APP}/`, isMainFrame: false, webContentsId: 1 }, rules)).toBe(false);
    expect(isAllowedSender("whatsapp", { url: "https://web.whatsapp.com/", isMainFrame: false, webContentsId: 2 }, rules)).toBe(false);
  });

  it("refuses the right origin from the wrong view (WhatsApp calling CRM channels, or vice versa)", () => {
    expect(isAllowedSender("crm", { url: `${APP}/`, isMainFrame: true, webContentsId: 2 }, rules)).toBe(false);
    expect(isAllowedSender("whatsapp", { url: "https://web.whatsapp.com/", isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
    expect(isAllowedSender("crm", { url: `${APP}/`, isMainFrame: true, webContentsId: 99 }, rules)).toBe(false);
  });

  it("refuses a gone frame or a junk URL", () => {
    expect(isAllowedSender("crm", { url: null, isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
    expect(isAllowedSender("crm", { url: "::::", isMainFrame: true, webContentsId: 1 }, rules)).toBe(false);
  });

  it("knows each kind's origin", () => {
    expect(expectedOrigin("crm", APP)).toBe(APP);
    expect(expectedOrigin("whatsapp", APP)).toBe("https://web.whatsapp.com");
    expect(expectedOrigin("panel", APP)).toBe("taxwise://panel");
  });
});

describe("where a preload sets itself up", () => {
  it("on the pages each view must show", () => {
    expect(preloadMayRun(`${APP}/clients/42`)).toBe(true);
    expect(preloadMayRun("http://127.0.0.1:3000/")).toBe(true); // a development CRM
    expect(preloadMayRun("https://web.whatsapp.com/send?phone=919845012345")).toBe(true);
    expect(preloadMayRun("taxwise://panel/panel-header.html")).toBe(true);
  });

  it("never in a view's initial empty document, a file, or an error page", () => {
    expect(preloadMayRun("about:blank")).toBe(false);
    expect(preloadMayRun("")).toBe(false);
    expect(preloadMayRun(`blob:${APP}/6a1f0c4e-1111-4000-8000-000000000001`)).toBe(false);
    expect(preloadMayRun("data:text/html,<h1>x</h1>")).toBe(false);
    expect(preloadMayRun("chrome-error://chromewebdata/")).toBe(false);
    expect(preloadMayRun("file:///C:/Users/x/invoice.html")).toBe(false);
  });
});

type Handler = (event: unknown, payload: unknown) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    ipc: {
      handle: (ch: string, h: Handler) => void handlers.set(ch, h),
      on: (ch: string, h: Handler) => void handlers.set(ch, h),
    },
  };
}

const event = (url: string | null, id: number, mainFrame = true) => ({
  sender: { id },
  senderFrame: url === null ? null : { url, parent: mainFrame ? null : {} },
});

describe("registered handlers", () => {
  it("run only for the allowed sender, with a validated payload", async () => {
    const { ipc, handlers } = fakeIpc();
    const log: string[] = [];
    const calls: string[] = [];
    registerInvoke(ipc as never, "crm:open-client-chat", rules, (m) => log.push(m), ({ clientId }) => {
      calls.push(clientId);
      return { ok: true };
    });
    const h = handlers.get("crm:open-client-chat")!;
    await expect(h(event(`${APP}/clients/1`, 1), { clientId: "3f1c2b9e-0000-4000-8000-000000000001" })).resolves.toEqual({ ok: true });
    await expect(h(event("https://web.whatsapp.com/", 2), { clientId: "c1" })).rejects.toThrow("Not allowed");
    await expect(h(event(`${APP}/`, 1, false), { clientId: "c1" })).rejects.toThrow("Not allowed");
    await expect(h(event(`${APP}/`, 1), { clientId: "../../etc" })).rejects.toThrow("Bad request");
    await expect(h(event(`${APP}/`, 1), { clientId: "x".repeat(65) })).rejects.toThrow("Bad request");
    await expect(h(event(`${APP}/`, 1), "c1")).rejects.toThrow("Bad request");
    expect(calls).toEqual(["3f1c2b9e-0000-4000-8000-000000000001"]);
    expect(log).toContain("ipc: refused sender");
  });

  it("one-way messages from the wrong sender are dropped", () => {
    const { ipc, handlers } = fakeIpc();
    const got: unknown[] = [];
    registerSend(ipc as never, "wa:access-denied", rules, () => undefined, (p) => got.push(p));
    const h = handlers.get("wa:access-denied")!;
    h(event("https://web.whatsapp.com/", 2), { title: "X" });
    h(event(`${APP}/`, 1), { title: "Y" });
    h(event("https://web.whatsapp.com/", 2), { title: 42 });
    expect(got).toEqual([{ title: "X" }]);
  });
});

describe("typed channels", () => {
  it("every channel names exactly one sender kind", () => {
    for (const [name, spec] of Object.entries({ ...INVOKE, ...SEND })) {
      expect(["crm", "whatsapp", "panel"], name).toContain(spec.sender);
      expect(name.split(":")[0], name).toBe(spec.sender === "whatsapp" ? "wa" : spec.sender);
    }
  });

  it("validators refuse wrong shapes", () => {
    expect(() => SEND["panel:drag"].parse({ phase: "fly", screenX: 1 })).toThrow(PayloadError);
    expect(() => SEND["panel:drag"].parse({ phase: "move", screenX: Number.NaN })).toThrow(PayloadError);
    expect(SEND["panel:drag"].parse({ phase: "move", screenX: 812 })).toEqual({ phase: "move", screenX: 812 });
    expect(() => SEND["wa:selectors"].parse({ ok: false, failing: ["search box!"] })).toThrow(PayloadError);
    expect(() => SEND["wa:page-state"].parse({ state: "hacked", userAgent: null })).toThrow(PayloadError);
    expect(() => INVOKE["crm:toggle-whatsapp"].parse({ anything: true })).toThrow(PayloadError);
    expect(INVOKE["crm:toggle-whatsapp"].parse(undefined)).toBeUndefined();
  });

  it("reads preload arguments", () => {
    expect(readArg(["electron", "--taxwise-version=0.1.0"], "--taxwise-version=")).toBe("0.1.0");
    expect(readArg([], "--taxwise-version=")).toBeNull();
  });
});

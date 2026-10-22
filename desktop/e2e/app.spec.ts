/**
 * TaxWise Desktop end-to-end (§14): the bridge, the navigation and new-window guards, the
 * permission handlers, and client mode against a WhatsApp Web fixture (never the live WhatsApp).
 * Runs in CI with the Electron binary installed: `npm run e2e` (Linux needs xvfb-run).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PATEL, startMockCrm, XYZ, type MockState } from "./mock-crm";

const ROOT = join(__dirname, "..");

interface Harness {
  app: ElectronApplication;
  crm: Page;
  state: MockState;
  crmUrl: string;
  cleanup(): Promise<void>;
}

async function launch(setup: (s: MockState) => void = () => undefined): Promise<Harness> {
  const server = await startMockCrm();
  setup(server.state);
  const userData = mkdtempSync(join(tmpdir(), "taxwise-e2e-"));
  const app = await electron.launch({
    // The package folder, so app.getVersion() and the app path come from desktop/package.json.
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      TAXWISE_APP_URL: server.url,
      TAXWISE_USER_DATA_DIR: userData,
      TAXWISE_E2E_WHATSAPP_FIXTURES: join(ROOT, "e2e/fixtures"),
    },
  });
  // Record external opens instead of starting a browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const crm = await pageWhere(app, (u) => u.startsWith(server.url));
  await crm.waitForLoadState("domcontentloaded");
  return {
    app,
    crm,
    state: server.state,
    crmUrl: server.url,
    cleanup: async () => {
      await app.close();
      await server.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

async function pageWhere(app: ElectronApplication, pred: (url: string) => boolean, timeoutMs = 20_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = app.windows().find((p) => pred(p.url()));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("No page matched");
}

const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.slice());
const isWhatsApp = (u: string) => u.startsWith("https://web.whatsapp.com/");

let h: Harness | null = null;
test.afterEach(async () => {
  await h?.cleanup();
  h = null;
});

test.describe("the bridge (§7.25.1)", () => {
  test("exposes exactly version, openClientChat, toggleWhatsApp, refreshContext and onDownload", async () => {
    h = await launch();
    const shape = await h.crm.evaluate(() => {
      const b = (window as unknown as { taxwiseDesktop: Record<string, unknown> }).taxwiseDesktop;
      return {
        keys: Object.keys(b).sort(),
        version: typeof b.version,
        fns: ["openClientChat", "toggleWhatsApp", "refreshContext", "onDownload"].map((k) => typeof b[k]),
        node: [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process],
      };
    });
    expect(shape.keys).toEqual(["onDownload", "openClientChat", "refreshContext", "toggleWhatsApp", "version"]);
    expect(shape.version).toBe("string");
    expect(shape.fns).toEqual(["function", "function", "function", "function"]);
    expect(shape.node).toEqual(["undefined", "undefined"]);
  });

  test("nothing leaks into WhatsApp's page", async () => {
    h = await launch();
    const wa = await pageWhere(h.app, isWhatsApp);
    const leaked = await wa.evaluate(() => [typeof (window as unknown as { taxwiseDesktop?: unknown }).taxwiseDesktop, typeof (window as unknown as { require?: unknown }).require]);
    expect(leaked).toEqual(["undefined", "undefined"]);
  });

  test("refuses a bad client id without calling the API", async () => {
    h = await launch();
    const r = await h.crm.evaluate(() => (window as unknown as { taxwiseDesktop: { openClientChat(id: string): Promise<unknown> } }).taxwiseDesktop.openClientChat("../../x"));
    expect(r).toEqual({ ok: false, error: "That client id isn't valid." });
    expect(h.state.requests.some((q) => q.path === "/api/desktop/whatsapp/open")).toBe(false);
  });
});

test.describe("navigation and new-window guards (§7.25.3)", () => {
  test("the CRM stays on its origin; https links open in the system browser; http is refused", async () => {
    h = await launch();
    await h.crm.click("#ext");
    await expect.poll(() => opened(h!.app)).toContain("https://example.com/");
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
    await h.crm.click("#insecure");
    await h.crm.waitForTimeout(500);
    expect(await opened(h.app)).not.toContain("http://example.com/");
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
  });

  test("window.open and target=_blank never create a window", async () => {
    h = await launch();
    const before = await h.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    const result = await h.crm.evaluate(() => window.open("https://example.com/popup") === null);
    await h.crm.click("#blank");
    await h.crm.waitForTimeout(500);
    expect(result).toBe(true);
    expect(await h.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(before);
    expect(await opened(h.app)).toEqual(expect.arrayContaining(["https://example.com/popup", "https://example.com/new"]));
  });

  test("a wa.me hand-off opens in the WhatsApp panel as web.whatsapp.com/send", async () => {
    h = await launch();
    await pageWhere(h.app, isWhatsApp);
    await h.crm.click("#wa");
    const wa = await pageWhere(h.app, (u) => u.startsWith("https://web.whatsapp.com/send?phone=919845012345"));
    expect(new URL(wa.url()).searchParams.get("text")).toContain("purchase register");
    expect(await opened(h.app)).toEqual([]);
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
  });

  test("WhatsApp can't navigate away from web.whatsapp.com", async () => {
    h = await launch();
    const wa = await pageWhere(h.app, isWhatsApp);
    await wa.evaluate(() => {
      location.href = "https://example.com/from-whatsapp";
    });
    await expect.poll(() => opened(h!.app)).toContain("https://example.com/from-whatsapp");
    expect(isWhatsApp(wa.url())).toBe(true);
  });
});

test.describe("permission handlers (§7.25.3)", () => {
  test("CRM: notifications yes, geolocation no", async () => {
    h = await launch();
    expect(await h.crm.evaluate(() => Notification.requestPermission())).toBe("granted");
    const geo = await h.crm.evaluate(
      () => new Promise<number>((resolve) => navigator.geolocation.getCurrentPosition(() => resolve(0), (e) => resolve(e.code))),
    );
    expect(geo).toBe(1); // PERMISSION_DENIED
  });

  test("WhatsApp for an Employee: no notifications, no camera", async () => {
    h = await launch((s) => (s.role = "employee"));
    const wa = await pageWhere(h.app, isWhatsApp);
    expect(await wa.evaluate(() => Notification.requestPermission())).toBe("denied");
    const camera = await wa.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "allowed", (e: Error) => e.name));
    expect(camera).not.toBe("allowed");
  });

  test("WhatsApp for a Partner: notifications allowed", async () => {
    h = await launch((s) => (s.role = "partner"));
    const wa = await pageWhere(h.app, isWhatsApp);
    expect(await wa.evaluate(() => Notification.requestPermission())).toBe("granted");
  });
});

test.describe("client mode on the WhatsApp fixture (§7.25.5, §18.3 Employee 8)", () => {
  test("Open chat shows the client's group; any other chat is closed and logged", async () => {
    h = await launch((s) => (s.role = "employee"));
    const wa = await pageWhere(h.app, isWhatsApp);
    await expect.poll(() => h!.state.requests.some((q) => q.path === "/api/desktop/devices/link")).toBe(true);

    await expect
      .poll(() => h!.crm.evaluate(() => (window as unknown as { taxwiseDesktop: { openClientChat(id: string): Promise<{ ok: boolean }> } }).taxwiseDesktop.openClientChat("c-xyz")), { timeout: 30_000 })
      .toEqual({ ok: true });
    expect(await wa.evaluate(() => document.querySelector("#main header span")?.getAttribute("title"))).toBe(XYZ);
    expect(await wa.evaluate(() => document.querySelector("#main")?.hasAttribute("data-taxwise-allowed"))).toBe(true);

    await wa.evaluate((t) => (window as unknown as { __fixture: { openChat(t: string): void } }).__fixture.openChat(t), PATEL);
    await expect.poll(() => wa.evaluate(() => document.querySelector("#main") === null)).toBe(true);
    await expect
      .poll(() => h!.state.requests.find((q) => q.path === "/api/desktop/access-denied")?.body)
      .toMatchObject({ numberId: "n-staff", chatTitle: PATEL });
  });

  test("a hand-off chat the CRM opened stays open", async () => {
    h = await launch((s) => (s.role = "employee"));
    await pageWhere(h.app, isWhatsApp);
    await expect.poll(() => h!.state.requests.some((q) => q.path === "/api/desktop/devices/link")).toBe(true);
    await h.crm.click("#wa");
    const wa = await pageWhere(h.app, (u) => u.startsWith("https://web.whatsapp.com/send"));
    await expect.poll(() => wa.evaluate(() => document.querySelector("#main")?.hasAttribute("data-taxwise-allowed") ?? false)).toBe(true);
    expect(h.state.requests.some((q) => q.path === "/api/desktop/access-denied")).toBe(false);
  });

  test("the API is called with the CRM session, the device key header and no page token", async () => {
    h = await launch();
    await expect.poll(() => h!.state.requests.some((q) => q.path === "/api/desktop/devices/checkin")).toBe(true);
    const checkin = h.state.requests.find((q) => q.path === "/api/desktop/devices/checkin")!;
    expect(checkin.headers["x-taxwise-device"]).toMatch(/^[0-9a-f]{64}$/);
    expect(checkin.headers.authorization).toBeUndefined();
    expect(checkin.body).toMatchObject({ deviceKey: checkin.headers["x-taxwise-device"], appVersion: expect.any(String) });
  });
});

test.describe("sign-out and removed PCs (§7.25.3, §7.25.7)", () => {
  test("signing out of the CRM closes WhatsApp at once", async () => {
    h = await launch();
    await pageWhere(h.app, isWhatsApp);
    h.state.role = null;
    await h.crm.goto(`${h.crmUrl}/login`);
    await expect.poll(() => h!.app.windows().some((p) => isWhatsApp(p.url()))).toBe(false);
  });

  test("a removed PC wipes WhatsApp and shows the removed-PC screen", async () => {
    h = await launch((s) => (s.revoked = true));
    const panel = await pageWhere(h.app, (u) => u.startsWith("taxwise://panel/"));
    await expect(panel.locator("text=This PC was removed from TaxWise")).toBeVisible();
    expect(h.app.windows().some((p) => isWhatsApp(p.url()))).toBe(false);
  });
});

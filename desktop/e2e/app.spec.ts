/**
 * TaxWise Desktop end-to-end (§14): the bridge, the sandbox, the navigation and new-window guards,
 * the permission handlers, which numbers each role sees, and client mode against a WhatsApp Web
 * fixture (never the live WhatsApp). Runs in CI with the Electron binary installed: `npm run e2e`
 * (Linux needs xvfb-run; see e2e/electron-launch.ts for running as root).
 */

import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createRunDir } from "./electron-launch";
import { PATEL, startMockCrm, XYZ, type MockState } from "./mock-crm";

const ROOT = join(__dirname, "..");

interface Harness {
  app: ElectronApplication;
  crm: Page;
  state: MockState;
  crmUrl: string;
  /** The app's log lines (a development build echoes its log to stdout). */
  logs: string[];
  cleanup(): Promise<void>;
}

async function launch(setup: (s: MockState) => void = () => undefined): Promise<Harness> {
  const server = await startMockCrm();
  const run = createRunDir();
  let app: ElectronApplication | null = null;
  const cleanup = async () => {
    try {
      if (app) await closeWithin(app, 20_000);
    } finally {
      await server.close();
      run.remove();
    }
  };
  try {
    setup(server.state);
    const started = await run.launch({
      // The package folder, so app.getVersion() and the app path come from desktop/package.json.
      appDir: ROOT,
      env: {
        ...process.env,
        TAXWISE_APP_URL: server.url,
        TAXWISE_USER_DATA_DIR: run.userData,
        TAXWISE_E2E_WHATSAPP_FIXTURES: join(ROOT, "e2e/fixtures"),
      },
    });
    app = started;
    const logs: string[] = [];
    let partial = "";
    started.process().stdout?.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      logs.push(...lines.filter((l) => l.trim()));
    });
    // Record external opens instead of starting a browser.
    await started.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const crm = await pageWhere(started, (u) => u.startsWith(server.url));
    await crm.waitForLoadState("domcontentloaded");
    return { app: started, crm, state: server.state, crmUrl: server.url, logs, cleanup };
  } catch (err) {
    // A start that fails never reaches afterEach: don't leave Electron, the server or the folder behind.
    await cleanup();
    throw err;
  }
}

/**
 * Quits the app as a user would (Playwright's close() calls app.quit()). If it hasn't exited in time, kills
 * its processes and fails with that, rather than letting a stuck quit use up the rest of the test's time.
 */
async function closeWithin(app: ElectronApplication, ms: number): Promise<void> {
  const child = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
  const result = await Promise.race([app.close().then(() => "closed" as const, () => "closed" as const), timedOut]);
  clearTimeout(timer);
  if (result === "closed") return;
  try {
    // Playwright starts Electron in its own process group: end the renderers too.
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  throw new Error(`TaxWise Desktop didn't quit within ${ms / 1000} s of app.quit(); its processes were killed.`);
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

/**
 * Clicks a link whose navigation the app cancels in `will-navigate` (§7.25.3: external links, http:, wa.me).
 * Electron cancels it before any request starts, so Chromium never reports that navigation as committed or
 * failed. Playwright's element actions would wait for it for ever, on this click and before every later
 * action on the page. A raw mouse click at the link is the same trusted click, without that bookkeeping.
 */
async function clickInterceptedLink(page: Page, selector: string): Promise<void> {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) throw new Error(`No element matches ${selector}`);
  await page.mouse.click(box.x, box.y);
}

interface PanelNumbers {
  /** In the switcher: usable and linked on this PC. */
  shown: string[];
  /** Offered for linking: usable, not linked here yet. */
  linkable: string[];
}

/** What the panel header offers, from the state that drives it (window.taxwisePanel, the header's bridge). */
async function panelNumbers(app: ElectronApplication): Promise<PanelNumbers> {
  const panel = await pageWhere(app, (u) => u.startsWith("taxwise://panel/"));
  return panel.evaluate(
    () =>
      new Promise<PanelNumbers>((resolve) => {
        type Option = { label: string };
        const bridge = (window as unknown as { taxwisePanel: { onState(cb: (s: { numbers: Option[]; linkable: Option[] }) => void): void } }).taxwisePanel;
        bridge.onState((s) => resolve({ shown: s.numbers.map((n) => n.label), linkable: s.linkable.map((n) => n.label) }));
      }),
  );
}

const VINAY = "CA Vinay H Karlagere (Partner)";
const MANAGERS = "Managers' office";
const STAFF = "Staff office";

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

test.describe("the sandbox (§7.25.3)", () => {
  test("every page runs in Chromium's OS sandbox (Linux: its own namespaces and a seccomp filter)", async () => {
    test.skip(process.platform !== "linux", "reads /proc");
    h = await launch((s) => (s.role = "employee"));
    await pageWhere(h.app, isWhatsApp);
    const { browserPidNs, renderers } = await h.app.evaluate(({ webContents }) => {
      // The main process is Node: read each renderer's seccomp mode (2 = filtering) and PID namespace.
      const fs = process.mainModule!.require("node:fs") as typeof import("node:fs");
      return {
        browserPidNs: fs.readlinkSync("/proc/self/ns/pid"),
        renderers: webContents.getAllWebContents().map((wc) => {
          const pid = wc.getOSProcessId();
          return {
            url: wc.getURL().split("?")[0],
            seccomp: /^Seccomp:\s*(\d)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? null,
            pidNs: fs.readlinkSync(`/proc/${pid}/ns/pid`),
          };
        }),
      };
    });
    expect(renderers.map((r) => r.url).sort()).toEqual([`${h.crmUrl}/`, "https://web.whatsapp.com/", "taxwise://panel/panel-header.html"]);
    for (const r of renderers) {
      expect(r.seccomp, r.url).toBe("2");
      expect(r.pidNs, r.url).not.toBe(browserPidNs); // --no-sandbox would leave the renderer in the browser's
    }
  });
});

test.describe("navigation and new-window guards (§7.25.3)", () => {
  test("the CRM stays on its origin; https links open in the system browser; http is refused", async () => {
    h = await launch();
    await clickInterceptedLink(h.crm, "#ext");
    await expect.poll(() => opened(h!.app)).toContain("https://example.com/");
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
    await clickInterceptedLink(h.crm, "#insecure");
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
    await clickInterceptedLink(h.crm, "#wa");
    const wa = await pageWhere(h.app, (u) => u.startsWith("https://web.whatsapp.com/send?phone=919845012345"));
    expect(new URL(wa.url()).searchParams.get("text")).toContain("purchase register");
    expect(await opened(h.app)).toEqual([]);
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
  });

  test("a blob: document can't replace the CRM page or open in it", async () => {
    h = await launch();
    await h.crm.evaluate(() => {
      const url = URL.createObjectURL(new Blob(["<h1>not the CRM</h1>"], { type: "text/html" }));
      window.open(url);
      location.href = url;
    });
    await h.crm.waitForTimeout(500);
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
    expect(await h.crm.evaluate(() => typeof (window as unknown as { taxwiseDesktop?: unknown }).taxwiseDesktop)).toBe("object");
    expect(await opened(h.app)).toEqual([]);
  });

  test("a data: document can't replace the CRM page or open in it", async () => {
    h = await launch();
    await h.crm.evaluate(() => {
      const url = "data:text/html,<h1>not the CRM</h1>";
      window.open(url);
      location.href = url;
    });
    await h.crm.waitForTimeout(500);
    expect(h.crm.url().startsWith(h.crmUrl)).toBe(true);
    expect(await h.crm.evaluate(() => typeof (window as unknown as { taxwiseDesktop?: unknown }).taxwiseDesktop)).toBe("object");
    expect(h.app.windows().some((p) => p.url().startsWith("data:"))).toBe(false);
    expect(await opened(h.app)).toEqual([]);
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

test.describe("which numbers each role sees (§7.25.4)", () => {
  // The fixture shows WhatsApp's chat list, so the first number the panel opens counts as linked here.
  test("an Employee: Staff office only", async () => {
    h = await launch((s) => (s.role = "employee"));
    await expect.poll(() => panelNumbers(h!.app)).toEqual({ shown: [STAFF], linkable: [] });
  });

  test("a Manager: Managers' office, and Staff office to link; never a Partner's number", async () => {
    h = await launch((s) => (s.role = "manager"));
    await expect.poll(() => panelNumbers(h!.app)).toEqual({ shown: [MANAGERS], linkable: [STAFF] });
  });

  test("a Partner: their own number is offered for linking, never opened by itself", async () => {
    h = await launch((s) => (s.role = "partner"));
    await expect.poll(() => panelNumbers(h!.app)).toEqual({ shown: [MANAGERS], linkable: [VINAY, STAFF] });
  });

  test("a Partner's own number never shows for anyone else, even if the server sends it", async () => {
    h = await launch((s) => {
      s.role = "manager";
      s.overshareNumbers = true;
    });
    await expect.poll(() => panelNumbers(h!.app)).toEqual({ shown: [MANAGERS], linkable: [STAFF] });

    // Another Partner on the same PC.
    h.state.role = "partner";
    h.state.employeeId = "e-other-partner";
    await h.crm.evaluate(() => (window as unknown as { taxwiseDesktop: { refreshContext(): Promise<void> } }).taxwiseDesktop.refreshContext());
    await expect.poll(() => panelNumbers(h!.app)).toEqual({ shown: [MANAGERS], linkable: [STAFF] });

    // And an Employee gets Staff office only, though the server sent all three.
    h.state.role = "employee";
    h.state.employeeId = null;
    await h.crm.evaluate(() => (window as unknown as { taxwiseDesktop: { refreshContext(): Promise<void> } }).taxwiseDesktop.refreshContext());
    await expect.poll(() => panelNumbers(h!.app)).toEqual({ shown: [STAFF], linkable: [] });
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
    await clickInterceptedLink(h.crm, "#wa");
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

  test("a normal session refuses no IPC message and never takes the user-agent fallback", async () => {
    h = await launch((s) => (s.role = "employee"));
    await pageWhere(h.app, isWhatsApp);
    await expect.poll(() => h!.state.requests.some((q) => q.path === "/api/desktop/devices/link")).toBe(true);
    await expect
      .poll(() => h!.crm.evaluate(() => (window as unknown as { taxwiseDesktop: { openClientChat(id: string): Promise<{ ok: boolean }> } }).taxwiseDesktop.openClientChat("c-xyz")), { timeout: 30_000 })
      .toEqual({ ok: true });
    await h.crm.reload();
    await h.crm.waitForTimeout(500);
    // Each view's preload also runs in that view's initial empty document; it must stay idle there, or
    // the IPC guard refuses it and the WhatsApp page reports the default Electron user agent.
    expect(h.logs.filter((l) => l.includes("ipc: refused sender"))).toEqual([]);
    expect(h.logs.filter((l) => l.includes("browser not accepted"))).toEqual([]);
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMode, FORBIDDEN_SWITCHES, forbiddenSwitches } from "../src/main/hardening";
import { acceptAdoption, inputCancelsHandoff, type PendingHandoff } from "../src/main/handoff";
import { publisherNames, startUpdater, updateTrustProblem } from "../src/main/updater";
import { resolveAppUrl } from "../src/main/app-url";
import { e2eFixtureDir } from "../src/main/e2e";
import { policy, XYZ } from "./helpers";

const source = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("production lock-down doesn't depend on the executable's name (§7.25.3 DevTools off)", () => {
  it("a release bundle is locked down even when Electron says it isn't packaged (a copy renamed to electron.exe)", () => {
    expect(buildMode(true, false)).toEqual({ lockedDown: true, devTools: false, envOverrides: false });
    expect(buildMode(true, true)).toEqual({ lockedDown: true, devTools: false, envOverrides: false });
    expect(buildMode(false, true)).toEqual({ lockedDown: true, devTools: false, envOverrides: false });
    expect(buildMode(false, false)).toEqual({ lockedDown: false, devTools: true, envOverrides: true });
  });

  it("a locked-down run takes TAXWISE_APP_URL and the WhatsApp fixtures from the bundle only", () => {
    const lockedDown = buildMode(true, false).lockedDown;
    expect((resolveAppUrl("https://app.twchartered.com", "http://localhost:3000", lockedDown) as { url: URL }).url.origin).toBe("https://app.twchartered.com");
    expect(e2eFixtureDir(lockedDown, { TAXWISE_E2E_WHATSAPP_FIXTURES: "/tmp/fixtures" })).toBeNull();
    expect(e2eFixtureDir(false, { TAXWISE_E2E_WHATSAPP_FIXTURES: "/tmp/fixtures" })).toBe("/tmp/fixtures");
  });

  it("main.ts decides everything from buildMode, and the release build bakes the flag in", () => {
    const main = source("src/main/main.ts");
    expect(main).toContain("buildMode(__TAXWISE_RELEASE__, app.isPackaged)");
    expect(main).not.toMatch(/isDev\s*=\s*!app\.isPackaged/);
    expect(main).toContain("resolveAppUrl(__TAXWISE_APP_URL__, process.env.TAXWISE_APP_URL, mode.lockedDown)");
    expect(main).toContain("e2eFixtureDir(mode.lockedDown, process.env)");
    expect(main).toMatch(/if \(mode\.envOverrides && process\.env\.TAXWISE_USER_DATA_DIR\)/);
    expect(source("scripts/build.mjs")).toContain("__TAXWISE_RELEASE__: JSON.stringify(release)");
  });
});

describe("debugging switches on a locked-down run", () => {
  it("finds remote debugging, the inspector and security-off switches in every spelling Chromium accepts", () => {
    expect(forbiddenSwitches(["C:\\Program Files\\TaxWise Desktop\\TaxWise Desktop.exe", "--remote-debugging-port=9222"])).toEqual(["remote-debugging-port"]);
    expect(forbiddenSwitches(["app", "--remote-debugging-pipe"])).toEqual(["remote-debugging-pipe"]);
    expect(forbiddenSwitches(["app", "/remote-debugging-port=9222"])).toEqual(["remote-debugging-port"]);
    expect(forbiddenSwitches(["app", "-Remote-Debugging-Port=9222"])).toEqual(["remote-debugging-port"]);
    expect(forbiddenSwitches(["app", "--inspect=9229", "--inspect-brk", "--js-flags=--allow-natives-syntax"])).toEqual(["inspect", "inspect-brk", "js-flags"]);
    expect(forbiddenSwitches(["app", "--disable-web-security", "--ignore-certificate-errors", "--host-resolver-rules=MAP web.whatsapp.com 127.0.0.1"])).toEqual([
      "disable-web-security",
      "host-resolver-rules",
      "ignore-certificate-errors",
    ]);
  });

  it("finds the switches that weaken the Chromium sandbox, which app.enableSandbox() doesn't undo", () => {
    expect(forbiddenSwitches(["TaxWise Desktop.exe", "--no-sandbox"])).toEqual(["no-sandbox"]);
    expect(forbiddenSwitches(["app", "/no-sandbox"])).toEqual(["no-sandbox"]);
    expect(forbiddenSwitches(["app", "--single-process", "--disable-gpu-sandbox", "--no-zygote-sandbox"])).toEqual([
      "disable-gpu-sandbox",
      "no-zygote-sandbox",
      "single-process",
    ]);
    expect(forbiddenSwitches(["app", "--disable-seccomp-filter-sandbox", "--disable-namespace-sandbox", "--disable-setuid-sandbox"])).toEqual([
      "disable-namespace-sandbox",
      "disable-seccomp-filter-sandbox",
      "disable-setuid-sandbox",
    ]);
  });

  it("leaves ordinary arguments alone", () => {
    expect(forbiddenSwitches(["/Applications/TaxWise Desktop.app/Contents/MacOS/TaxWise Desktop", "--lang=en-IN", "--remote-debugging", "--inspector"])).toEqual([]);
    expect(forbiddenSwitches(["app", "remote-debugging-port=9222"])).toEqual([]);
    expect(forbiddenSwitches(["app", "--enable-sandbox", "--sandbox"])).toEqual([]);
  });

  it("main.ts refuses them before any page exists, and only when locked down (Playwright needs them in development)", () => {
    const main = source("src/main/main.ts");
    expect(main).toMatch(/const refusedSwitches = mode\.lockedDown\s*\?/);
    expect(main).toMatch(/if \(refusedSwitches\.length > 0\) \{[\s\S]*?app\.exit\(1\);/);
    expect(FORBIDDEN_SWITCHES).toContain("remote-debugging-port");
  });
});

describe("hand-offs in client mode can't adopt the wrong chat (§7.25.5)", () => {
  const now = Date.UTC(2026, 9, 22, 6);
  const pending: PendingHandoff = { numberId: "n-staff", phoneDigits: "919845012345", armedAt: now - 1000, expiresAt: now + 59_000, committed: true };
  const live = policy({ pendingHandoff: { phoneDigits: pending.phoneDigits, expiresAt: pending.expiresAt } });

  it("accepts the hand-off's chat on the hand-off's number while it is pending", () => {
    expect(acceptAdoption(pending, "n-staff", "+91 98450 12345", live, now)).toBe(true);
    expect(acceptAdoption(pending, "n-staff", "XYZ Traders – Ramesh (Director)", live, now)).toBe(true);
  });

  it("refuses a chat opened from the page that was showing before the hand-off's own page loaded", () => {
    expect(acceptAdoption({ ...pending, committed: false }, "n-staff", "+91 98450 12345", live, now)).toBe(false);
  });

  it("refuses when nothing is pending, it expired, or it came from another number's view", () => {
    expect(acceptAdoption(null, "n-staff", "+91 98450 12345", policy(), now)).toBe(false);
    expect(acceptAdoption(pending, "n-staff", "+91 98450 12345", live, now + 59_001)).toBe(false);
    expect(acceptAdoption(pending, "n-managers", "+91 98450 12345", live, now)).toBe(false);
    expect(acceptAdoption(pending, null, "+91 98450 12345", live, now)).toBe(false);
  });

  it("refuses a different unsaved number, and anything once the policy has no hand-off (stale context)", () => {
    expect(acceptAdoption(pending, "n-staff", "+91 99999 00000", live, now)).toBe(false);
    expect(acceptAdoption(pending, "n-staff", "+91 98450 12345", policy(), now)).toBe(false);
    expect(acceptAdoption(pending, "n-staff", XYZ, live, now)).toBe(false); // already allowed: nothing to adopt
  });

  it("any keystroke into WhatsApp cancels a pending hand-off (next-chat and search shortcuts)", () => {
    expect(inputCancelsHandoff({ type: "keyDown" })).toBe(true);
    expect(inputCancelsHandoff({ type: "rawKeyDown" })).toBe(true);
    expect(inputCancelsHandoff({ type: "keyUp" })).toBe(false);
  });

  it("the main process validates adoptions and wires keyboard input to the panel", () => {
    const panel = source("src/main/panel.ts");
    expect(panel).toMatch(/onAdopt\(webContentsId: number, title: string\): void \{[\s\S]*?acceptAdoption\(/);
    expect(panel).toMatch(/onWhatsAppInput\(webContentsId: number/);
    expect(panel).toMatch(/wc\.on\("did-navigate", \(\) => \{[\s\S]*?this\.pendingHandoff\.committed = true/);
    expect(source("src/main/main.ts")).toMatch(/if \(kind === "whatsapp"\) panel\?\.onWhatsAppInput\(wc\.id, input\)/);
  });
});

describe("update signatures (§12 signed updates)", () => {
  const signed = "provider: generic\nurl: https://downloads.twchartered.com/desktop\npublisherName: TaxWise Consultants\nupdaterCacheDirName: taxwise-desktop-updater\n";
  const signedList = "provider: generic\npublisherName:\n  - TaxWise Consultants\n  - 'TaxWise Consultants LLP'\nupdaterCacheDirName: x\n";
  const unsigned = "provider: generic\nurl: https://downloads.twchartered.com/desktop\nupdaterCacheDirName: taxwise-desktop-updater\n";

  it("reads the publisher names electron-builder writes", () => {
    expect(publisherNames(signed)).toEqual(["TaxWise Consultants"]);
    expect(publisherNames(signedList)).toEqual(["TaxWise Consultants", "TaxWise Consultants LLP"]);
    expect(publisherNames("publisherName: [A, 'B']\n")).toEqual(["A", "B"]);
    expect(publisherNames(unsigned)).toEqual([]);
    expect(publisherNames("publisherName: null\n")).toEqual([]);
    expect(publisherNames("publisherName:\nurl: x\n")).toEqual([]);
  });

  it("an unsigned Windows build doesn't auto-update (electron-updater would skip the signature check)", () => {
    expect(updateTrustProblem("win32", signed)).toBeNull();
    expect(updateTrustProblem("win32", signedList)).toBeNull();
    expect(updateTrustProblem("win32", unsigned)).toMatch(/code-signed/);
    expect(updateTrustProblem("win32", null)).not.toBeNull();
    expect(updateTrustProblem("darwin", null)).toBeNull(); // Squirrel.Mac checks the Developer ID itself
    expect(updateTrustProblem("linux", signed)).not.toBeNull();
  });

  it("startUpdater never checks when updates can't be trusted", async () => {
    let checks = 0;
    const logs: string[] = [];
    const updater = { autoDownload: false, autoInstallOnAppQuit: false, checkForUpdatesAndNotify: async () => void checks++, on: () => undefined };
    const u = startUpdater({ updater, isPackaged: true, trustProblem: "unsigned", log: (m) => void logs.push(m), setInterval: () => 1, clearInterval: () => undefined });
    await u.checkNow();
    await Promise.resolve();
    expect(checks).toBe(0);
    expect(updater.autoDownload).toBe(false);
    expect(logs).toContain("updater: off");
  });

  it("the release script refuses to publish an unsigned build", () => {
    const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.release).toMatch(/forceCodeSigning=true/);
  });
});

describe("every view is built the one safe way (§7.25.3 security checklist)", () => {
  const files = ["src/main/main.ts", "src/main/panel.ts"];
  it("each WebContentsView takes its preferences from secureWebPreferences, and nothing else makes a page", () => {
    let views = 0;
    for (const f of files) {
      const text = source(f);
      const made = text.match(/new WebContentsView\(\{\s*webPreferences: secureWebPreferences\(/g) ?? [];
      const all = text.match(/new WebContentsView\(/g) ?? [];
      expect(made.length, f).toBe(all.length);
      views += all.length;
      expect(text, f).not.toMatch(/new BrowserWindow\(|new BrowserView\(|webviewTag:\s*true|nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/);
    }
    expect(views).toBe(3); // CRM, panel header, one per WhatsApp number
  });

  it("every view gets the navigation, frame, window-open and input guards", () => {
    const main = source("src/main/main.ts");
    for (const hook of ['wc.on("will-navigate"', 'wc.on("will-redirect"', 'wc.on("will-frame-navigate"', "wc.setWindowOpenHandler(", 'wc.on("before-input-event"']) {
      expect(main, hook).toContain(hook);
    }
    expect(main).toMatch(/wc\.on\("will-attach-webview", \(e\) => e\.preventDefault\(\)\)/);
    expect(source("src/main/panel.ts")).toContain('this.d.guardWebContents("whatsapp", wc)');
  });
});
